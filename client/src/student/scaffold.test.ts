/**
 * Grünfeld's slots, as the fitter has to see them.
 *
 * These tests pin what the reference document *prints* — the ids, the spans, the `@name.ref`s —
 * because that is the whole claim the rewrite rests on: the join key does not have to be
 * manufactured by replaying 494 transformer calls, it is already there. If `performance.mpm`
 * is ever rebaked these fail, which is the intent.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PPQ, tickToPos } from '../shared/constants';
import { parseReferenceMpm } from '../mpm/reference';
import type { Range } from '../mpm/types';
import { readScaffold } from './scaffold';

const load = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const reference = parseReferenceMpm(load('../../public/performance.mpm'));

/** The same four-bar take `cut.test.ts` uses: m5.1 to m9.1. */
const TAKE: Range = { from: 11520, to: 23040 };

const scaffold = readScaffold(reference, TAKE);

describe('what a scaffold reads', () => {
    it('names the take by its position, so the range under test is the readable one', () => {
        expect([tickToPos(TAKE.from), tickToPos(TAKE.to)]).toEqual(['m5.1', 'm9.1']);
        expect(TAKE.to - TAKE.from).toBe(4 * 4 * PPQ);
        expect(scaffold.range).toEqual(TAKE);
    });

    /**
     * `cut.ts`'s rule, applied to the same map: the opening instruction before the window
     * (10 440), the eight inside it, and the closing one after it (23 760). Grünfeld's ids, in
     * Grünfeld's order — this is the scaffold the student is fitted into, and the same list
     * `cut.test.ts` asserts of a cut document, which is what makes the two sides pair.
     */
    it('takes the opening slot, the in-range slots and the closing slot', () => {
        expect(scaffold.tempo.map((slot) => slot.xmlId)).toEqual([
            'tempo_10440',
            'tempo_12240',
            'tempo_13680',
            'tempo_14400',
            'tempo_16560',
            'tempo_18360',
            'tempo_19440',
            'tempo_20880',
            'tempo_22320',
            'tempo_23760',
        ]);
        expect(scaffold.tempo[0].date).toBeLessThan(TAKE.from);
        expect(scaffold.tempo[scaffold.tempo.length - 1].date).toBeGreaterThanOrEqual(TAKE.to);
    });

    it('reads every id as `${type}_${date}` — the join key, already written', () => {
        for (const slot of [...scaffold.tempo, ...scaffold.dynamics, ...scaffold.rubato]) {
            expect(slot.xmlId).toMatch(/^(tempo|dynamics|rubato)_\d+$/);
            expect(Number(slot.xmlId.split('_')[1])).toBe(slot.date);
        }
    });

    it('takes each slot’s span from the reference’s own @endDate', () => {
        // <tempo xml:id="tempo_10440" date="10440" endDate="12240" …>
        expect(scaffold.tempo[0]).toMatchObject({ date: 10440, endDate: 12240 });
        expect(scaffold.tempo[1]).toMatchObject({ date: 12240, endDate: 13680 });
    });

    it('copies @beatLength rather than fitting it', () => {
        expect(scaffold.tempo.every((slot) => slot.beatLength === 0.25)).toBe(true);
    });

    it('copies a rubato’s frame and window, and ends its span at the frame', () => {
        const frame = scaffold.rubato.find((slot) => slot.xmlId === 'rubato_11520');
        expect(frame).toMatchObject({ date: 11520, frameLength: 720, endDate: 12240, loop: false });
    });

    it('reads an articulation’s notes and the def it names', () => {
        const slot = scaffold.articulation.find((s) => s.xmlId === 'articulation_11520');
        expect(slot).toMatchObject({ date: 11520, defName: 'Überlegato', noteIds: ['nrjozf4'] });
    });

    /**
     * Risk R6: the reference's 26 `articulationDef`s are 24 `relativeDuration`, 1
     * `absoluteDuration` and 2 `relativeVelocity`. Which of the three a def states decides
     * whether the fitter can answer for it at all, so the scaffold reports it rather than
     * leaving the fitter to guess from a getter that defaults.
     */
    it('reports which attribute each articulationDef actually states', () => {
        for (const slot of scaffold.articulation) {
            expect(slot.defStates.length).toBeGreaterThan(0);
            for (const stated of slot.defStates) {
                expect(['relativeDuration', 'relativeVelocity', 'absoluteDuration']).toContain(stated);
            }
        }
        const whole = readScaffold(reference, { from: 0, to: 92160 });
        const absolute = whole.articulation.filter((slot) => slot.defStates.includes('absoluteDuration'));
        expect(absolute.length).toBeGreaterThan(0);
        expect(absolute[0].defStates).not.toContain('relativeDuration');
    });

    it('reads an ornament’s def name and the gradient shape that def carries', () => {
        const slot = scaffold.ornament.find((s) => s.xmlId === 'ornament_11520');
        expect(slot?.defName).toBe('def_global_2_0');
        // <ornamentDef name="def_global_2_0"><dynamicsGradient transition.from="1" transition.to="0">
        expect(slot?.gradient).toEqual({ from: 1, to: 0 });
    });

    it('collects the accentuation patterns the in-range slots name', () => {
        const slot = scaffold.accentuation.find((s) => s.xmlId === 'accentuationPattern_19440');
        expect(slot?.defName).toBeTruthy();
        const pattern = scaffold.patterns.get(slot?.defName ?? '');
        expect(pattern).toBeDefined();
        expect(pattern?.length).toBeGreaterThan(0);
        // the shape is Grünfeld's: beats, values and both transitions, carried as plain numbers
        expect(pattern?.accentuations.length).toBeGreaterThan(0);
        for (const [beat, value, from, to] of pattern?.accentuations ?? []) {
            expect(Number.isFinite(beat)).toBe(true);
            for (const number of [value, from, to]) {
                expect(number).toBeGreaterThanOrEqual(-1);
                expect(number).toBeLessThanOrEqual(1);
            }
        }
        expect([...scaffold.patterns.keys()].sort()).toEqual(
            [...new Set(scaffold.accentuation.map((s) => s.defName))].sort(),
        );
    });

    it('reads the styleDef names and the switches, so a student’s @name.ref resolves', () => {
        expect(scaffold.styleNames).toEqual({
            articulation: 'performance_style',
            ornamentation: 'performance_style',
            metricalAccentuation: 'performance_style',
        });
        // The reference switches style in two of the three maps and not in the articulation
        // map; the student document has to reproduce exactly that, not a tidier version of it.
        expect(scaffold.styleSwitches).toEqual([
            { map: 'ornamentationMap', date: 0, nameRef: 'performance_style' },
            { map: 'metricalAccentuationMap', date: 0, nameRef: 'performance_style' },
        ]);
    });

    it('holds nothing but plain data, so the evidence worker can carry one', () => {
        expect(() => structuredClone(scaffold)).not.toThrow();
    });

    it('refuses a range that is not one', () => {
        expect(() => readScaffold(reference, { from: 100, to: 100 })).toThrow(/not a range/);
        expect(() => readScaffold(reference, { from: 200, to: 100 })).toThrow(/not a range/);
        expect(() => readScaffold(reference, { from: 0, to: Number.NaN })).toThrow(/not a range/);
    });
});

describe('a take that lands where nothing is written', () => {
    /**
     * Risk R1 from the scaffold's side: a window past the end of the reconstruction (its last
     * date is 91 464) still yields the opening slot of every map, because a value prevails
     * until the next one and the window has to open on *something*.
     */
    it('still opens on the prevailing value', () => {
        const beyond = readScaffold(reference, { from: 95000, to: 96000 });
        expect(beyond.tempo).toHaveLength(1);
        expect(beyond.tempo[0].date).toBeLessThan(95000);
        expect(beyond.dynamics).toHaveLength(1);
    });
});
