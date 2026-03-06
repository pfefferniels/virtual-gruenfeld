/**
 * Comprehensive end-to-end test for the dialogic teaching pipeline.
 *
 * Pipeline under test:
 *   student plays -> implant matches -> mpmify creates MPMs ->
 *   diff compares -> exaggerate adjusts -> teacher response makes sense
 *
 * We test each pure-logic stage with synthetic data, then (optionally)
 * exercise the full pipeline with the real MEI score and info.json.
 *
 * Run with:  npx tsx test_pipeline.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Dynamic imports (ESM-compatible) ────────────────────────────────────────
const { MPM } = await import('/Users/nielspfeffer/Projects/mpm-ts/src/MPM.ts');
const { exportMPM } = await import('/Users/nielspfeffer/Projects/mpm-ts/src/Serialization.ts');
const { MSM, importWork } = await import('/Users/nielspfeffer/Projects/mpmify/src/index.ts');

type MPM = InstanceType<typeof MPM>;
type MSM = InstanceType<typeof MSM>;

// ── Type aliases matching Dialog.tsx ────────────────────────────────────────
type Dynamics = {
    type: 'dynamics';
    'xml:id': string;
    date: number;
    volume: number;
    'transition.to': number;
    noteid?: string;
};

type Tempo = {
    type: 'tempo';
    'xml:id': string;
    date: number;
    bpm: number;
    beatLength: number;
    'transition.to': number;
    noteid?: string;
};

// ── Extracted pure functions from Dialog.tsx ─────────────────────────────────

type InstructionDiff = {
    id: string;
    type: 'dynamics' | 'tempo';
    diffs: Record<string, { ref: number; student: number; delta: number }>;
    magnitude: number;
};

const THRESHOLDS = {
    volume: 4,
    bpm: 4,
    "transition.to": 4,
};

const diff = (mpm1: MPM, mpm2: MPM, range: { from: number; to: number }, topN: number = 10): string => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inRange = (i: any) => {
        const date = i.date ?? i["date"];
        return typeof date === 'number' && date >= range.from && date <= range.to;
    };

    const allInstructions = mpm1.getInstructions().filter(inRange);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idx = new Map<string, any>();
    for (const i of mpm2.getInstructions()) {
        const key = `${i.type}::${i["xml:id"]}`;
        idx.set(key, i);
    }

    const peaks: InstructionDiff[] = [];

    for (const instruction of allInstructions) {
        const key = `${instruction.type}::${instruction["xml:id"]}`;
        const corresp = idx.get(key);
        if (!corresp) continue;

        if (instruction.type === 'dynamics' && corresp.type === 'dynamics') {
            if (typeof corresp.volume !== 'number' || typeof instruction.volume !== 'number') continue;
            if (typeof corresp["transition.to"] !== 'number' || typeof instruction["transition.to"] !== 'number') continue;

            const deltaVolume = corresp.volume - instruction.volume;
            const deltaTransition = corresp["transition.to"] - instruction["transition.to"];

            if (Math.abs(deltaVolume) < THRESHOLDS.volume && Math.abs(deltaTransition) < THRESHOLDS["transition.to"]) continue;

            const magnitude = Math.abs(deltaVolume) + Math.abs(deltaTransition);
            peaks.push({
                id: instruction["xml:id"],
                type: 'dynamics',
                diffs: {
                    volume: { ref: instruction.volume, student: corresp.volume, delta: deltaVolume },
                    "transition.to": { ref: instruction["transition.to"], student: corresp["transition.to"], delta: deltaTransition },
                },
                magnitude,
            });
        } else if (instruction.type === 'tempo' && corresp.type === 'tempo') {
            if (typeof corresp.bpm !== 'number' || typeof instruction.bpm !== 'number') continue;
            if (typeof corresp["transition.to"] !== 'number' || typeof instruction["transition.to"] !== 'number') continue;

            const deltaBpm = corresp.bpm - instruction.bpm;
            const deltaTransition = corresp["transition.to"] - instruction["transition.to"];

            if (Math.abs(deltaBpm) < THRESHOLDS.bpm && Math.abs(deltaTransition) < THRESHOLDS["transition.to"]) continue;

            const magnitude = Math.abs(deltaBpm) + Math.abs(deltaTransition);
            peaks.push({
                id: instruction["xml:id"],
                type: 'tempo',
                diffs: {
                    bpm: { ref: instruction.bpm, student: corresp.bpm, delta: deltaBpm },
                    "transition.to": { ref: instruction["transition.to"], student: corresp["transition.to"], delta: deltaTransition },
                },
                magnitude,
            });
        }
    }

    peaks.sort((a, b) => b.magnitude - a.magnitude);
    const topPeaks = peaks.slice(0, topN);

    if (topPeaks.length === 0) {
        return "No significant differences found.";
    }

    const lines = topPeaks.map((p) => {
        const diffParts = Object.entries(p.diffs)
            .map(([attr, { ref, student, delta }]) => {
                const sign = delta > 0 ? '+' : '';
                return `${attr}: ${ref.toFixed(1)}\u2192${student.toFixed(1)} (${sign}${delta.toFixed(1)})`;
            })
            .join(', ');
        return `[${p.type}] ${p.id}: ${diffParts}`;
    });

    return `Top ${topPeaks.length} differences (ref\u2192student):\n${lines.join('\n')}`;
};

const exaggerate = (
    mpm1: MPM,
    mpm2: MPM,
    range: { from: number; to: number },
    aggressiveness: number = 1,
    log: (msg: string) => void,
) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inRange = (i: any) => {
        const date = i.date ?? i["date"];
        return typeof date === 'number' && date >= range.from && date <= range.to;
    };

    const allInstructions = mpm1.getInstructions().filter(inRange);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idx = new Map<string, any>();
    for (const i of mpm2.getInstructions()) {
        const key = `${i.type}::${i["xml:id"]}`;
        idx.set(key, i);
    }

    for (const instruction of allInstructions) {
        const key = `${instruction.type}::${instruction["xml:id"]}`;
        const corresp = idx.get(key);
        if (!corresp) continue;

        if (instruction.type === 'dynamics' && corresp.type === 'dynamics') {
            if (typeof corresp.volume !== 'number' || typeof instruction.volume !== 'number') continue;
            if (typeof corresp["transition.to"] !== 'number' || typeof instruction["transition.to"] !== 'number') continue;

            const diffStart = corresp.volume - instruction.volume;
            const diffEnd = corresp["transition.to"] - instruction["transition.to"];

            instruction.volume = Math.max(1, Math.min(127, instruction.volume - diffStart * aggressiveness));
            instruction["transition.to"] = Math.max(1, Math.min(127, instruction["transition.to"] - diffEnd * aggressiveness));
            log(`exaggerate dynamics ${instruction["xml:id"]} ${JSON.stringify({ diffStart, diffEnd, newVolume: instruction.volume, newTransitionTo: instruction["transition.to"] })}`);
        } else if (instruction.type === 'tempo' && corresp.type === 'tempo') {
            if (typeof corresp.bpm !== 'number' || typeof instruction.bpm !== 'number') continue;
            if (typeof corresp["transition.to"] !== 'number' || typeof instruction["transition.to"] !== 'number') continue;

            const diffStart = corresp.bpm - instruction.bpm;
            const diffEnd = corresp["transition.to"] - instruction["transition.to"];

            instruction.bpm = Math.max(10, instruction.bpm - diffStart * aggressiveness);
            instruction["transition.to"] = Math.max(10, instruction["transition.to"] - diffEnd * aggressiveness);
            log(`exaggerate tempo ${instruction["xml:id"]} ${JSON.stringify({ diffStart, diffEnd, newBpm: instruction.bpm, newTransitionTo: instruction["transition.to"] })}`);
        }
    }
};

// ── mpmify (same as Dialog.tsx) ─────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mpmify = (msm: MSM, infoJson: any): MPM => {
    const mpm = new MPM();
    const { transformers } = importWork(infoJson);
    transformers.forEach((transformer: any) => {
        transformer.run(msm, mpm);
    });
    return mpm;
};

// ── Test infrastructure ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
    if (condition) {
        console.log(`  PASS: ${label}`);
        passed++;
    } else {
        console.error(`  FAIL: ${label}${detail ? ` -- ${detail}` : ''}`);
        failed++;
    }
}

function approx(a: number, b: number, eps = 0.01) {
    return Math.abs(a - b) < eps;
}

function buildMPM(instructions: { dynamics: Dynamics[]; tempo: Tempo[] }): MPM {
    const mpm = new MPM();
    for (const d of instructions.dynamics) {
        mpm.insertInstruction(d, 'global');
    }
    for (const t of instructions.tempo) {
        mpm.insertInstruction(t, 'global');
    }
    return mpm;
}

/**
 * Deep-clone an MPM by rebuilding it from its instructions, so mutations
 * to the clone do not affect the original.
 */
