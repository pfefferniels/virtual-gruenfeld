/**
 * The live lesson, without the piano.
 *
 * A synthetic student plays into the real pipeline — the real matcher, the real fit, the real
 * audibility gate, the real Jev — against a virtual clock, so a nineteen-second passage costs a
 * second of wall time. Jev is called for real and its measured latency is placed back onto the
 * virtual timeline, so a verdict requested at bar 6 arrives where 367 ms of network actually puts
 * it. What comes out is a transcript of when Grünfeld would have taken the keyboard, about what,
 * and how hard.
 *
 * The point is to have the interruption policy already tuned when the Disklavier arrives.
 *
 *   npx tsx scripts/simulate-lesson.ts                 every scenario
 *   npx tsx scripts/simulate-lesson.ts identity rush   named scenarios
 *   DRY_RUN=1 npx tsx scripts/simulate-lesson.ts       no Jev; the local gate alone
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { performMsmToData } from 'espressivo';
import { implantLocal } from '../client/src/matcher';
import { evidenceForTake, forgetReferenceFits } from '../client/src/mpm/evidence';
import { measuredNotesFromPerformanceData, withoutUnisons } from '../client/src/score/measured';
import { perform } from '../client/src/services/mpmRenderer';
import { buildSmfFromMessages } from '../client/src/smf';
import { read as readMidi } from 'midifile-ts';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'public');
const load = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');

const PPQ = 720;
const BAR = 4 * PPQ;

// ---------------------------------------------------------------------------
//  The policy under test
// ---------------------------------------------------------------------------

const POLICY = {
    /** Re-run the tracker this often, in virtual milliseconds. */
    trackEveryMs: 250,
    /** Trailing window the verdict is formed over. Two bars clears every floor in LIVE.md §1. */
    windowBars: Number(process.env.WINDOW_BARS ?? 2),
    /** How far behind the playhead the window ends, so the bars in it have finished sounding. */
    settleTicks: BAR / 2,
    /** Hands off the keys for this long is a place he may come in. */
    silenceMs: 1200,
    /**
     * Schmitt trigger. Calibrated against real evidence, not against the model's raw scale:
     * measured over this pipeline, human unevenness and a 15 % rush both top out at 0.51, while
     * a 25 % rush, a 30 % drag and a 60 % dynamics departure all clear 0.52. The dead band is
     * wider than the ±0.05 jitter Jev shows on identical input.
     */
    fireAbove: Number(process.env.FIRE_ABOVE ?? 0.52),
    releaseBelow: Number(process.env.RELEASE_BELOW ?? 0.45),
    /** He does not come in again inside this, however wrong the playing. */
    refractoryMs: 8000,
    /** A verdict older than this is stale — the student has moved on. */
    verdictTtlMs: 6000,
    /** Abandon a Jev call that has not answered. p99 measured at 883 ms. */
    /**
     * Abandon a call that has not answered.
     *
     * Production wants 900 ms, which covers the p99 of a warm connection. This simulation cannot
     * hold one — it spends seconds of CPU between verdicts, so undici drops the socket and every
     * call pays a TLS handshake: measured 2.1–2.4 s cold against 0.5–0.7 s warm. The server must
     * keep the connection alive; until then this number is about the harness, not the policy.
     */
    abandonMs: Number(process.env.ABANDON_MS ?? 4000),
    /** Only these are identifiable in a short window (LIVE.md §1). */
    liveDimensions: ['tempo', 'dynamics'] as const,
    /**
     * Consecutive windows a dimension must survive before it may be acted on.
     *
     * Human unevenness and a reading are close in magnitude — measured, 13.05 JND for ordinary
     * jitter against 23.87 for a deliberate 15 % rush — but they differ in kind: noise moves
     * about, a reading persists. One window cannot tell them apart and two can.
     */
    persistenceWindows: 2,
};

// ---------------------------------------------------------------------------
//  Students
// ---------------------------------------------------------------------------

type Mutation = (mpm: string) => string;

const within = (element: string, attrs: readonly string[], factor: number): Mutation =>
    (mpm) =>
        mpm.replace(new RegExp(`<${element}\\b[^>]*>`, 'g'), (found) =>
            found.replace(
                new RegExp(`\\b(${attrs.join('|')})="([\\d.-]+)"`, 'g'),
                (_, attr, value) => `${attr}="${Number(value) * factor}"`,
            ));

