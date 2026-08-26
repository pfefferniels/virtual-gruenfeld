/**
 * Pairing, against the document it was designed for.
 *
 * Every fixture here is `performance.mpm` itself or a copy of it with one attribute moved, so
 * that what is asserted is what the reference actually prints rather than what a hand-built
 * two-element document could be made to print. The claim under test is the one the whole
 * rewrite rests on: the join is a `Map` lookup on `${type}::${xml:id}`, and what comes out of
 * it is the same `InstructionDiff` shape, in the same raw units, that `diff.ts` has consumed
 * since before any of this.
 *
 * DESIGN §5 test 7 (orientation) lives here; test 8 (positions) needs a comparison report and
 * lives in `compare.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Mpm } from 'espressivo';
import { describe, expect, it } from 'vitest';
import { diffFrom, diffStructuredFrom } from './diff';
import {
    ornamentStylesOf,
    pairInstructions,
    readInstructions,
    type InstructionIndex,
    type InstructionReading,
} from './pair';
import { parseReferenceMpm } from './reference';
import { DIFF_TYPES, type InstructionDiff, type Range } from './types';

const load = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const referenceText = load('../../public/performance.mpm');
const reference = parseReferenceMpm(referenceText);

/** The four-bar take the fitter's suite uses: m5.1 to m9.1. */
const TAKE: Range = { from: 11520, to: 23040 };
const WHOLE: Range = { from: 0, to: 92160 };

/**
 * Scale or offset named attributes on every `<name …>` opening tag.
 *
 * Textual surgery rather than the object model, deliberately: a fixture that goes through
 * espressivo's writer would test the writer, and what is wanted here is a document that differs
 * from the reference in exactly one attribute and in nothing else — same ids, same order, same
 * everything the pairing keys on.
 */
export const alter = (
    text: string,
    element: string,
    attributes: readonly string[],
    change: (value: number) => number,
): string =>
    text.replace(new RegExp(`<${element}\\b[^>]*>`, 'g'), (tag) =>
        attributes.reduce(
            (acc, attribute) =>
                acc.replace(
                    new RegExp(`(\\s${attribute.replace('.', '\\.')}=")([-0-9.eE]+)(")`),
                    (_match, before: string, value: string, after: string) =>
                        `${before}${change(Number(value))}${after}`,
                ),
            tag,
        ),
    );

// ── what the reader sees ─────────────────────────────────────────────────────────────────

