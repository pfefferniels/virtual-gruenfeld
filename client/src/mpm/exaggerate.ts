import { Mpm } from "espressivo";
import { importMPM, type MPM } from "mpm-ts";
import { readInstructions } from "./pair";
import type { Range } from "./types";

/**
 * One instruction, as far as the exaggeration is concerned: a type, the join key, and whatever
 * numeric attributes the document states.
 *
 * The reference side is still an `mpm-ts` document, because `exaggerate` mutates its
 * instructions in place and `exportMPM` then serialises them for the renderer. The *student*
 * side is only ever read, attribute by attribute, so it is typed structurally: the take's
 * student performance is an espressivo document now, and `mpm/pair.ts`'s reader answers this
 * shape from it without a second parser. Both go when `counter.ts` replaces this file.
 */
export type InstructionSource = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getInstructions(): readonly any[];
};

/**
 * `performance.mpm` as the document the counter-performance is built on.
 *
 * The one place an `mpm-ts` document is still constructed from text. The reference crosses
 * every other boundary as XML (DESIGN §3.5, semantics 30: a fresh parse cannot be mutated by
 * anyone else, so the clone-and-keep-pristine discipline is structural here).
 */
export const counterPerformanceBase = (referenceMpmText: string): MPM => importMPM(referenceMpmText);

/**
 * The student's side of the exaggeration: what `fitStudent` wrote, read back as instructions.
 *
 * `mpm/pair.ts` already reads a document exactly this way — raw attributes, defs dereferenced,
 * nothing defaulted — and its reading covers every attribute `EXAGGERATION_SPEC` names, so the
 * push is computed off the same numbers the teacher's evidence quotes.
 */
export const studentInstructionsFrom = (studentMpmText: string): InstructionSource => {
    const instructions = readInstructions(new Mpm(studentMpmText)).all.map((reading) => ({
        type: reading.type,
        'xml:id': reading.xmlId,
        date: reading.date,
        ...reading.values,
    }));
    return { getInstructions: () => instructions };
};

/** `[range.from, range.to]`, inclusive at both ends — `mpm/pair.ts` selects on the same rule. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inRange = (i: any, range: Range) => {
    const date = i.date ?? i["date"];
    return typeof date === 'number' && date >= range.from && date <= range.to;
};

/** The join: `${type}::${xml:id}`, the identity the reference prints and the fitter writes into. */
const indexInstructions = (source: InstructionSource) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idx = new Map<string, any>();
    for (const i of source.getInstructions()) {
        idx.set(`${i.type}::${i["xml:id"]}`, i);
    }
    return idx;
};

const logExaggerate = (ref: number, student: number, aggressiveness: number, min: number, max: number): number => {
    if (student <= 0 || ref <= 0) return ref;
    const ratio = ref / student;
    return Math.max(min, Math.min(max, ref * Math.pow(ratio, aggressiveness)));
};

/**
 * How far one deviation type gets pushed. Before Phase 3 a single global 0.2
 * covered all of them; now the teacher sets one per type it wants heard.
 * `maxAbsDelta` in EXAGGERATION_TUNING stays the ceiling either way.
 */
export type ExaggerationDimension = { type: string; strength: number };

/** The aggressiveness the fixed-pedagogy pipeline always used. */
export const DEFAULT_EXAGGERATION_STRENGTH = 0.2;

const EXAGGERATION_TUNING: Record<string, Record<string, { strength: number; maxAbsDelta: number }>> = {
    dynamics: {
        volume: { strength: 0.45, maxAbsDelta: 12 },
        'transition.to': { strength: 0.45, maxAbsDelta: 12 },
    },
    tempo: {
        bpm: { strength: 0.35, maxAbsDelta: 10 },
        'transition.to': { strength: 0.35, maxAbsDelta: 10 },
    },
    articulation: {
        relativeDuration: { strength: 0.5, maxAbsDelta: 0.2 },
        relativeVelocity: { strength: 0.45, maxAbsDelta: 0.2 },
    },
    rubato: {
        intensity: { strength: 0.25, maxAbsDelta: 0.15 },
    },
    ornament: {
        scale: { strength: 0.4, maxAbsDelta: 0.8 },
        intensity: { strength: 0.35, maxAbsDelta: 0.25 },
    },
    asynchrony: {
        'milliseconds.offset': { strength: 0.35, maxAbsDelta: 40 },
    },
    accentuationPattern: {
        scale: { strength: 0.4, maxAbsDelta: 0.6 },
    },
};