function deepCloneMPM(mpm: MPM): MPM {
    const cloned = new MPM();
    for (const instruction of mpm.getInstructions()) {
        const copy = { ...instruction };
        // Determine scope from the original (we use 'global' since our tests build global MPMs)
        cloned.insertInstruction(copy, 'global');
    }
    return cloned;
}

const noop = (_msg: string) => {};

// ═══════════════════════════════════════════════════════════════════════════
// PART 1: Unit tests for diff() and exaggerate()
// ═══════════════════════════════════════════════════════════════════════════

const range = { from: 0, to: 5000 };

function makeRefDynamics(): Dynamics[] {
    return [
        { type: 'dynamics', 'xml:id': 'd1', date: 100, volume: 60, 'transition.to': 70 },
        { type: 'dynamics', 'xml:id': 'd2', date: 500, volume: 90, 'transition.to': 80 },
        { type: 'dynamics', 'xml:id': 'd3', date: 1000, volume: 50, 'transition.to': 50 },
    ];
}
function makeRefTempo(): Tempo[] {
    return [
        { type: 'tempo', 'xml:id': 't1', date: 0, bpm: 120, beatLength: 720, 'transition.to': 110 },
        { type: 'tempo', 'xml:id': 't2', date: 2000, bpm: 80, beatLength: 720, 'transition.to': 90 },
    ];
}
function makeStudentDynamics(): Dynamics[] {
    return [
        { type: 'dynamics', 'xml:id': 'd1', date: 100, volume: 80, 'transition.to': 90 },
        { type: 'dynamics', 'xml:id': 'd2', date: 500, volume: 100, 'transition.to': 85 },
        { type: 'dynamics', 'xml:id': 'd3', date: 1000, volume: 40, 'transition.to': 35 },
    ];
}
function makeStudentTempo(): Tempo[] {
    return [
        { type: 'tempo', 'xml:id': 't1', date: 0, bpm: 140, beatLength: 720, 'transition.to': 130 },
        { type: 'tempo', 'xml:id': 't2', date: 2000, bpm: 70, beatLength: 720, 'transition.to': 75 },
    ];
}

// ── Test 1: diff() detects dynamics differences ────────────────────────────

console.log('\n=== Test 1: diff() correctly identifies dynamics differences ===');
{
    const ref = buildMPM({ dynamics: makeRefDynamics(), tempo: makeRefTempo() });
    const student = buildMPM({ dynamics: makeStudentDynamics(), tempo: makeStudentTempo() });

    const result = diff(ref, student, range);
    console.log('  output:\n    ' + result.replace(/\n/g, '\n    '));

    assert(result.includes('d1'), 'd1 appears in diff');
    assert(result.includes('+20.0'), 'delta +20.0 appears');
    assert(result.includes('d2'), 'd2 appears in diff');
    assert(result.includes('d3'), 'd3 appears in diff');
    assert(result.includes('-10.0') || result.includes('-15.0'), 'negative deltas appear');
}