describe('reading a document', () => {
    const index: InstructionIndex = readInstructions(reference);
    const countOf = (type: string): number => index.all.filter((i) => i.type === type).length;

    it('finds every instruction the reference prints, and no others', () => {
        // The inventory `reference.test.ts` pins, read through the pairing's own reader.
        expect(countOf('tempo')).toBe(60);
        expect(countOf('dynamics')).toBe(61);
        expect(countOf('rubato')).toBe(56);
        expect(countOf('accentuationPattern')).toBe(51);
        expect(countOf('articulation')).toBe(47);
        expect(countOf('ornament')).toBe(100);
        // Nothing fits it and the reference declares none — the contract type (DESIGN §7).
        expect(countOf('asynchrony')).toBe(0);
    });

    it('keys every instruction by `${type}::${xml:id}`', () => {
        for (const instruction of index.all) {
            expect(instruction.xmlId).not.toBe('');
            expect(index.byId.get(`${instruction.type}::${instruction.xmlId}`)).toBe(instruction);
        }
        expect(index.byId.get('tempo::tempo_720')?.date).toBe(720);
    });

    it('reads tempo and dynamics off the element, in raw MPM units', () => {
        const tempo = index.byId.get('tempo::tempo_720');
        expect(tempo?.values.bpm).toBeCloseTo(76.15, 2);
        expect(tempo?.values['transition.to']).toBeCloseTo(48.15, 2);

        const dynamics = index.byId.get('dynamics::dynamics_0');
        expect(dynamics?.values.volume).toBe(41);
        expect(dynamics?.values['transition.to']).toBe(40);
    });

    it('dereferences `<articulationDef>` — the attribute that was never visible before', () => {
        const named: readonly InstructionReading[] = index.all.filter(
            (i) => i.type === 'articulation' && i.values.relativeDuration !== undefined,
        );
        expect(named.length).toBeGreaterThan(20);
        for (const instruction of named) {
            expect(instruction.nameRef).toBeTruthy();
            expect(Number.isFinite(instruction.values.relativeDuration)).toBe(true);
        }
    });

    it('never coerces an `@absoluteDuration` def into a ratio (risk R6)', () => {
        // The reference's 26 defs are 24 `relativeDuration`, 1 `absoluteDuration`, 2
        // `relativeVelocity`. A duration in ticks is not a multiplier; the typed getter would
        // answer `1` for that def, which is why the reader walks raw attributes instead.
        const absolute = referenceText.match(/<articulationDef name="([^"]+)" absoluteDuration=/);
        expect(absolute).not.toBeNull();
        const naming = index.all.filter((i) => i.type === 'articulation' && i.nameRef === absolute?.[1]);
        expect(naming.length).toBeGreaterThan(0);
        for (const instruction of naming) {
            expect(instruction.values.relativeDuration).toBeUndefined();
            expect(instruction.values.relativeVelocity).toBeUndefined();
        }
    });

    it('reads an ornament’s frame and intensity off its def, its scale off the element', () => {
        const ornament = index.byId.get('ornament::ornament_1440');
        // `<temporalSpread frameLength="114" intensity="0.1767…">` on def_3962e07d…
        expect(ornament?.values.frameLength).toBe(114);
        expect(ornament?.values.intensity).toBeCloseTo(0.1767, 4);

        const scaled = index.byId.get('ornament::ornament_720');
        expect(scaled?.values.scale).toBe(3);
    });

    it('states the assumption the tempo fallback rests on: every `<tempo>` is a quarter', () => {
        // `compareMpm`'s tempo curve is `ln(quarter-bpm)`, and `profileFallback` inverts it into
        // a `@bpm`. That is only the same number while every `<tempo>` carries `beatLength=0.25`.
        const beatLengths = [...referenceText.matchAll(/<tempo\b[^>]*\sbeatLength="([^"]+)"/g)].map(
            (match) => Number(match[1]),
        );
        expect(beatLengths).toHaveLength(60);
        expect(new Set(beatLengths)).toEqual(new Set([0.25]));
    });
});

// ── the identity, and the deltas ─────────────────────────────────────────────────────────