const applyExaggerationCap = (
    refVal: number,
    exaggeratedVal: number,
    maxAbsDelta: number,
    min: number,
    max: number,
): number => {
    const lower = Math.max(min, refVal - maxAbsDelta);
    const upper = Math.min(max, refVal + maxAbsDelta);
    return Math.max(lower, Math.min(upper, exaggeratedVal));
};

const EXAGGERATION_SPEC: Record<string, Array<{ attr: string; min: number; max: number }>> = {
    dynamics: [
        { attr: 'volume', min: 1, max: 127 },
        { attr: 'transition.to', min: 1, max: 127 },
    ],
    tempo: [
        { attr: 'bpm', min: 10, max: 300 },
        { attr: 'transition.to', min: 10, max: 300 },
    ],
    articulation: [
        { attr: 'relativeDuration', min: 0.1, max: 5 },
        { attr: 'relativeVelocity', min: 0.1, max: 5 },
    ],
    rubato: [
        { attr: 'intensity', min: 0.01, max: 10 },
    ],
    ornament: [
        { attr: 'scale', min: 0.1, max: 20 },
        { attr: 'intensity', min: 0.01, max: 10 },
    ],
    asynchrony: [
        { attr: 'milliseconds.offset', min: -500, max: 500 },
    ],
    accentuationPattern: [
        { attr: 'scale', min: 0, max: 10 },
    ],
};

/** Every shapeable dimension at one strength — the pre-Phase-3 behaviour. */
export const allDimensions = (
    strength: number = DEFAULT_EXAGGERATION_STRENGTH,
): ExaggerationDimension[] =>
    Object.keys(EXAGGERATION_SPEC).map((type) => ({ type, strength }));

/**
 * Push the reference performance further away from the student's, so what the
 * student did differently becomes audible by contrast. Only the dimensions given
 * are touched; everything else is left as Grünfeld played it.
 *
 * A dimension's strength scales how far the push goes, never how far it is
 * *allowed* to go: EXAGGERATION_TUNING's `maxAbsDelta` and the per-attribute
 * min/max bounds are applied afterwards and cap the result unconditionally.
 */
export const exaggerate = (
    mpm1: MPM,
    mpm2: InstructionSource,
    range: Range,
    dimensions: ExaggerationDimension[],
    log: (msg: string) => void,
) => {
    const strengthByType = new Map<string, number>();
    for (const dimension of dimensions) {
        if (typeof dimension?.strength !== 'number' || !Number.isFinite(dimension.strength)) continue;
        if (!strengthByType.has(dimension.type)) strengthByType.set(dimension.type, dimension.strength);
    }
    if (strengthByType.size === 0) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allInstructions: any[] = mpm1.getInstructions().filter(i => inRange(i, range));
    const idx = indexInstructions(mpm2);

    for (const instruction of allInstructions) {
        const aggressiveness = strengthByType.get(instruction.type);
        if (aggressiveness === undefined) continue;

        const corresp = idx.get(`${instruction.type}::${instruction["xml:id"]}`);
        if (!corresp) continue;

        const specs = EXAGGERATION_SPEC[instruction.type];
        if (!specs) continue;

        const changes: string[] = [];
        for (const { attr, min, max } of specs) {
            const refVal = instruction[attr];
            const studentVal = corresp[attr];
            if (typeof refVal !== 'number' || typeof studentVal !== 'number') continue;

            const old = refVal;
            const tuning = EXAGGERATION_TUNING[instruction.type]?.[attr] ?? { strength: 1, maxAbsDelta: max };
            const effectiveAggressiveness = aggressiveness * tuning.strength;
            if (instruction.type === 'asynchrony') {
                const delta = studentVal - refVal;
                const exaggerated = refVal - delta * effectiveAggressiveness;
                instruction[attr] = applyExaggerationCap(refVal, exaggerated, tuning.maxAbsDelta, min, max);
            } else {
                const exaggerated = logExaggerate(refVal, studentVal, effectiveAggressiveness, min, max);
                instruction[attr] = applyExaggerationCap(refVal, exaggerated, tuning.maxAbsDelta, min, max);
            }
            changes.push(`${attr}: ${old.toFixed(1)}→${instruction[attr].toFixed(1)} (student=${studentVal.toFixed(1)})`);
        }
        if (changes.length > 0) {
            log(`exaggerate ${instruction.type} ${instruction["xml:id"]} ${changes.join(', ')}`);
        }
    }
};