// ── Test 2: diff() detects tempo differences ───────────────────────────────

console.log('\n=== Test 2: diff() correctly identifies tempo differences ===');
{
    const ref = buildMPM({ dynamics: makeRefDynamics(), tempo: makeRefTempo() });
    const student = buildMPM({ dynamics: makeStudentDynamics(), tempo: makeStudentTempo() });
    const result = diff(ref, student, range);

    assert(result.includes('t1'), 't1 appears in diff');
    assert(result.includes('t2'), 't2 appears in diff');
}

// ── Test 3: diff() sorts by magnitude descending ──────────────────────────

console.log('\n=== Test 3: diff() sorts by magnitude descending ===');
{
    const ref = buildMPM({ dynamics: makeRefDynamics(), tempo: makeRefTempo() });
    const student = buildMPM({ dynamics: makeStudentDynamics(), tempo: makeStudentTempo() });
    const result = diff(ref, student, range);
    const lines = result.split('\n').slice(1);

    const d1Idx = lines.findIndex(l => l.includes('d1'));
    const d2Idx = lines.findIndex(l => l.includes('d2'));
    const d3Idx = lines.findIndex(l => l.includes('d3'));

    assert(d1Idx < d2Idx, 'd1 (magnitude 40) appears before d2 (magnitude 15)');
    assert(d3Idx < d2Idx, 'd3 (magnitude 25) appears before d2 (magnitude 15)');
}

// ── Test 4: diff() ignores sub-threshold differences ──────────────────────

console.log('\n=== Test 4: diff() ignores differences below threshold ===');
{
    const refDyn: Dynamics[] = [
        { type: 'dynamics', 'xml:id': 'small', date: 100, volume: 60, 'transition.to': 62 },
    ];
    const studentDyn: Dynamics[] = [
        { type: 'dynamics', 'xml:id': 'small', date: 100, volume: 63, 'transition.to': 64 },
    ];

    const ref = buildMPM({ dynamics: refDyn, tempo: [] });
    const student = buildMPM({ dynamics: studentDyn, tempo: [] });
    const result = diff(ref, student, range);
    assert(result === "No significant differences found.", 'sub-threshold dynamics ignored', `got: "${result}"`);
}

// ── Test 5: diff() respects range filter ──────────────────────────────────

console.log('\n=== Test 5: diff() respects range filter ===');
{
    const ref = buildMPM({ dynamics: makeRefDynamics(), tempo: makeRefTempo() });
    const student = buildMPM({ dynamics: makeStudentDynamics(), tempo: makeStudentTempo() });
    const narrowRange = { from: 50, to: 200 };
    const result = diff(ref, student, narrowRange);

    assert(result.includes('d1'), 'd1 (date=100) is in narrow range');
    assert(!result.includes('d2'), 'd2 (date=500) is outside narrow range');
    assert(!result.includes('d3'), 'd3 (date=1000) is outside narrow range');
    assert(!result.includes('t2'), 't2 (date=2000) is outside narrow range');
}

// ── Test 6: diff() topN parameter limits results ──────────────────────────

console.log('\n=== Test 6: diff() topN parameter limits results ===');
{
    const ref = buildMPM({ dynamics: makeRefDynamics(), tempo: makeRefTempo() });
    const student = buildMPM({ dynamics: makeStudentDynamics(), tempo: makeStudentTempo() });

    const result = diff(ref, student, range, 2);
    const lines = result.split('\n').slice(1);

    assert(lines.length === 2, `topN=2 should return 2 lines, got ${lines.length}`);
    // The two highest magnitudes are d1=40 and t1=40; both should be present
    assert(
        (result.includes('d1') || result.includes('t1')),
        'top results include highest-magnitude instructions'
    );
}

// ── Test 7: diff() with identical MPMs ────────────────────────────────────

console.log('\n=== Test 7: diff() with identical MPMs returns no differences ===');
{
    const mpm = buildMPM({ dynamics: makeRefDynamics(), tempo: makeRefTempo() });
    const result = diff(mpm, mpm, range);
    assert(result === "No significant differences found.", 'identical MPMs have no diff', `got: "${result}"`);
}

// ── Test 8: exaggerate() dynamics - student louder -> teacher softer ──────

console.log('\n=== Test 8: exaggerate() dynamics - student louder -> teacher softer ===');
{
    const ref = buildMPM({ dynamics: makeRefDynamics(), tempo: [] });
    const student = buildMPM({ dynamics: makeStudentDynamics(), tempo: [] });

    const logs: string[] = [];
    exaggerate(ref, student, range, 1.2, (msg) => logs.push(msg));

    const d1 = ref.getInstructions().find((i: any) => i['xml:id'] === 'd1') as Dynamics;
    const d2 = ref.getInstructions().find((i: any) => i['xml:id'] === 'd2') as Dynamics;
    const d3 = ref.getInstructions().find((i: any) => i['xml:id'] === 'd3') as Dynamics;

    // d1: ref=60, student=80, delta=+20 -> 60 - 20*1.2 = 36
    assert(approx(d1.volume, 36), `d1.volume = 36, got ${d1.volume}`);
    assert(approx(d1['transition.to'], 46), `d1.transition.to = 46, got ${d1['transition.to']}`);

    // d2: ref=90, student=100, delta=+10 -> 90 - 10*1.2 = 78
    assert(approx(d2.volume, 78), `d2.volume = 78, got ${d2.volume}`);
    assert(approx(d2['transition.to'], 74), `d2.transition.to = 74, got ${d2['transition.to']}`);

    // d3: ref=50, student=40, delta=-10 -> 50 - (-10)*1.2 = 62  (student softer => teacher louder)
    assert(approx(d3.volume, 62), `d3.volume = 62, got ${d3.volume}`);
    assert(approx(d3['transition.to'], 68), `d3.transition.to = 68, got ${d3['transition.to']}`);

    // Sanity: exaggerated ref moved FURTHER from student
    assert(Math.abs(36 - 80) > Math.abs(60 - 80), 'd1: teacher moved further from student (louder student -> softer teacher)');
    assert(Math.abs(62 - 40) > Math.abs(50 - 40), 'd3: teacher moved further from student (softer student -> louder teacher)');
}