describe('pairing', () => {
    it('finds nothing between a document and itself (DESIGN §5 test 1)', () => {
        expect(pairInstructions(reference, reference, WHOLE)).toEqual([]);
        expect(diffFrom(pairInstructions(reference, reference, WHOLE), WHOLE)).toBe(
            'No significant differences found.',
        );
    });

    it('reports `delta = student − ref`, in the document’s own units', () => {
        const faster = new Mpm(alter(referenceText, 'tempo', ['bpm'], (v) => v + 10));
        const peaks = pairInstructions(reference, faster, TAKE).filter((p) => p.type === 'tempo');
        expect(peaks.length).toBeGreaterThan(3);
        for (const peak of peaks) {
            expect(peak.diffs.bpm.delta).toBeCloseTo(10, 6);
            expect(peak.diffs.bpm.student - peak.diffs.bpm.ref).toBeCloseTo(10, 6);
        }
    });

    it('holds an instruction below its floor to be measurement, not playing (semantics 19)', () => {
        // 3 bpm is under `THRESHOLDS.bpm = 4`; 5 is over it.
        expect(pairInstructions(reference, new Mpm(alter(referenceText, 'tempo', ['bpm'], (v) => v + 3)), TAKE))
            .toEqual([]);
        expect(pairInstructions(reference, new Mpm(alter(referenceText, 'tempo', ['bpm'], (v) => v + 5)), TAKE).length)
            .toBeGreaterThan(0);
    });

    it('sums `magnitude` over every compared attribute of the instruction', () => {
        const louder = new Mpm(alter(referenceText, 'dynamics', ['volume', 'transition.to'], (v) => v + 9));
        for (const peak of pairInstructions(reference, louder, TAKE).filter((p) => p.type === 'dynamics')) {
            const sum = Object.values(peak.diffs).reduce((total, d) => total + Math.abs(d.delta), 0);
            expect(peak.magnitude).toBeCloseTo(sum, 6);
        }
    });

    it('takes the window inclusive at both ends, as `helpers.inRange` always did', () => {
        const faster = new Mpm(alter(referenceText, 'tempo', ['bpm'], (v) => v + 10));
        const dates = pairInstructions(reference, faster, { from: 11520, to: 23040 })
            .filter((p) => p.type === 'tempo')
            .map((p) => p.date);
        expect(Math.min(...dates)).toBeGreaterThanOrEqual(11520);
        expect(Math.max(...dates)).toBeLessThanOrEqual(23040);

        const single = pairInstructions(reference, faster, { from: 11520, to: 11520 });
        expect(single.every((p) => p.date === 11520)).toBe(true);
    });

    it('skips an instruction the student never answered for, silently', () => {
        const faster = alter(referenceText, 'tempo', ['bpm'], (v) => v + 10);
        const without = faster.replace(/<tempo xml:id="tempo_12240"[^>]*(\/>|>[\s\S]*?<\/tempo>)/, '');
        const dates = pairInstructions(reference, new Mpm(without), TAKE)
            .filter((p) => p.type === 'tempo')
            .map((p) => p.date);
        expect(dates).not.toContain(12240);
        expect(dates.length).toBeGreaterThan(0);
    });

    it('falls back to `${type}::${date}` when an id does not survive', () => {
        const faster = alter(referenceText, 'tempo', ['bpm'], (v) => v + 10);
        const renamed = faster.replace('xml:id="tempo_12240"', 'xml:id="tempo_12240_2"');
        const paired = pairInstructions(reference, new Mpm(renamed), TAKE).filter((p) => p.date === 12240);
        expect(paired).toHaveLength(1);
        expect(paired[0].diffs.bpm.delta).toBeCloseTo(10, 6);
    });
});

// ── DESIGN §5 test 7: orientation ────────────────────────────────────────────────────────

describe('orientation', () => {
    const louder = new Mpm(alter(referenceText, 'dynamics', ['volume', 'transition.to'], (v) => v + 9));

    it('flips every direction when the two sides are swapped', () => {
        const forward = diffStructuredFrom(pairInstructions(reference, louder, TAKE), TAKE);
        const backward = diffStructuredFrom(pairInstructions(louder, reference, TAKE), TAKE);

        expect(forward.length).toBeGreaterThan(0);
        expect(backward).toHaveLength(forward.length);
        for (let i = 0; i < forward.length; i++) {
            expect(backward[i].id).toBe(forward[i].id);
            expect(backward[i].direction).not.toBe(forward[i].direction);
            expect(backward[i].refValue).toBeCloseTo(forward[i].studentValue, 6);
            expect(backward[i].studentValue).toBeCloseTo(forward[i].refValue, 6);
            expect(backward[i].severity).toBe(forward[i].severity);
        }
    });

    it('says “lauter” to a student who played softer and “leiser” to one who played louder', () => {
        const softer = new Mpm(alter(referenceText, 'dynamics', ['volume', 'transition.to'], (v) => v - 9));
        const up = diffStructuredFrom(pairInstructions(reference, louder, TAKE), TAKE)
            .filter((e) => e.primaryAttr === 'volume');
        const down = diffStructuredFrom(pairInstructions(reference, softer, TAKE), TAKE)
            .filter((e) => e.primaryAttr === 'volume');

        expect(up.length).toBeGreaterThan(0);
        expect(down.length).toBeGreaterThan(0);
        expect(new Set(up.map((e) => e.cueText))).toEqual(new Set(['leiser']));
        expect(new Set(down.map((e) => e.cueText))).toEqual(new Set(['lauter']));
    });
});