const rush = (factor: number) => within('tempo', ['bpm', 'transition.to'], factor);
const loud = (factor: number) => within('dynamics', ['volume', 'transition.to'], factor);
const compose = (...mutations: Mutation[]): Mutation => (mpm) => mutations.reduce((text, m) => m(text), mpm);
const asPlayed: Mutation = (mpm) => mpm;

/** Human timing and touch. Real pianists are not sequencers. */
type Humanize = { onsetSdMs: number; velocitySd: number };

/** What the student does to the stream after it is rendered: stop, restart, drop notes. */
type StreamEdit = (notes: PlayedNote[]) => PlayedNote[];

type Scenario = {
    name: string;
    what: string;
    /** One entry per attempt. A lesson is several attempts at the same passage. */
    attempts: readonly { mutate: Mutation; edit?: StreamEdit }[];
    range: { from: number; to: number };
    humanize?: Humanize;
    expect: string;
};

type PlayedNote = { pitch: number; onsetMs: number; durationMs: number; velocity: number };

// ---------------------------------------------------------------------------
//  Rendering a student into a stream of played notes
// ---------------------------------------------------------------------------

let rng = 1;
/** mulberry32 — deterministic, so a scenario replays identically between runs. */
const random = () => {
    rng = (rng + 0x6D2B79F5) | 0;
    let t = Math.imul(rng ^ (rng >>> 15), 1 | rng);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gaussian = (sd: number) => {
    const [u, v] = [Math.max(random(), 1e-9), random()];
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sd;
};

const playedNotesOf = (
    mei: string,
    mpm: string,
    range: { from: number; to: number },
    humanize: Humanize | undefined,
): PlayedNote[] => {
    const midi = perform(mei, mpm, range);
    if (!midi) throw new Error('nothing rendered');
    const notes: PlayedNote[] = [];
    const tpb = midi.header.ticksPerBeat;
    let usPQ = 500_000;
    for (const track of midi.tracks) {
        let tick = 0;
        const held = new Map<number, { onsetMs: number; velocity: number }>();
        for (const event of track) {
            const e = event as unknown as Record<string, number | string>;
            tick += (e.deltaTime as number) ?? 0;
            if (e.type === 'meta' && e.subtype === 'setTempo') usPQ = e.microsecondsPerBeat as number;
            const ms = (tick / tpb) * (usPQ / 1000);
            if (e.type !== 'channel') continue;
            const pitch = e.noteNumber as number;
            if (e.subtype === 'noteOn' && (e.velocity as number) > 0) {
                held.set(pitch, { onsetMs: ms, velocity: e.velocity as number });
            } else if (e.subtype === 'noteOff' || (e.subtype === 'noteOn' && e.velocity === 0)) {
                const on = held.get(pitch);
                if (!on) continue;
                notes.push({ pitch, onsetMs: on.onsetMs, durationMs: Math.max(10, ms - on.onsetMs), velocity: on.velocity });
                held.delete(pitch);
            }
        }
    }
    const jittered = humanize
        ? notes.map((n) => ({
            ...n,
            onsetMs: Math.max(0, n.onsetMs + gaussian(humanize.onsetSdMs)),
            velocity: Math.max(1, Math.min(127, Math.round(n.velocity + gaussian(humanize.velocitySd)))),
        }))
        : notes;
    return [...jittered].sort((a, b) => a.onsetMs - b.onsetMs);
};

/** Stop mid-phrase, sit for a moment, then pick up again a bar earlier. */
const stopAndRestart = (atMs: number, sitMs: number, backMs: number): StreamEdit => (notes) => {
    const before = notes.filter((n) => n.onsetMs < atMs);
    const resumeFrom = atMs - backMs;
    const after = notes
        .filter((n) => n.onsetMs >= resumeFrom)
        .map((n) => ({ ...n, onsetMs: n.onsetMs + sitMs + (atMs - resumeFrom) }));
    return [...before, ...after].sort((a, b) => a.onsetMs - b.onsetMs);
};

/** Drop a proportion of notes, as a nervous student does. */
const dropNotes = (fraction: number): StreamEdit => (notes) =>
    notes.filter(() => random() > fraction);

// ---------------------------------------------------------------------------
//  Jev
// ---------------------------------------------------------------------------

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-1.13.0';
const apiKey = process.env.TYPESAFE_API_KEY;
const DRY_RUN = process.env.DRY_RUN === '1' || !apiKey;

type Verdict = {
    interrupt: number;
    dimension: string;
    severity: number;
    exaggeration: number;
    latencyMs: number;
    inputTokens: number;
};

const QUESTIONS = {
    interrupt: {
        type: 'noul',
        instructions:
            'Should Grünfeld break in now, take the keyboard, and play this passage himself? He teaches by playing, '
            + 'comes in often and early, and plays fragments rather than whole passages. He does not make the same point twice.',
        criteria: {
            true: 'Something departs audibly from his reading and is better heard than described.',
            false: 'The playing is within his idea, the departure is inaudible, or he has just made this point.',
        },
    },
    dimension: {
        type: 'choice',
        instructions: 'What is the demonstration about?',
        criteria: {
            tempo: 'The pace of the passage.',
            dynamics: 'Weight, and the balance between melody and inner voices.',
            none: 'Nothing here is worth demonstrating.',
        },
    },
    severity: {
        type: 'score',
        instructions: 'How far is this playing from Grünfeld’s idea of the passage?',
        criteria: [
            'Indistinguishable from his own reading.',
            'Within what he would let pass without comment.',
            'Audibly different, worth a remark but not a demonstration.',
            'Clearly against his reading; he would stop and play it.',
            'Contrary to the whole sense of the passage.',
        ],
    },
    exaggeration: {
        type: 'score',
        instructions: 'How far should he push the demonstration away from the student, so the contrast is heard without caricature?',
        criteria: [
            'Play it straight, no exaggeration.',
            'Slightly beyond his own reading.',
            'Clearly beyond it, so the difference cannot be missed.',
            'As far as taste allows.',
        ],
    },
};

const seenFailures = new Set<string>();

const askJev = async (state: unknown): Promise<Verdict | null> => {
    const started = performance.now();
    const controller = new AbortController();
    const abandon = setTimeout(() => controller.abort(), POLICY.abandonMs);
    try {
        const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ state, model: MODEL, questions: QUESTIONS }),
            signal: controller.signal,
        });
        const body = await response.json();
        if (!response.ok) throw new Error(`HTTP ${response.status} ${JSON.stringify(body).slice(0, 300)}`);
        return {
            interrupt: body.answers.interrupt.noul,
            dimension: body.answers.dimension.choice,
            severity: body.answers.severity.score,
            exaggeration: body.answers.exaggeration.score,
            latencyMs: performance.now() - started,
            inputTokens: body.usage?.input_tokens ?? 0,
        };
    } catch (error) {
        // Abandoned, or refused. The lesson goes on without a verdict either way, but the two
        // must be distinguishable or a broken request reads as a slow one.
        const why = error instanceof Error && error.name === 'AbortError'
            ? `abandoned after ${POLICY.abandonMs}ms`
            : `refused: ${error instanceof Error ? error.message : String(error)}`;
        if (process.env.TRACE === '1' || !seenFailures.has(why)) console.log(`      [jev] ${why}`);
        seenFailures.add(why);
        return null;
    } finally {
        clearTimeout(abandon);
    }
};

