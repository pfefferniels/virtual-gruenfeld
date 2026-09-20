/**
 * The lesson, while it is happening.
 *
 * Drives the four layers of `LIVE.md` §2 — track, score, deliberate, commit — over whatever the
 * student has played so far. Everything that touches the world is injected: the clock, the
 * scoring, the decision and the playing. That is what lets the same loop run against a virtual
 * clock in `scripts/simulate-lesson.ts` and against Web MIDI in the browser, and it is the only
 * reason the policy could be calibrated before the instrument arrived.
 *
 * The loop never blocks on the decision. A verdict is requested when a bar closes and acted on
 * whenever it lands and the student's hands are off the keys, which may be seconds later or never.
 */
import type { StudentNote } from '../matcher';
import type { Position, Tracker } from '../tracker';
import { createVerdictStore, LIVE_POLICY, type Policy, type VerdictStore } from './standingVerdict';

const PPQ = 720;
const BAR = 4 * PPQ;

export type WindowPolicy = {
    /** Trailing window a verdict is formed over. Two bars clears every floor in `LIVE.md` §1. */
    readonly windowBars: number;
    /**
     * How far behind the playhead the window ends.
     *
     * A bar judged the moment its last onset arrives is judged on whichever notes happen to have
     * finished sounding: an identity take scored six notes of bar 5 and read itself 4.4 bpm slow.
     */
    readonly settleTicks: number;
    /** Tracking confidence below which no verdict is asked for: a lost student is not a bad one. */
    readonly minConfidence: number;
};

const DEFAULT_WINDOW: WindowPolicy = {
    windowBars: 2,
    settleTicks: BAR / 2,
    minConfidence: 0.6,
};

export type Window = { readonly from: number; readonly to: number };

/** What scoring a window produced. Shaped by `mpm/evidence.ts`, narrowed to what the loop reads. */
export type WindowEvidence = {
    readonly measuredTypes: readonly string[];
    readonly structuredDiff: readonly Record<string, unknown>[];
};

export type Decision<TPlan> = {
    readonly verdict: { interrupt: number; dimension: string; severity: number; exaggeration: number } | null;
    readonly plan: TPlan | null;
};

export type LiveLessonDeps<TPlan> = {
    readonly tracker: Tracker;
    /**
     * Score a window, off the main thread. Returns null when the fit could not answer for it.
     * Measured 42–74 ms warm in the worker, which is why nothing waits on it synchronously.
     */
    readonly score: (played: readonly StudentNote[], window: Window) => Promise<WindowEvidence | null>;
    /** Ask what Grünfeld makes of it. Never throws: a missing verdict is silence, not an error. */
    readonly deliberate: (request: DeliberationRequest) => Promise<Decision<TPlan>>;
    /** Take the keyboard. */
    readonly play: (plan: TPlan, fragment: Window) => void;
};

export type DeliberationRequest = {
    readonly window: Window;
    readonly position: Position;
    readonly handsOffKeys: boolean;
    readonly measuredTypes: readonly string[];
    readonly structuredDiff: readonly Record<string, unknown>[];
    readonly alreadyCorrectedThisLesson: readonly { bar: number; dimension: string; times: number }[];
};

export type Heard = {
    readonly position: Position | null;
    /** A verdict was asked for on this call. */
    readonly asked: boolean;
    /** Grünfeld took the keyboard on this call. */
    readonly played: { readonly fragment: Window; readonly bar: number } | null;
};

const SILENT: Heard = { position: null, asked: false, played: null };

export const tickToBar = (tick: number): number => Math.floor(tick / BAR) + 1;

export type LiveLesson = {
    /**
     * Everything played so far, and the time now. Safe to call as often as the caller likes: a
     * window is scored once, and a verdict is requested once per window.
     */
    heard(played: readonly StudentNote[], nowMs: number): Promise<Heard>;
    /**
     * The student starts the passage again. Position and scored windows go; what he has already
     * corrected stays, because that is what stops him making the same point on every attempt.
     */
    newAttempt(): void;
    corrections(): readonly { bar: number; dimension: string; times: number }[];
};

export const createLiveLesson = <TPlan>(
    deps: LiveLessonDeps<TPlan>,
    policy: { window?: Partial<WindowPolicy>; verdict?: Policy } = {},
): LiveLesson => {
    const window = { ...DEFAULT_WINDOW, ...policy.window };
    const verdictPolicy = policy.verdict ?? LIVE_POLICY;
    const store: VerdictStore<TPlan> = createVerdictStore<TPlan>(verdictPolicy);

    let lastScoredTo = -1;
    let inFlight = false;

    /** The window is quantised to the bar grid so the reference-fit memo can hit it. */
    const windowFor = (tick: number): Window | null => {
        const to = Math.floor((tick - window.settleTicks) / BAR) * BAR;
        const from = Math.max(0, to - window.windowBars * BAR);
        return to - from >= BAR ? { from, to } : null;
    };

    return {
        async heard(played, nowMs) {
            const position = deps.tracker.advance(played);
            if (position === null) return SILENT;

            const msSinceLastNote = played.length === 0
                ? Number.POSITIVE_INFINITY
                : nowMs - Math.max(...played.map((note) => note.onset * 1000));

            const bounds = windowFor(position.tick);
            const fresh = bounds !== null && bounds.to > lastScoredTo;
            let asked = false;

            if (fresh && !inFlight && position.confidence >= window.minConfidence) {
                lastScoredTo = bounds.to;
                const evidence = await deps.score(played, bounds);
                const persistent = store.observe(evidence?.measuredTypes ?? []);

                if (evidence !== null && persistent.length > 0) {
                    asked = true;
                    inFlight = true;
                    const requestedAt = nowMs;
                    try {
                        const decision = await deps.deliberate({
                            window: bounds,
                            position,
                            handsOffKeys: msSinceLastNote >= verdictPolicy.silenceMs,
                            measuredTypes: persistent,
                            structuredDiff: evidence.structuredDiff,
                            alreadyCorrectedThisLesson: store.corrections(),
                        });
                        if (decision.verdict !== null && decision.plan !== null) {
                            store.record({
                                verdict: decision.verdict,
                                plan: decision.plan,
                                range: bounds,
                                landedAtMs: requestedAt,
                            });
                        }
                    } finally {
                        inFlight = false;
                    }
                }
            }

            const due = store.due(nowMs, msSinceLastNote);
            if (due === null) return { position, asked, played: null };

            // He plays a fragment, not the window he judged: "a great deal during the lesson in a
            // fragmentary way, but rarely anything straight through" (Hullah on Leschetizky, 1906).
            const fragment = { from: Math.max(0, due.range.to - BAR), to: due.range.to };
            const bar = tickToBar(fragment.from);
            deps.play(due.plan, fragment);
            store.committed(due, nowMs, bar);
            return { position, asked, played: { fragment, bar } };
        },

        newAttempt() {
            deps.tracker.reset();
            lastScoredTo = -1;
        },

        corrections: () => store.corrections(),
    };
};