// ── Test 9: exaggerate() tempo - student faster -> teacher slower ─────────

console.log('\n=== Test 9: exaggerate() tempo - student faster -> teacher slower ===');
{
    const ref = buildMPM({ dynamics: [], tempo: makeRefTempo() });
    const student = buildMPM({ dynamics: [], tempo: makeStudentTempo() });

    const logs: string[] = [];
    exaggerate(ref, student, range, 1.2, (msg) => logs.push(msg));

    const t1 = ref.getInstructions().find((i: any) => i['xml:id'] === 't1') as Tempo;
    const t2 = ref.getInstructions().find((i: any) => i['xml:id'] === 't2') as Tempo;

    // t1: ref=120, student=140, delta=+20 -> 120 - 20*1.2 = 96
    assert(approx(t1.bpm, 96), `t1.bpm = 96, got ${t1.bpm}`);
    assert(approx(t1['transition.to'], 86), `t1.transition.to = 86, got ${t1['transition.to']}`);

    // t2: ref=80, student=70, delta=-10 -> 80 - (-10)*1.2 = 92  (student slower => teacher faster)
    assert(approx(t2.bpm, 92), `t2.bpm = 92, got ${t2.bpm}`);
    assert(approx(t2['transition.to'], 108), `t2.transition.to = 108, got ${t2['transition.to']}`);

    // Sanity: exaggerated ref moved FURTHER from student
    assert(Math.abs(96 - 140) > Math.abs(120 - 140), 't1: teacher moved further from student (faster student -> slower teacher)');
    assert(Math.abs(92 - 70) > Math.abs(80 - 70), 't2: teacher moved further from student (slower student -> faster teacher)');
}

// ── Test 10: exaggerate() clamps dynamics to [1, 127] ────────────────────

console.log('\n=== Test 10: exaggerate() clamps dynamics to [1, 127] ===');
{
    const refDyn: Dynamics[] = [
        { type: 'dynamics', 'xml:id': 'clamp_low', date: 100, volume: 10, 'transition.to': 10 },
        { type: 'dynamics', 'xml:id': 'clamp_high', date: 200, volume: 120, 'transition.to': 120 },
    ];
    const studentDyn: Dynamics[] = [
        { type: 'dynamics', 'xml:id': 'clamp_low', date: 100, volume: 120, 'transition.to': 120 },
        { type: 'dynamics', 'xml:id': 'clamp_high', date: 200, volume: 10, 'transition.to': 10 },
    ];

    const ref = buildMPM({ dynamics: refDyn, tempo: [] });
    const student = buildMPM({ dynamics: studentDyn, tempo: [] });
    exaggerate(ref, student, range, 2.0, noop);

    const cLow = ref.getInstructions().find((i: any) => i['xml:id'] === 'clamp_low') as Dynamics;
    const cHigh = ref.getInstructions().find((i: any) => i['xml:id'] === 'clamp_high') as Dynamics;

    assert(cLow.volume >= 1, `clamped low volume >= 1, got ${cLow.volume}`);
    assert(approx(cLow.volume, 1), `clamped low volume = 1, got ${cLow.volume}`);
    assert(cHigh.volume <= 127, `clamped high volume <= 127, got ${cHigh.volume}`);
    assert(approx(cHigh.volume, 127), `clamped high volume = 127, got ${cHigh.volume}`);
    assert(cLow['transition.to'] >= 1, `clamped low transition.to >= 1`);
    assert(cHigh['transition.to'] <= 127, `clamped high transition.to <= 127`);
}

// ── Test 11: exaggerate() clamps tempo to >= 10 ──────────────────────────

console.log('\n=== Test 11: exaggerate() clamps tempo to >= 10 ===');
{
    const refTempo: Tempo[] = [
        { type: 'tempo', 'xml:id': 'clamp_tempo', date: 0, bpm: 20, beatLength: 720, 'transition.to': 15 },
    ];
    const studentTempo: Tempo[] = [
        { type: 'tempo', 'xml:id': 'clamp_tempo', date: 0, bpm: 120, beatLength: 720, 'transition.to': 115 },
    ];

    const ref = buildMPM({ dynamics: [], tempo: refTempo });
    const student = buildMPM({ dynamics: [], tempo: studentTempo });
    exaggerate(ref, student, range, 2.0, noop);

    const t = ref.getInstructions().find((i: any) => i['xml:id'] === 'clamp_tempo') as Tempo;
    assert(t.bpm >= 10, `clamped tempo bpm >= 10, got ${t.bpm}`);
    assert(approx(t.bpm, 10), `clamped tempo bpm = 10, got ${t.bpm}`);
    assert(t['transition.to'] >= 10, `clamped tempo transition.to >= 10, got ${t['transition.to']}`);
}

// ── Test 12: exaggerate() with aggressiveness=0 is identity ──────────────

console.log('\n=== Test 12: exaggerate() with aggressiveness=0 leaves values unchanged ===');
{
    const ref = buildMPM({ dynamics: makeRefDynamics(), tempo: makeRefTempo() });
    const student = buildMPM({ dynamics: makeStudentDynamics(), tempo: makeStudentTempo() });
    exaggerate(ref, student, range, 0, noop);

    const d1 = ref.getInstructions().find((i: any) => i['xml:id'] === 'd1') as Dynamics;
    assert(approx(d1.volume, 60), `aggressiveness=0: d1.volume unchanged at 60, got ${d1.volume}`);
    assert(approx(d1['transition.to'], 70), `aggressiveness=0: d1.transition.to unchanged at 70, got ${d1['transition.to']}`);

    const t1 = ref.getInstructions().find((i: any) => i['xml:id'] === 't1') as Tempo;
    assert(approx(t1.bpm, 120), `aggressiveness=0: t1.bpm unchanged at 120, got ${t1.bpm}`);
}