// ---------------------------------------------------------------------------
//  The loop
// ---------------------------------------------------------------------------

const mei = load('score.mei');
const scoreMsm = load('score.msm');
const referenceMpmText = load('performance.mpm');
const scoreNotes = withoutUnisons(
    measuredNotesFromPerformanceData(performMsmToData({ msm: scoreMsm, mpm: referenceMpmText }, { expandOrnaments: false })),
);

const tickToBar = (tick: number) => Math.floor(tick / BAR) + 1;

type Interruption = {
    atMs: number;
    bar: number;
    dimension: string;
    severity: number;
    exaggeration: number;
    interrupt: number;
    demoTicks: number;
    waitedMs: number;
};

type AttemptResult = {
    interruptions: Interruption[];
    verdicts: number;
    abandoned: number;
    latencies: number[];
    tokens: number;
    notes: number;
    lastMs: number;
};

const midiFromPlayed = (notes: readonly PlayedNote[]) => {
    const messages = notes
        .flatMap((n) => [
            { tMs: n.onsetMs, data: new Uint8Array([0x90, n.pitch, n.velocity]) },
            { tMs: n.onsetMs + n.durationMs, data: new Uint8Array([0x80, n.pitch, 0]) },
        ])
        .sort((a, b) => a.tMs - b.tMs);
    return readMidi(buildSmfFromMessages(messages, { ticksPerQuarter: 480, bpm: 120 }));
};