// ── the gate's and the fallback's entry points into the pairing ──────────────────────────

describe('the options the comparison hands in', () => {
    const faster = new Mpm(alter(referenceText, 'tempo', ['bpm'], (v) => v + 10));

    it('drops a suppressed type whole, before the top-3 selection', () => {
        const withTempo = pairInstructions(reference, faster, TAKE);
        expect(withTempo.some((p) => p.type === 'tempo')).toBe(true);

        const without = pairInstructions(reference, faster, TAKE, { suppressed: new Set(['tempo']) });
        expect(without.some((p) => p.type === 'tempo')).toBe(false);
        // The ASCII summary loses the section too, rather than printing a heading over nothing.
        expect(diffFrom(without, TAKE)).not.toContain('TEMPO');
    });

    it('admits a fallback diff only where it clears the same raw floor', () => {
        const under: InstructionDiff = {
            date: 12240,
            type: 'tempo',
            diffs: { bpm: { ref: 60, student: 62, delta: 2 } },
            magnitude: 2,
        };
        const over: InstructionDiff = {
            date: 12960,
            type: 'tempo',
            diffs: { bpm: { ref: 60, student: 67, delta: 7 } },
            magnitude: 7,
        };
        const peaks = pairInstructions(reference, reference, TAKE, { fallback: [under, over] });
        expect(peaks.map((p) => p.date)).toEqual([12960]);
    });

    it('keeps a fallback out of a window it does not fall in', () => {
        const outside: InstructionDiff = {
            date: 90000,
            type: 'tempo',
            diffs: { bpm: { ref: 60, student: 90, delta: 30 } },
            magnitude: 30,
        };
        expect(pairInstructions(reference, reference, TAKE, { fallback: [outside] })).toEqual([]);
    });
});

// ── the ASCII table's ornament column ────────────────────────────────────────────────────

describe('ornament styles', () => {
    it('answers what kind of figure a def describes, and nothing for a name it has never seen', () => {
        const styles = ornamentStylesOf(reference);
        // def_3a8bdcaa… carries both a `<temporalSpread>` and a `<dynamicsGradient>`.
        expect(styles('def_3a8bdcaa-62ae-44c6-b061-2dc897a49afa')).toEqual({
            temporalSpread: true,
            dynamicsGradient: true,
        });
        // def_3962e07d… carries only the spread.
        expect(styles('def_3962e07d-4bc3-4bfd-9db4-cc719293ad8a')).toEqual({
            temporalSpread: true,
            dynamicsGradient: false,
        });
        expect(styles('no-such-def')).toBeNull();
    });

    it('prints those tags in the ornament section of the summary', () => {
        const wider = new Mpm(alter(referenceText, 'temporalSpread', ['frameLength'], (v) => v * 3));
        const summary = diffFrom(
            pairInstructions(reference, wider, TAKE),
            TAKE,
            ornamentStylesOf(reference),
        );
        expect(summary).toContain('ORNAMENTS (arpeggio)');
        expect(summary).toMatch(/arpeggio(\+dyn-gradient)?/);
    });
});

// ── the seven names are one list ─────────────────────────────────────────────────────────

describe('the type vocabulary', () => {
    it('is the seven names the plan validator and the fitter share', () => {
        expect([...DIFF_TYPES]).toEqual([
            'tempo',
            'dynamics',
            'rubato',
            'articulation',
            'accentuationPattern',
            'ornament',
            'asynchrony',
        ]);
    });
});