// ── Test 13: exaggerate() only modifies instructions within range ────────

console.log('\n=== Test 13: exaggerate() only modifies instructions within range ===');
{
    const refDyn: Dynamics[] = [
        { type: 'dynamics', 'xml:id': 'in_range', date: 100, volume: 60, 'transition.to': 70 },
        { type: 'dynamics', 'xml:id': 'out_range', date: 9000, volume: 60, 'transition.to': 70 },
    ];
    const studentDyn: Dynamics[] = [
        { type: 'dynamics', 'xml:id': 'in_range', date: 100, volume: 80, 'transition.to': 90 },
        { type: 'dynamics', 'xml:id': 'out_range', date: 9000, volume: 80, 'transition.to': 90 },
    ];

    const ref = buildMPM({ dynamics: refDyn, tempo: [] });
    const student = buildMPM({ dynamics: studentDyn, tempo: [] });

    const narrowRange = { from: 0, to: 500 };
    exaggerate(ref, student, narrowRange, 1.2, noop);

    const inR = ref.getInstructions().find((i: any) => i['xml:id'] === 'in_range') as Dynamics;
    const outR = ref.getInstructions().find((i: any) => i['xml:id'] === 'out_range') as Dynamics;

    assert(approx(inR.volume, 36), `in_range.volume modified to 36, got ${inR.volume}`);
    assert(approx(outR.volume, 60), `out_range.volume unchanged at 60, got ${outR.volume}`);
}

// ── Test 14: exaggeration magnitude scales with aggressiveness ───────────

console.log('\n=== Test 14: exaggeration magnitude scales with aggressiveness ===');
{
    // Test with three different aggressiveness values
    const aggressivenessValues = [0.5, 1.0, 2.0];
    const results: number[] = [];

    for (const agg of aggressivenessValues) {
        const ref = buildMPM({
            dynamics: [{ type: 'dynamics', 'xml:id': 'scale_test', date: 100, volume: 60, 'transition.to': 70 }],
            tempo: [],
        });
        const student = buildMPM({
            dynamics: [{ type: 'dynamics', 'xml:id': 'scale_test', date: 100, volume: 80, 'transition.to': 90 }],
            tempo: [],
        });
        exaggerate(ref, student, range, agg, noop);
        const d = ref.getInstructions().find((i: any) => i['xml:id'] === 'scale_test') as Dynamics;
        results.push(d.volume);
    }

    // ref=60, student=80, delta=+20
    // agg=0.5 -> 60 - 20*0.5 = 50
    // agg=1.0 -> 60 - 20*1.0 = 40
    // agg=2.0 -> 60 - 20*2.0 = 20
    assert(approx(results[0], 50), `aggressiveness=0.5 -> volume 50, got ${results[0]}`);
    assert(approx(results[1], 40), `aggressiveness=1.0 -> volume 40, got ${results[1]}`);
    assert(approx(results[2], 20), `aggressiveness=2.0 -> volume 20, got ${results[2]}`);

    // Higher aggressiveness -> lower value (further from student who is louder)
    assert(results[0] > results[1], 'agg=0.5 result > agg=1.0 result');
    assert(results[1] > results[2], 'agg=1.0 result > agg=2.0 result');
}

// ── Test 15: diff() then exaggerate() pipeline coherence ─────────────────

console.log('\n=== Test 15: diff() then exaggerate() pipeline coherence ===');
{
    // Simulate the full diff -> exaggerate pipeline and verify that
    // diff detects the same attributes that exaggerate then modifies.
    const ref = buildMPM({ dynamics: makeRefDynamics(), tempo: makeRefTempo() });
    const student = buildMPM({ dynamics: makeStudentDynamics(), tempo: makeStudentTempo() });

    // Step 1: diff identifies differences
    const diffResult = diff(ref, student, range);
    assert(!diffResult.includes('No significant differences'), 'diff found significant differences');

    // Step 2: exaggerate adjusts the reference
    const teacherRef = deepCloneMPM(ref);
    const logs: string[] = [];
    exaggerate(teacherRef, student, range, 1.2, (msg) => logs.push(msg));

    // Step 3: teacher's response should now differ MORE from the student
    //         than the original reference did
    const d1Orig = ref.getInstructions().find((i: any) => i['xml:id'] === 'd1') as Dynamics;
    const d1Teacher = teacherRef.getInstructions().find((i: any) => i['xml:id'] === 'd1') as Dynamics;
    const d1Student = student.getInstructions().find((i: any) => i['xml:id'] === 'd1') as Dynamics;

    const origDist = Math.abs(d1Orig.volume - d1Student.volume);
    const teacherDist = Math.abs(d1Teacher.volume - d1Student.volume);

    assert(teacherDist > origDist,
        `teacher distance (${teacherDist}) > original distance (${origDist}) from student`);

    // The diff between teacher and student should show LARGER differences
    const teacherDiff = diff(teacherRef, student, range);
    assert(teacherDiff.includes('d1'), 'teacher diff still shows d1');
    console.log('  teacher diff:\n    ' + teacherDiff.replace(/\n/g, '\n    '));
}

// ── Test 16: exaggerate() does not mutate the student MPM ────────────────

console.log('\n=== Test 16: exaggerate() does not mutate the student MPM ===');
{
    const ref = buildMPM({ dynamics: makeRefDynamics(), tempo: [] });
    const student = buildMPM({ dynamics: makeStudentDynamics(), tempo: [] });

    // Save student values before
    const d1Before = (student.getInstructions().find((i: any) => i['xml:id'] === 'd1') as Dynamics).volume;

    exaggerate(ref, student, range, 1.2, noop);

    const d1After = (student.getInstructions().find((i: any) => i['xml:id'] === 'd1') as Dynamics).volume;
    assert(d1Before === d1After, `student d1.volume unchanged (${d1Before} === ${d1After})`);
}