const runAttempt = async (
    played: readonly PlayedNote[],
    corrected: { bar: number; dimension: string; times: number }[],
    scenario: Scenario,
): Promise<AttemptResult> => {
    const result: AttemptResult = {
        interruptions: [], verdicts: 0, abandoned: 0, latencies: [], tokens: 0,
        notes: played.length, lastMs: played.length ? played[played.length - 1].onsetMs : 0,
    };
    if (played.length === 0) return result;

    /** The standing verdict: what Jev last said, and when it landed. */
    let standing: (Verdict & { landedAtMs: number; bar: number; ticks: { from: number; to: number } }) | null = null;
    let inFlight: Promise<void> | null = null;
    let armed = false; // Schmitt trigger state
    let lastInterruptionMs = -Infinity;
    let lastScoredBar = 0;
    /** Consecutive windows each dimension has been measured in. */
    const streak = new Map<string, number>();

    const endMs = result.lastMs + POLICY.silenceMs + 500;

    for (let now = POLICY.trackEveryMs; now <= endMs; now += POLICY.trackEveryMs) {
        // A note is heard when it is struck, not when it is released. Waiting for note-off drops
        // still-sounding notes out of the window, and the fit reads the gap as a deviation.
        const heard = played
            .filter((n) => n.onsetMs <= now)
            .map((n) => ({ ...n, durationMs: Math.min(n.durationMs, Math.max(10, now - n.onsetMs)) }));
        if (heard.length < 4) continue;

        // --- track: where is the student, on the real matcher -------------------
        const prefix = midiFromPlayed(heard);
        const hint = standing ? (standing.ticks.from + standing.ticks.to) / 2 : undefined;
        const { range } = implantLocal(scoreNotes, prefix, hint);
        const bar = tickToBar(range.to);

        // --- score: one verdict per completed bar -------------------------------
        // The window ends a settling margin behind the playhead. A bar judged the moment its last
        // onset arrives is judged on the notes that happen to have finished sounding: an identity
        // take scored six notes of bar 5 and read itself 4.4 bpm slow, 17.27 JND, three events.
        // Half a bar later the same window is silent.
        const windowTicks = POLICY.windowBars * BAR;
        const to = Math.min(scenario.range.to, Math.floor((range.to - POLICY.settleTicks) / BAR) * BAR);
        const from = Math.max(scenario.range.from, to - windowTicks);

        if (bar > lastScoredBar && to - from >= BAR && inFlight === null) {
            lastScoredBar = bar;
            // The verdict is formed only from notes that have finished sounding, so a truncated
            // duration never reaches the fit.
            const windowed = played.filter((n) => n.onsetMs + n.durationMs <= now);
            const evidence = (() => {
                try {
                    forgetReferenceFits();
                    return evidenceForTake({
                        notes: implantLocal(scoreNotes, midiFromPlayed(windowed), (from + to) / 2).notes,
                        range: { from, to },
                        scoreMsm,
                        scoreNotes,
                        referenceMpmText,
                    });
                } catch {
                    return null;
                }
            })();

            const measured = ((evidence as { measuredTypes?: readonly string[] } | null)?.measuredTypes ?? [])
                .filter((t) => (POLICY.liveDimensions as readonly string[]).includes(t));
            const diff = (evidence as { structuredDiff?: readonly Record<string, unknown>[] } | null)?.structuredDiff ?? [];

            if (process.env.TRACE === '1') {
                const jnd = (evidence as { aggregateJnd?: number } | null)?.aggregateJnd;
                console.log(
                    `      [trace] t=${(now / 1000).toFixed(1)}s  matched=${range.from}..${range.to}`
                    + `  window=${from}..${to}  notes=${windowed.length}`
                    + `  types=[${((evidence as { measuredTypes?: readonly string[] } | null)?.measuredTypes ?? []).join(',')}]`
                    + `  jnd=${jnd?.toFixed(2) ?? '—'}  events=${diff.length}`,
                );
                diff.slice(0, 3).forEach((e) => console.log(`              ${JSON.stringify(e)}`));
            }

            measured.forEach((type) => streak.set(type, (streak.get(type) ?? 0) + 1));
            [...streak.keys()]
                .filter((type) => !measured.includes(type))
                .forEach((type) => streak.delete(type));
            const persistent = measured.filter((type) => (streak.get(type) ?? 0) >= POLICY.persistenceWindows);

            if (persistent.length > 0) {
                const requestedAt = now;
                const state = {
                    piece: 'Robert Schumann, Träumerei op. 15 nr. 7',
                    reading:
                        'Alfred Grünfeld, Welte-Mignon roll 1905. Unhurried, long phrases, the inner voices under the melody. '
                        + 'He does not push the tempo and releases tension only at the cadence.',
                    position: `bar ${bar}`,
                    bars_measured: `${tickToBar(from)}–${tickToBar(to)}`,
                    persisting_dimensions: persistent,
                    hands_off_keys: false,
                    already_corrected_this_lesson: corrected,
                    deviations: diff
                        .filter((event) => (POLICY.liveDimensions as readonly string[]).includes(String(event.type)))
                        .slice(0, 8)
                        .map((event) => ({
                            at: event.position,
                            dimension: event.type,
                            attribute: event.primaryAttr,
                            severity: event.severity,
                            direction: event.direction,
                            cue: event.cueText,
                            gruenfeld: event.refValue,
                            student: event.studentValue,
                        })),
                };

                if (DRY_RUN) {
                    // Stands in for Jev so the commit path can be exercised without the network:
                    // the local gate opened, so assume he would come in.
                    standing = {
                        interrupt: 0.8, dimension: measured[0], severity: 3, exaggeration: 1.5,
                        latencyMs: 370, inputTokens: 0,
                        landedAtMs: requestedAt + 370, bar, ticks: { from, to },
                    };
                    result.verdicts += 1;
                } else {
                    inFlight = askJev(state).then((verdict) => {
                        inFlight = null;
                        if (!verdict) { result.abandoned += 1; return; }
                        result.verdicts += 1;
                        result.latencies.push(verdict.latencyMs);
                        result.tokens += verdict.inputTokens;
                        // The verdict lands where its real latency puts it on the virtual clock.
                        standing = { ...verdict, landedAtMs: requestedAt + verdict.latencyMs, bar, ticks: { from, to } };
                        if (process.env.TRACE === '1') {
                            console.log(
                                `      [jev] interrupt=${verdict.interrupt.toFixed(2)} dim=${verdict.dimension}`
                                + ` sev=${verdict.severity.toFixed(2)} exag=${verdict.exaggeration.toFixed(2)}`
                                + ` (${verdict.latencyMs.toFixed(0)}ms, ${verdict.inputTokens} tok)`,
                            );
                        }
                    });
                    await inFlight;
                }
            }
        }

        // --- commit: the local rule, no network on this path --------------------
        const fresh = standing !== null
            && standing.landedAtMs <= now
            && now - standing.landedAtMs <= POLICY.verdictTtlMs;
        if (!fresh) continue;

        armed = armed ? standing!.interrupt > POLICY.releaseBelow : standing!.interrupt > POLICY.fireAbove;
        if (!armed) continue;
        if (now - lastInterruptionMs < POLICY.refractoryMs) continue;
        if (standing!.dimension === 'none') continue;

        const sinceLastNote = now - Math.max(...heard.map((n) => n.onsetMs));
        const handsOff = sinceLastNote >= POLICY.silenceMs;
        const atNoteBoundary = played.some((n) => Math.abs(n.onsetMs - now) < POLICY.trackEveryMs);
        if (!handsOff && !atNoteBoundary) continue;

        // He plays a fragment: the bar that carries the point.
        const demoFrom = Math.max(scenario.range.from, standing!.ticks.to - BAR);
        const demoTo = standing!.ticks.to;
        result.interruptions.push({
            atMs: now,
            bar: tickToBar(demoFrom),
            dimension: standing!.dimension,
            severity: standing!.severity,
            exaggeration: standing!.exaggeration,
            interrupt: standing!.interrupt,
            demoTicks: demoTo - demoFrom,
            waitedMs: now - standing!.landedAtMs,
        });
        corrected.push({ bar: tickToBar(demoFrom), dimension: standing!.dimension, times: 1 });
        lastInterruptionMs = now;
        armed = false;
        standing = null;
    }
    return result;
};

