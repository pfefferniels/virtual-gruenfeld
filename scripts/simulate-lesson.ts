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
 *   TRACE=1 …  what each window measured      TRACE=loop …  what the loop did with it
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
import { decide, planFrom, startHeartbeat, type Verdict as JevVerdict } from '../src/jev';
import { deviationsFrom } from '../client/src/services/decide';
import type { DecisionState } from '../src/jev/state';
import { LIVE_POLICY } from '../client/src/pipeline/standingVerdict';
import { createLiveLesson, type LiveLesson } from '../client/src/pipeline/liveLesson';
import { createTracker } from '../client/src/tracker';
import { isLiveDimension } from '../src/jev';
import type { LessonPlan } from '../src/plan';
import type { StudentNote } from '../client/src/matcher';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'public');
const load = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');

const PPQ = 720;
const BAR = 4 * PPQ;

// ---------------------------------------------------------------------------
//  The policy under test
// ---------------------------------------------------------------------------

/**
 * What belongs to the harness. Everything about *whether and when* Grünfeld comes in lives in
 * `client/src/pipeline/standingVerdict.ts` and is exercised here rather than reimplemented.
 */
const POLICY = {
    /** Re-run the tracker this often, in virtual milliseconds. */
    trackEveryMs: 250,
    /** Trailing window the verdict is formed over. Two bars clears every floor in LIVE.md §1. */
    windowBars: Number(process.env.WINDOW_BARS ?? 2),
    /**
     * How far behind the playhead the window ends.
     *
     * A bar judged the moment its last onset arrives is judged on whichever notes happen to have
     * finished sounding: an identity take scored six notes of bar 5 and read itself 4.4 bpm slow,
     * 17.27 JND, three events. Half a bar later the same window is silent.
     */
    settleTicks: BAR / 2,
    /** Only these are identifiable in a short window (LIVE.md §1). */
    liveDimensions: ['tempo', 'dynamics'] as const,
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

const apiKey = process.env.TYPESAFE_API_KEY;
const DRY_RUN = process.env.DRY_RUN === '1' || !apiKey;

/**
 * The server holds a warm socket and answers in 0.5–0.7 s, so it budgets 1200 ms. This harness
 * cannot: it spends seconds of CPU between verdicts, the connection drops, and every call pays a
 * TLS handshake at 2.1–2.4 s. The heartbeat below helps but cannot fire during a synchronous fit,
 * so the budget is widened here. This number is about the harness, not the policy.
 */
process.env.JEV_ABANDON_MS ??= '4000';

const seenFailures = new Set<string>();

/**
 * The shipped call, so this exercises what runs rather than a copy of it. The questions, the
 * state shape, the abandon timer and the mapping onto a lesson plan all live in `src/jev/`.
 */
const askJev = async (state: DecisionState): Promise<(JevVerdict & { latencyMs: number }) | null> => {
    const outcome = await decide(state);
    if (outcome.ok) return outcome.verdict;

    const why = `${outcome.reason}: ${outcome.detail}`;
    if (process.env.TRACE === '1' || !seenFailures.has(why)) console.log(`      [jev] ${why}`);
    seenFailures.add(why);
    return null;
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
    mode: string;
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

const midiFromPlayed = (notes: readonly { pitch: number; onsetMs: number; durationMs: number; velocity: number }[]) => {
    const messages = notes
        .flatMap((n) => [
            { tMs: n.onsetMs, data: new Uint8Array([0x90, n.pitch, n.velocity]) },
            { tMs: n.onsetMs + n.durationMs, data: new Uint8Array([0x80, n.pitch, 0]) },
        ])
        .sort((a, b) => a.tMs - b.tMs);
    return readMidi(buildSmfFromMessages(messages, { ticksPerQuarter: 480, bpm: 120 }));
};

/** What the student has struck by `nowMs`, with any still-sounding note truncated to now. */
const heardBy = (played: readonly PlayedNote[], nowMs: number): StudentNote[] =>
    played
        .filter((note) => note.onsetMs <= nowMs)
        .map((note, index) => ({
            id: `s${index}`,
            pitch: note.pitch,
            onset: note.onsetMs / 1000,
            duration: Math.max(0.01, Math.min(note.durationMs, nowMs - note.onsetMs)) / 1000,
            velocity: note.velocity,
        }));

/** The scoring side of the loop: the real fit and the real audibility gate, over one window. */
const scoreWindow = (played: readonly StudentNote[], window: { from: number; to: number }) => {
    try {
        forgetReferenceFits();
        const asMidi = midiFromPlayed(played.map((note) => ({
            pitch: note.pitch,
            onsetMs: note.onset * 1000,
            durationMs: note.duration * 1000,
            velocity: note.velocity,
        })));
        const evidence = evidenceForTake({
            notes: implantLocal(scoreNotes, asMidi, (window.from + window.to) / 2).notes,
            range: window,
            scoreMsm,
            scoreNotes,
            referenceMpmText,
        }) as { measuredTypes?: readonly string[]; structuredDiff?: readonly Record<string, unknown>[]; aggregateJnd?: number };

        const measured = (evidence.measuredTypes ?? []).filter(isLiveDimension);
        const diff = evidence.structuredDiff ?? [];
        if (process.env.TRACE === '1') {
            console.log(
                `      [trace] window=${window.from}..${window.to} notes=${played.length}`
                + ` types=[${(evidence.measuredTypes ?? []).join(',')}]`
                + ` jnd=${evidence.aggregateJnd?.toFixed(2) ?? '—'} events=${diff.length}`,
            );
        }
        return { measuredTypes: measured, structuredDiff: diff };
    } catch {
        return null;
    }
};

/** One attempt, driven entirely through the shipped loop. */
/** The virtual clock, read by `play()` so the transcript can say when he came in. */
let lastNowMs = 0;
let lastVerdict: (JevVerdict & { latencyMs: number }) | null = null;

const runAttempt = async (
    played: readonly PlayedNote[],
    lesson: LiveLesson,
    result: AttemptResult,
): Promise<AttemptResult> => {
    if (played.length === 0) return result;
    lesson.newAttempt();

    const endMs = result.lastMs + LIVE_POLICY.silenceMs + 500;
    for (let now = POLICY.trackEveryMs; now <= endMs; now += POLICY.trackEveryMs) {
        lastNowMs = now;
        const heard = heardBy(played, now);
        if (heard.length < 4) continue;
        const outcome = await lesson.heard(heard, now);
        if (process.env.TRACE === 'loop') {
            const since = now - Math.max(...heard.map((n) => n.onset * 1000));
            console.log(`      [loop] t=${(now/1000).toFixed(1)}s pos=${outcome.position?.tick ?? 'null'}`
                + ` conf=${outcome.position?.confidence.toFixed(2) ?? '—'} asked=${outcome.asked}`
                + ` sinceNote=${since.toFixed(0)}ms played=${outcome.played ? 'YES' : 'no'}`);
        }
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

    const all: AttemptResult[] = [];
    let current: AttemptResult | null = null;

    // One lesson across every attempt: what he corrected on the first is still remembered on the
    // fourth, which is what makes him stop making the same point.
    const lesson = createLiveLesson<LessonPlan>({
        tracker: createTracker(scoreNotes),
        score: scoreWindow,
        deliberate: async (request) => {
            if (DRY_RUN) {
                // Stands in for Jev so the commit path runs without the network.
                current!.verdicts += 1;
                const verdict = {
                    interrupt: 0.8, dimension: request.measuredTypes[0], severity: 3, exaggeration: 1.5,
                    mode: 'exaggerated', confidence: { dimension: 1, severity: 1 }, latencyMs: 370, inputTokens: 0,
                };
                lastVerdict = verdict;
                return {
                    verdict,
                    plan: planFrom(verdict, { range: request.window, measuredTypes: request.measuredTypes }).plan,
                };
            }
            const verdict = await askJev({
                position: `bar ${tickToBar(request.window.to)}`,
                barsMeasured: `${tickToBar(request.window.from)}–${tickToBar(request.window.to)}`,
                handsOffKeys: request.handsOffKeys,
                alreadyCorrectedThisLesson: request.alreadyCorrectedThisLesson,
                deviations: deviationsFrom(request.structuredDiff),
            });
            if (!verdict) {
                current!.abandoned += 1;
                return { verdict: null, plan: null };
            }
            current!.verdicts += 1;
            current!.latencies.push(verdict.latencyMs);
            current!.tokens += verdict.inputTokens;
            if (process.env.TRACE === '1') {
                console.log(
                    `      [jev] interrupt=${verdict.interrupt.toFixed(2)} dim=${verdict.dimension}`
                    + ` sev=${verdict.severity.toFixed(2)} exag=${verdict.exaggeration.toFixed(2)}`
                    + ` mode=${verdict.mode} (${verdict.latencyMs.toFixed(0)}ms, ${verdict.inputTokens} tok)`,
                );
            }
            lastVerdict = verdict;
            // The real mapping, clamping and all: the simulator exercises what the route runs.
            return {
                verdict,
                plan: planFrom(verdict, { range: request.window, measuredTypes: request.measuredTypes }).plan,
            };
        },
        play: (plan, fragment) => {
            current!.interruptions.push({
                atMs: lastNowMs,
                bar: tickToBar(fragment.from),
                dimension: lastVerdict?.dimension ?? 'tempo',
                severity: lastVerdict?.severity ?? 0,
                exaggeration: lastVerdict?.exaggeration ?? 0,
                interrupt: lastVerdict?.interrupt ?? 0.8,
                demoTicks: fragment.to - fragment.from,
                mode: plan.mode,
            });
        },
    });

    for (const [index, attempt] of scenario.attempts.entries()) {
        const rendered = playedNotesOf(mei, attempt.mutate(referenceMpmText), scenario.range, scenario.humanize);
        const played = attempt.edit ? attempt.edit(rendered) : rendered;
        current = {
            interruptions: [], verdicts: 0, abandoned: 0, latencies: [], tokens: 0,
            notes: played.length, lastMs: played.length ? played[played.length - 1].onsetMs : 0,
        };
        const result = await runAttempt(played, lesson, current);
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
                    + `  ${i.mode} ${(i.demoTicks / BAR).toFixed(1)} bar`,
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
        `Simulated lesson — ${DRY_RUN ? 'DRY RUN, local gate only' : `live ${process.env.JEV_MODEL ?? 'jev-1.13.0'}`}, virtual clock, real matcher and fit\n`
        + `policy: window ${POLICY.windowBars} bars, fire>${LIVE_POLICY.fireAbove} release<${LIVE_POLICY.releaseBelow}, `
        + `refractory ${LIVE_POLICY.refractoryMs / 1000}s, ttl ${LIVE_POLICY.ttlMs / 1000}s, dims ${POLICY.liveDimensions.join('+')}`,
    );

    if (!DRY_RUN) startHeartbeat();

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