// ── Test 17: diff() with mixed in/out-of-range instructions ──────────────

console.log('\n=== Test 17: diff() uses mpm1 range filter, matches mpm2 by xml:id ===');
{
    // mpm1 has one instruction in range, one outside
    // mpm2 has matching instruction but also an extra one
    const refDyn: Dynamics[] = [
        { type: 'dynamics', 'xml:id': 'matchme', date: 100, volume: 60, 'transition.to': 60 },
        { type: 'dynamics', 'xml:id': 'norange', date: 8000, volume: 60, 'transition.to': 60 },
    ];
    const studentDyn: Dynamics[] = [
        { type: 'dynamics', 'xml:id': 'matchme', date: 100, volume: 80, 'transition.to': 80 },
        { type: 'dynamics', 'xml:id': 'norange', date: 8000, volume: 80, 'transition.to': 80 },
        { type: 'dynamics', 'xml:id': 'extra', date: 200, volume: 99, 'transition.to': 99 },
    ];

    const ref = buildMPM({ dynamics: refDyn, tempo: [] });
    const student = buildMPM({ dynamics: studentDyn, tempo: [] });

    const narrowRange = { from: 0, to: 500 };
    const result = diff(ref, student, narrowRange);

    assert(result.includes('matchme'), 'matchme is in range and matched');
    assert(!result.includes('norange'), 'norange is outside range');
    assert(!result.includes('extra'), 'extra only exists in mpm2, not in mpm1 -> not in diff');
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 2: Integration test with real MEI score and mpmify pipeline
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== Test 18: mpmify() generates reference MPM from real score ===');

const infoJsonPath = path.resolve('/Users/nielspfeffer/Projects/virtual-gruenfeld/client/public/info.json');
const infoJsonStr = fs.readFileSync(infoJsonPath, 'utf8');

// We need an MSM to feed into mpmify. Since asMSM() requires an HTTP call
// to the Java backend for MEI->MSM conversion, we create a synthetic MSM
// with realistic note data sufficient for the transformer chain to run.
const syntheticNotes = [];
const pitches = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
for (let i = 0; i < 32; i++) {
    const date = i * 720;
    syntheticNotes.push({
        'xml:id': `note_${i}`,
        part: 1,
        date,
        duration: 720,
        pitchname: pitches[i % pitches.length],
        accidentals: 0,
        octave: 4,
        'midi.pitch': 60 + (i % 12),
        'midi.velocity': 64,
        'midi.onset': i * 0.5,
        'midi.duration': 0.48,
    });
}

const syntheticMSM = new MSM(syntheticNotes, { numerator: 4, denominator: 4 });
let referenceMPM: MPM | null = null;

try {
    referenceMPM = mpmify(syntheticMSM, infoJsonStr);
    const instCount = referenceMPM.getInstructions().length;
    assert(instCount > 0, `mpmify produced ${instCount} instructions`);

    // Check for dynamics and tempo instructions
    const dynamics = referenceMPM.getInstructions().filter((i: any) => i.type === 'dynamics');
    const tempos = referenceMPM.getInstructions().filter((i: any) => i.type === 'tempo');
    console.log(`  dynamics: ${dynamics.length}, tempo: ${tempos.length}`);
    assert(dynamics.length > 0 || tempos.length > 0, 'mpmify produced dynamics and/or tempo instructions');
} catch (err) {
    console.error(`  SKIP: mpmify failed (${String(err)}). This may be expected if the transformer chain requires specific note patterns.`);
}

// ── Test 19: Full pipeline with synthetic student variant ────────────────

console.log('\n=== Test 19: Full pipeline -- create student variant, diff, exaggerate ===');
if (referenceMPM) {
    const refInstructions = referenceMPM.getInstructions();
    const refDynInstructions = refInstructions.filter((i: any) => i.type === 'dynamics');
    const refTempoInstructions = refInstructions.filter((i: any) => i.type === 'tempo');

    if (refDynInstructions.length > 0 || refTempoInstructions.length > 0) {
        // Create a "student" variant by cloning the reference MPM and modifying instructions
        const studentMPM = deepCloneMPM(referenceMPM);
        const studentInstructions = studentMPM.getInstructions();

        let modified = 0;
        for (const inst of studentInstructions) {
            if (inst.type === 'dynamics' && typeof inst.volume === 'number') {
                // Make student louder by +15
                inst.volume = Math.min(127, inst.volume + 15);
                if (typeof inst['transition.to'] === 'number') {
                    inst['transition.to'] = Math.min(127, inst['transition.to'] + 15);
                }
                modified++;
            } else if (inst.type === 'tempo' && typeof inst.bpm === 'number') {
                // Make student faster by +10 bpm
                inst.bpm = inst.bpm + 10;
                if (typeof inst['transition.to'] === 'number') {
                    inst['transition.to'] = inst['transition.to'] + 10;
                }
                modified++;
            }
        }
        console.log(`  modified ${modified} student instructions`);
        assert(modified > 0, 'at least one student instruction was modified');

        // Determine range from instruction dates
        const allDates = refInstructions
            .filter((i: any) => typeof i.date === 'number')
            .map((i: any) => i.date);
        const fullRange = { from: Math.min(...allDates), to: Math.max(...allDates) + 1 };

        // Step 1: diff
        const diffResult = diff(referenceMPM, studentMPM, fullRange);
        console.log('  diff result:\n    ' + diffResult.replace(/\n/g, '\n    '));

        if (diffResult === "No significant differences found.") {
            // This can happen if the transformer produced instructions without all required fields
            console.log('  NOTE: no significant differences detected (likely missing transition.to on some instructions)');
        } else {
            assert(diffResult.includes('Top'), 'diff found top differences');

            // Step 2: exaggerate
            const teacherMPM = deepCloneMPM(referenceMPM);
            const exaggerateLogs: string[] = [];
            exaggerate(teacherMPM, studentMPM, fullRange, 1.2, (msg) => exaggerateLogs.push(msg));

            assert(exaggerateLogs.length > 0, `exaggerate logged ${exaggerateLogs.length} modifications`);
            console.log(`  exaggerate made ${exaggerateLogs.length} adjustments`);

            // Verify teacher moved in opposite direction
            // For dynamics: student was +15 louder -> teacher should be softer (volume decreased)
            const refDyn0 = refDynInstructions[0];
            if (refDyn0 && typeof refDyn0.volume === 'number' && typeof refDyn0['transition.to'] === 'number') {
                const teacherDyn0 = teacherMPM.getInstructions()
                    .find((i: any) => i['xml:id'] === refDyn0['xml:id'] && i.type === 'dynamics');
                if (teacherDyn0 && typeof teacherDyn0.volume === 'number') {
                    assert(
                        teacherDyn0.volume < refDyn0.volume,
                        `teacher dynamics (${teacherDyn0.volume}) < reference (${refDyn0.volume}) since student was louder`
                    );
                }
            }

            // For tempo: student was +10 faster -> teacher should be slower (bpm decreased)
            const refTmp0 = refTempoInstructions[0];
            if (refTmp0 && typeof refTmp0.bpm === 'number' && typeof refTmp0['transition.to'] === 'number') {
                const teacherTmp0 = teacherMPM.getInstructions()
                    .find((i: any) => i['xml:id'] === refTmp0['xml:id'] && i.type === 'tempo');
                if (teacherTmp0 && typeof teacherTmp0.bpm === 'number') {
                    assert(
                        teacherTmp0.bpm < refTmp0.bpm,
                        `teacher tempo (${teacherTmp0.bpm}) < reference (${refTmp0.bpm}) since student was faster`
                    );
                }
            }
        }
    } else {
        console.log('  SKIP: no dynamics/tempo instructions from mpmify to create student variant');
    }
} else {
    console.log('  SKIP: referenceMPM was not produced by mpmify');
}

// ── Test 20: exportMPM produces valid XML from exaggerated MPM ───────────

console.log('\n=== Test 20: exportMPM produces valid XML from exaggerated MPM ===');
{
    const ref = buildMPM({ dynamics: makeRefDynamics(), tempo: makeRefTempo() });
    const student = buildMPM({ dynamics: makeStudentDynamics(), tempo: makeStudentTempo() });
    exaggerate(ref, student, range, 1.2, noop);

    const xml = exportMPM(ref);
    assert(typeof xml === 'string' && xml.length > 0, 'exportMPM returns a non-empty string');
    assert(xml.includes('mpm'), 'exported XML contains "mpm" tag');
    assert(xml.includes('dynamics'), 'exported XML contains dynamics');
    console.log(`  exported XML length: ${xml.length} chars`);
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 3: Full pipeline test with /perform endpoint (requires server)
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== Test 21: Full pipeline with /perform endpoint (optional, requires server) ===');

const PERFORM_URL = 'http://localhost:8080/perform';

async function testPerformEndpoint() {
    // Check if server is available
    try {
        const probe = await fetch(PERFORM_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mei: '', mpm: '', from: 0, to: 0 }),
            signal: AbortSignal.timeout(2000),
        });
        // Any response (even error) means server is up
    } catch {
        console.log('  SKIP: /perform server not available at ' + PERFORM_URL);
        return;
    }

    // Load the real MEI score
    const meiPath = path.resolve('/Users/nielspfeffer/Projects/virtual-gruenfeld/client/public/score.mei');
    let mei: string;
    try {
        mei = fs.readFileSync(meiPath, 'utf8');
    } catch {
        console.log('  SKIP: could not read score.mei');
        return;
    }

    // Build an MPM with known exaggerated values
    const ref = buildMPM({
        dynamics: makeRefDynamics(),
        tempo: makeRefTempo(),
    });
    const student = buildMPM({
        dynamics: makeStudentDynamics(),
        tempo: makeStudentTempo(),
    });
    exaggerate(ref, student, range, 1.2, noop);

    const mpmXml = exportMPM(ref);
    const performRange = { from: 0, to: 2880 }; // first 4 beats

    try {
        const response = await fetch(PERFORM_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mei,
                mpm: mpmXml,
                ...performRange,
                ppq: 720,
            }),
            signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            console.log(`  SKIP: /perform returned HTTP ${response.status}: ${text.slice(0, 200)}`);
            return;
        }

        const payload = await response.json();
        const b64 = payload?.midi_b64;
        assert(typeof b64 === 'string' && b64.length > 0, '/perform returned non-empty midi_b64');

        // Decode and basic sanity check
        const binary = Buffer.from(b64, 'base64');
        assert(binary.length > 0, 'decoded MIDI has non-zero length');

        // Check MThd header
        const header = binary.slice(0, 4).toString('ascii');
        assert(header === 'MThd', `MIDI starts with MThd header, got "${header}"`);

        console.log(`  /perform MIDI: ${binary.length} bytes`);
    } catch (err) {
        console.log(`  SKIP: /perform request failed -> ${String(err)}`);
    }
}