// ---------------------------------------------------------------------------
//  Scenarios
// ---------------------------------------------------------------------------

/** Bars 5–12: a phrase, not a fragment, so a window has room to grow. */
const PASSAGE = { from: 4 * BAR, to: 12 * BAR };
const HUMAN: Humanize = { onsetSdMs: 25, velocitySd: 4 };

const SCENARIOS: Scenario[] = [
    {
        name: 'identity',
        what: 'plays the reconstruction back exactly',
        attempts: [{ mutate: asPlayed }],
        range: PASSAGE,
        expect: 'silence — nothing at all',
    },
    {
        name: 'human-tight',
        what: 'plays it exactly, with a fine player’s jitter (10 ms, 2 vel)',
        attempts: [{ mutate: asPlayed }],
        range: PASSAGE,
        humanize: { onsetSdMs: 10, velocitySd: 2 },
        expect: 'silence',
    },
    {
        name: 'human',
        what: 'plays it well, with ordinary human timing and touch (25 ms, 4 vel)',
        attempts: [{ mutate: asPlayed }],
        range: PASSAGE,
        humanize: HUMAN,
        expect: 'silence, or at most one remark',
    },
    {
        name: 'human-loose',
        what: 'plays it unevenly, as an amateur does (45 ms, 8 vel)',
        attempts: [{ mutate: asPlayed }],
        range: PASSAGE,
        humanize: { onsetSdMs: 45, velocitySd: 8 },
        expect: 'unevenness is not a reading — he should be slow to call it one',
    },
    {
        name: 'rush',
        what: 'rushes throughout, 15% fast',
        attempts: [{ mutate: rush(1.15) }],
        range: PASSAGE,
        humanize: HUMAN,
        expect: 'comes in on tempo, once or twice, not constantly',
    },
    {
        name: 'rush-25',
        what: 'rushes 25%',
        attempts: [{ mutate: rush(1.25) }],
        range: PASSAGE,
        humanize: HUMAN,
        expect: 'where does tempo become audible to him?',
    },
    {
        name: 'rush-40',
        what: 'rushes 40%',
        attempts: [{ mutate: rush(1.4) }],
        range: PASSAGE,
        humanize: HUMAN,
        expect: 'plainly against the reading',
    },
    {
        name: 'drag-30',
        what: 'drags, 30% slow',
        attempts: [{ mutate: rush(0.7) }],
        range: PASSAGE,
        humanize: HUMAN,
        expect: 'slowness is a departure too',
    },
    {
        name: 'loud',
        what: 'plays 60% louder, flat dynamics',
        attempts: [{ mutate: loud(1.6) }],
        range: PASSAGE,
        humanize: HUMAN,
        expect: 'comes in on dynamics',
    },
    {
        name: 'both',
        what: 'rushes and bangs at once',
        attempts: [{ mutate: compose(rush(1.2), loud(1.5)) }],
        range: PASSAGE,
        humanize: HUMAN,
        expect: 'picks one dimension, does not fire twice for the same passage',
    },
    {
        name: 'persistent',
        what: 'four attempts, rushing the same way every time',
        attempts: Array.from({ length: 4 }, () => ({ mutate: rush(1.18) })),
        range: PASSAGE,
        humanize: HUMAN,
        expect: 'interrupts early, then less — suppression must show across attempts',
    },
    {
        name: 'improving',
        what: 'rushes badly, then less, then plays it',
        attempts: [{ mutate: rush(1.3) }, { mutate: rush(1.15) }, { mutate: asPlayed }],
        range: PASSAGE,
        humanize: HUMAN,
        expect: 'interrupts, then less, then falls silent',
    },
    {
        name: 'breakdown',
        what: 'stops mid-phrase, sits, restarts a bar earlier',
        attempts: [{ mutate: asPlayed, edit: stopAndRestart(9000, 2500, 4000) }],
        range: PASSAGE,
        humanize: HUMAN,
        expect: 'does not mistake a restart for an error; the pause is a place he may come in',
    },
    {
        name: 'nervous',
        what: 'drops one note in twelve',
        attempts: [{ mutate: asPlayed, edit: dropNotes(1 / 12) }],
        range: PASSAGE,
        humanize: HUMAN,
        expect: 'missing notes are not an expressive deviation — he should stay quiet',
    },
];

