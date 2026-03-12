import type { MPM } from "mpm-ts";
import { inRange, indexInstructions } from "./helpers";
import type { Range } from "./types";

const logExaggerate = (ref: number, student: number, aggressiveness: number, min: number, max: number): number => {
    if (student <= 0 || ref <= 0) return ref;
    const ratio = ref / student;
    return Math.max(min, Math.min(max, ref * Math.pow(ratio, aggressiveness)));
};

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

export const exaggerate = (mpm1: MPM, mpm2: MPM, range: Range, aggressiveness: number = 1, log: (msg: string) => void) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allInstructions: any[] = mpm1.getInstructions().filter(i => inRange(i, range));
    const idx = indexInstructions(mpm2);

    for (const instruction of allInstructions) {
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