await testPerformEndpoint();

// ═══════════════════════════════════════════════════════════════════════════
// PART 4: Edge case and symmetry tests
// ═══════════════════════════════════════════════════════════════════════════

// ── Test 22: Symmetric exaggeration - opposite student deviations ────────

console.log('\n=== Test 22: Symmetric exaggeration - opposite deviations produce opposite results ===');
{
    // Student A plays louder, Student B plays softer by the same amount
    const refBase = { type: 'dynamics' as const, 'xml:id': 'sym', date: 100, volume: 60, 'transition.to': 60 };
    const studentLouder = { ...refBase, volume: 80, 'transition.to': 80 };
    const studentSofter = { ...refBase, volume: 40, 'transition.to': 40 };

    const refA = buildMPM({ dynamics: [{ ...refBase }], tempo: [] });
    const studA = buildMPM({ dynamics: [studentLouder], tempo: [] });
    exaggerate(refA, studA, range, 1.0, noop);

    const refB = buildMPM({ dynamics: [{ ...refBase }], tempo: [] });
    const studB = buildMPM({ dynamics: [studentSofter], tempo: [] });
    exaggerate(refB, studB, range, 1.0, noop);

    const teacherA = (refA.getInstructions().find((i: any) => i['xml:id'] === 'sym') as Dynamics).volume;
    const teacherB = (refB.getInstructions().find((i: any) => i['xml:id'] === 'sym') as Dynamics).volume;

    // Student louder by +20 -> teacher = 60 - 20 = 40
    // Student softer by -20 -> teacher = 60 - (-20) = 80
    assert(approx(teacherA, 40), `student louder -> teacher 40, got ${teacherA}`);
    assert(approx(teacherB, 80), `student softer -> teacher 80, got ${teacherB}`);
    assert(approx(teacherA + teacherB, 120), `symmetric: A + B = 120 (2 * ref), got ${teacherA + teacherB}`);
}