// ---------------------------------------------------------------------------
//  Run
// ---------------------------------------------------------------------------

const ms = (n: number) => `${(n / 1000).toFixed(1)}s`;

const runScenario = async (scenario: Scenario) => {
    rng = 20260920;
    console.log(`\n${scenario.name}  —  ${scenario.what}`);
    console.log(`   expected: ${scenario.expect}`);

    const corrected: { bar: number; dimension: string; times: number }[] = [];
    const all: AttemptResult[] = [];

    for (const [index, attempt] of scenario.attempts.entries()) {
        const rendered = playedNotesOf(mei, attempt.mutate(referenceMpmText), scenario.range, scenario.humanize);
        const played = attempt.edit ? attempt.edit(rendered) : rendered;
        const result = await runAttempt(played, corrected, scenario);
        all.push(result);

        const label = scenario.attempts.length > 1 ? `   attempt ${index + 1}` : '   ';
        if (result.interruptions.length === 0) {
            console.log(`${label.padEnd(14)} ${String(result.notes).padStart(3)} notes, ${ms(result.lastMs).padStart(6)}  →  silence`);
        } else {
            console.log(`${label.padEnd(14)} ${String(result.notes).padStart(3)} notes, ${ms(result.lastMs).padStart(6)}  →  ${result.interruptions.length} interruption(s)`);
            result.interruptions.forEach((i) =>
                console.log(
                    `                    ${ms(i.atMs).padStart(6)}  bar ${String(i.bar).padStart(2)}  ${i.dimension.padEnd(9)}`
                    + ` p=${i.interrupt.toFixed(2)}  sev=${i.severity.toFixed(1)}  exag=${i.exaggeration.toFixed(1)}`
                    + `  plays ${(i.demoTicks / BAR).toFixed(1)} bar  (waited ${i.waitedMs.toFixed(0)}ms)`,
                ));
        }
    }

    const latencies = all.flatMap((r) => r.latencies).sort((a, b) => a - b);
    const totals = {
        interruptions: all.reduce((n, r) => n + r.interruptions.length, 0),
        verdicts: all.reduce((n, r) => n + r.verdicts, 0),
        abandoned: all.reduce((n, r) => n + r.abandoned, 0),
        tokens: all.reduce((n, r) => n + r.tokens, 0),
    };
    console.log(
        `   ${totals.interruptions} interruption(s) over ${scenario.attempts.length} attempt(s); `
        + `${totals.verdicts} verdict(s)${totals.abandoned ? `, ${totals.abandoned} abandoned` : ''}`
        + (latencies.length ? `, jev p50 ${latencies[latencies.length >> 1].toFixed(0)}ms` : '')
        + (totals.tokens ? `, ${(totals.tokens * 0.042 / 1e6).toFixed(4)} $` : ''),
    );
    return { scenario, totals };
};

const main = async () => {
    const wanted = process.argv.slice(2);
    const chosen = wanted.length ? SCENARIOS.filter((s) => wanted.includes(s.name)) : SCENARIOS;
    if (chosen.length === 0) {
        console.error(`no such scenario. known: ${SCENARIOS.map((s) => s.name).join(', ')}`);
        process.exit(1);
    }
    console.log(
        `Simulated lesson — ${DRY_RUN ? 'DRY RUN, local gate only' : `live ${MODEL}`}, virtual clock, real matcher and fit\n`
        + `policy: window ${POLICY.windowBars} bars, fire>${POLICY.fireAbove} release<${POLICY.releaseBelow}, `
        + `refractory ${POLICY.refractoryMs / 1000}s, ttl ${POLICY.verdictTtlMs / 1000}s, dims ${POLICY.liveDimensions.join('+')}`,
    );

    const results = [];
    for (const scenario of chosen) results.push(await runScenario(scenario));

    console.log('\n── summary ──');
    results.forEach(({ scenario, totals }) =>
        console.log(`   ${scenario.name.padEnd(12)} ${String(totals.interruptions).padStart(2)} interruption(s)   ${scenario.expect}`));
};

main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
});
