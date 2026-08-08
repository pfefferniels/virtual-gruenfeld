import { describe, expect, it } from 'vitest';
import { MPM } from 'mpm-ts';
import { allDimensions, DEFAULT_EXAGGERATION_STRENGTH, exaggerate } from './exaggerate';
import type { Range } from './types';

const RANGE: Range = { from: 0, to: 10000 };
const noLog = () => {};

/**
 * The ceilings from EXAGGERATION_TUNING, restated here on purpose: a demo may
 * never move an attribute further from Grünfeld's value than this, whatever the
 * teacher asked for. Changing the table must break this test.
 */
const MAX_ABS_DELTA: Record<string, Record<string, number>> = {
    dynamics: { volume: 12, 'transition.to': 12 },
    tempo: { bpm: 10, 'transition.to': 10 },
    articulation: { relativeDuration: 0.2, relativeVelocity: 0.2 },
    rubato: { intensity: 0.15 },
    ornament: { scale: 0.8, intensity: 0.25 },
    asynchrony: { 'milliseconds.offset': 40 },
    accentuationPattern: { scale: 0.6 },
};

/** Attribute bounds — the same floors/ceilings tempoSafety and dynamicsSafety enforce. */
const BOUNDS: Record<string, Record<string, [number, number]>> = {
    dynamics: { volume: [1, 127], 'transition.to': [1, 127] },
    tempo: { bpm: [10, 300], 'transition.to': [10, 300] },
    articulation: { relativeDuration: [0.1, 5], relativeVelocity: [0.1, 5] },
    rubato: { intensity: [0.01, 10] },
    ornament: { scale: [0.1, 20], intensity: [0.01, 10] },
    asynchrony: { 'milliseconds.offset': [-500, 500] },
    accentuationPattern: { scale: [0, 10] },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const build = (instructions: Array<Record<string, any>>): MPM => {
    const mpm = new MPM();
    for (const [index, instruction] of instructions.entries()) {
        mpm.insertInstruction({
            'xml:id': `i${index}`,
            date: 0,
            ...instruction,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any, 'global');
    }
    return mpm;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const instructionsOf = (mpm: MPM): any[] => mpm.getInstructions();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const byId = (mpm: MPM, id: string): any => instructionsOf(mpm).find((i) => i['xml:id'] === id);

describe('exaggerate: which dimensions get shaped', () => {
    const pair = () => ({
        ref: build([
            { type: 'tempo', bpm: 60 },
            { type: 'dynamics', volume: 50 },
        ]),
        student: build([
            { type: 'tempo', bpm: 90 },
            { type: 'dynamics', volume: 80 },
        ]),
    });

    it('touches only the dimensions the plan named', () => {
        const { ref, student } = pair();
        exaggerate(ref, student, RANGE, [{ type: 'tempo', strength: 0.4 }], noLog);

        expect(byId(ref, 'i0').bpm).toBeLessThan(60);
        expect(byId(ref, 'i1').volume).toBe(50);
    });

    it('does nothing at all when the plan named no dimensions', () => {
        const { ref, student } = pair();
        exaggerate(ref, student, RANGE, [], noLog);

        expect(byId(ref, 'i0').bpm).toBe(60);
        expect(byId(ref, 'i1').volume).toBe(50);
    });

    it('ignores a type that is not shapeable, and an unusable strength', () => {
        const { ref, student } = pair();
        exaggerate(ref, student, RANGE, [
            { type: 'phrasing', strength: 0.4 },
            { type: 'dynamics', strength: Number.NaN },
        ], noLog);

        expect(byId(ref, 'i0').bpm).toBe(60);
        expect(byId(ref, 'i1').volume).toBe(50);
    });

    it('keeps the first strength when a type is named twice', () => {
        const { ref, student } = pair();
        const { ref: control, student: controlStudent } = pair();

        exaggerate(ref, student, RANGE, [
            { type: 'tempo', strength: 0.1 },
            { type: 'tempo', strength: 0.5 },
        ], noLog);
        exaggerate(control, controlStudent, RANGE, [{ type: 'tempo', strength: 0.1 }], noLog);

        expect(byId(ref, 'i0').bpm).toBe(byId(control, 'i0').bpm);
    });

    it('stays inside the range it was given', () => {
        const ref = build([{ type: 'tempo', bpm: 60, date: 0 }, { type: 'tempo', bpm: 60, date: 5000 }]);
        const student = build([{ type: 'tempo', bpm: 90, date: 0 }, { type: 'tempo', bpm: 90, date: 5000 }]);

        exaggerate(ref, student, { from: 4000, to: 6000 }, allDimensions(), noLog);

        expect(byId(ref, 'i0').bpm).toBe(60);
        expect(byId(ref, 'i1').bpm).toBeLessThan(60);
    });
});

describe('exaggerate: strength', () => {
    const push = (strength: number): number => {
        const ref = build([{ type: 'tempo', bpm: 60 }]);
        exaggerate(ref, build([{ type: 'tempo', bpm: 90 }]), RANGE, [{ type: 'tempo', strength }], noLog);
        return byId(ref, 'i0').bpm;
    };

    it('pushes the reference away from the student, not towards it', () => {
        // The student rushed, so the demonstration slows down to make the gap audible.
        expect(push(0.2)).toBeLessThan(60);

        const slowStudent = build([{ type: 'tempo', bpm: 60 }]);
        exaggerate(slowStudent, build([{ type: 'tempo', bpm: 40 }]), RANGE, [{ type: 'tempo', strength: 0.2 }], noLog);
        expect(byId(slowStudent, 'i0').bpm).toBeGreaterThan(60);
    });

    it('pushes monotonically further as strength rises', () => {
        expect(push(0.4)).toBeLessThan(push(0.2));
        expect(push(0.2)).toBeLessThan(push(0.05));
    });

    it('reproduces the pre-Phase-3 numbers at the default strength', () => {
        // ref * (ref/student)^(strength * tuning.strength) = 60 * (60/90)^(0.2*0.35)
        const expected = 60 * Math.pow(60 / 90, DEFAULT_EXAGGERATION_STRENGTH * 0.35);
        expect(push(DEFAULT_EXAGGERATION_STRENGTH)).toBeCloseTo(expected, 9);

        const ref = build([{ type: 'tempo', bpm: 60 }]);
        exaggerate(ref, build([{ type: 'tempo', bpm: 90 }]), RANGE, allDimensions(), noLog);
        expect(byId(ref, 'i0').bpm).toBeCloseTo(expected, 9);
    });

    it('covers every shapeable type with allDimensions()', () => {
        expect(allDimensions().map((d) => d.type)).toEqual([
            'dynamics', 'tempo', 'articulation', 'rubato', 'ornament', 'asynchrony', 'accentuationPattern',
        ]);
        expect(allDimensions().every((d) => d.strength === DEFAULT_EXAGGERATION_STRENGTH)).toBe(true);
    });
});

describe('exaggerate: the caps are ceilings, not targets', () => {
    /** One instruction per type, with the student absurdly far from the reference. */
    const REFERENCE = [
        { type: 'dynamics', volume: 40, 'transition.to': 45 },
        { type: 'tempo', bpm: 60, 'transition.to': 65 },
        { type: 'articulation', relativeDuration: 1, relativeVelocity: 1 },
        { type: 'rubato', intensity: 1 },
        { type: 'ornament', scale: 1, intensity: 1 },
        { type: 'asynchrony', 'milliseconds.offset': 0 },
        { type: 'accentuationPattern', scale: 1 },
    ];
    const STUDENT = [
        { type: 'dynamics', volume: 127, 'transition.to': 127 },
        { type: 'tempo', bpm: 300, 'transition.to': 300 },
        { type: 'articulation', relativeDuration: 5, relativeVelocity: 5 },
        { type: 'rubato', intensity: 10 },
        { type: 'ornament', scale: 20, intensity: 10 },
        { type: 'asynchrony', 'milliseconds.offset': 480 },
        { type: 'accentuationPattern', scale: 10 },
    ];

    /** Anything the model could send, plus values the validator would never let through. */
    const STRENGTHS = [0.05, 0.2, 0.5, 1, 12, 1e6, Number.MAX_SAFE_INTEGER];

    it.each(STRENGTHS)('never exceeds maxAbsDelta at strength %s', (strength) => {
        const ref = build(REFERENCE);
        const student = build(STUDENT);
        const dimensions = REFERENCE.map((instruction) => ({ type: instruction.type, strength }));

        exaggerate(ref, student, RANGE, dimensions, noLog);

        for (const [index, original] of REFERENCE.entries()) {
            const shaped = byId(ref, `i${index}`);
            for (const [attr, refValue] of Object.entries(original)) {
                if (attr === 'type' || typeof refValue !== 'number') continue;
                const delta = Math.abs(shaped[attr] - refValue);
                expect(
                    delta,
                    `${original.type}.${attr} moved ${delta} from ${refValue} at strength ${strength}`,
                ).toBeLessThanOrEqual(MAX_ABS_DELTA[original.type][attr] + 1e-9);
            }
        }
    });

    it.each(STRENGTHS)('stays inside the renderable bounds at strength %s', (strength) => {
        const ref = build(REFERENCE);
        const student = build(STUDENT);

        exaggerate(ref, student, RANGE, REFERENCE.map((i) => ({ type: i.type, strength })), noLog);

        for (const [index, original] of REFERENCE.entries()) {
            const shaped = byId(ref, `i${index}`);
            for (const [attr, refValue] of Object.entries(original)) {
                if (attr === 'type' || typeof refValue !== 'number') continue;
                const [min, max] = BOUNDS[original.type][attr];
                expect(shaped[attr]).toBeGreaterThanOrEqual(min);
                expect(shaped[attr]).toBeLessThanOrEqual(max);
                expect(Number.isFinite(shaped[attr])).toBe(true);
            }
        }
    });

    it('leaves the tempo floor and the velocity range intact even at absurd strength', () => {
        // The safety pass that follows (tempoSafety floors bpm at 10, dynamicsSafety
        // clamps velocity to 1..127) must have nothing left to correct.
        const ref = build([{ type: 'tempo', bpm: 12 }, { type: 'dynamics', volume: 5 }]);
        const student = build([{ type: 'tempo', bpm: 300 }, { type: 'dynamics', volume: 127 }]);

        exaggerate(ref, student, RANGE, [
            { type: 'tempo', strength: 1000 },
            { type: 'dynamics', strength: 1000 },
        ], noLog);

        expect(byId(ref, 'i0').bpm).toBeGreaterThanOrEqual(10);
        expect(byId(ref, 'i1').volume).toBeGreaterThanOrEqual(1);
        expect(byId(ref, 'i1').volume).toBeLessThanOrEqual(127);
    });
});