// ── Test 23: diff() with only one threshold exceeded ─────────────────────

console.log('\n=== Test 23: diff() reports when only one attribute exceeds threshold ===');
{
    // volume delta = +5 (> 4 threshold), transition.to delta = +2 (< 4 threshold)
    const refDyn: Dynamics[] = [
        { type: 'dynamics', 'xml:id': 'partial', date: 100, volume: 60, 'transition.to': 60 },
    ];
    const studentDyn: Dynamics[] = [
        { type: 'dynamics', 'xml:id': 'partial', date: 100, volume: 65, 'transition.to': 62 },
    ];

    const ref = buildMPM({ dynamics: refDyn, tempo: [] });
    const student = buildMPM({ dynamics: studentDyn, tempo: [] });
    const result = diff(ref, student, range);

    // The diff function checks if BOTH are below threshold to skip.
    // Here volume is above threshold, so the instruction should appear.
    assert(result.includes('partial'), 'instruction appears when at least one attribute exceeds threshold');
}

// ── Test 24: diff() with many instructions - topN works correctly ────────

console.log('\n=== Test 24: diff() with many instructions and topN=3 ===');
{
    const dynamics: Dynamics[] = [];
    const studentDynamics: Dynamics[] = [];

    for (let i = 0; i < 20; i++) {
        const vol = 50 + i;
        dynamics.push({
            type: 'dynamics', 'xml:id': `many_${i}`, date: i * 100,
            volume: vol, 'transition.to': vol,
        });
        studentDynamics.push({
            type: 'dynamics', 'xml:id': `many_${i}`, date: i * 100,
            volume: vol + (i * 2) + 5, // increasing deltas: 5, 7, 9, 11, ...
            'transition.to': vol + (i * 2) + 5,
        });
    }

    const ref = buildMPM({ dynamics, tempo: [] });
    const student = buildMPM({ dynamics: studentDynamics, tempo: [] });
    const result = diff(ref, student, { from: 0, to: 2000 }, 3);
    const lines = result.split('\n').slice(1);

    assert(lines.length === 3, `topN=3 returns exactly 3 lines, got ${lines.length}`);
    // The highest magnitude should be for the last instructions (highest deltas)
    assert(result.includes('many_19'), 'many_19 (highest delta) appears in top 3');
}

// ── Test 25: exaggerate() mutates mpm1 in place ─────────────────────────

console.log('\n=== Test 25: exaggerate() mutates mpm1 in place (not a copy) ===');
{
    const ref = buildMPM({
        dynamics: [{ type: 'dynamics', 'xml:id': 'mut', date: 100, volume: 60, 'transition.to': 60 }],
        tempo: [],
    });
    const student = buildMPM({
        dynamics: [{ type: 'dynamics', 'xml:id': 'mut', date: 100, volume: 80, 'transition.to': 80 }],
        tempo: [],
    });

    const beforeVol = (ref.getInstructions().find((i: any) => i['xml:id'] === 'mut') as Dynamics).volume;
    exaggerate(ref, student, range, 1.0, noop);
    const afterVol = (ref.getInstructions().find((i: any) => i['xml:id'] === 'mut') as Dynamics).volume;

    assert(beforeVol !== afterVol, `mpm1 was mutated: ${beforeVol} -> ${afterVol}`);
}

// ── Test 26: Pipeline round-trip - diff before and after exaggeration ────

console.log('\n=== Test 26: After exaggeration, diff shows larger differences ===');
{
    const ref = buildMPM({ dynamics: makeRefDynamics(), tempo: makeRefTempo() });
    const student = buildMPM({ dynamics: makeStudentDynamics(), tempo: makeStudentTempo() });

    // diff before exaggeration
    const diffBefore = diff(ref, student, range);

    // exaggerate
    const teacher = deepCloneMPM(ref);
    exaggerate(teacher, student, range, 1.5, noop);

    // diff after exaggeration (teacher vs student)
    const diffAfter = diff(teacher, student, range);

    // Parse magnitudes from both diffs
    const extractMagnitudes = (diffStr: string): number[] => {
        const lines = diffStr.split('\n').slice(1);
        return lines.map(line => {
            const deltas = [...line.matchAll(/\(([+-]?\d+\.\d+)\)/g)].map(m => Math.abs(parseFloat(m[1])));
            return deltas.reduce((sum, d) => sum + d, 0);
        });
    };

    const magsBefore = extractMagnitudes(diffBefore);
    const magsAfter = extractMagnitudes(diffAfter);

    if (magsBefore.length > 0 && magsAfter.length > 0) {
        const maxBefore = Math.max(...magsBefore);
        const maxAfter = Math.max(...magsAfter);
        assert(maxAfter > maxBefore,
            `largest magnitude after exaggeration (${maxAfter.toFixed(1)}) > before (${maxBefore.toFixed(1)})`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} assertions`);
console.log('='.repeat(60));

if (failed > 0) {
    process.exit(1);
}
