/**
 * DESIGN §5 test 10 — the sound — plus the two takes review-S5 finding 1 asked for.
 *
 * Three things are under test and they are different in kind:
 *
 * 1. **The caps hold.** Whatever espressivo computed, no attribute the demonstration writes may
 *    sit further than `EXAGGERATION_TUNING`'s `maxAbsDelta` from Grünfeld's own value, or
 *    outside `EXAGGERATION_SPEC`'s bounds — at any strength, including ones the plan validator
 *    would never let through.
 * 2. **The range is confined and the reference is pristine.** Every instruction outside the
 *    demonstration's range comes out byte-identical to the canonical reference.
 * 3. **The push is away from *this student*.** Two real takes, driven from MIDI through the
 *    matcher and the fitter: Grünfeld playing himself, where the counter-performance must be a
 *    near no-op, and a student 15 % too fast, where every tempo slot the demonstration touches
 *    must go *slower* — the direction the spoken cue names. That is the bias review-S5 found in
 *    the interim `mpm/exaggerate.ts`, which priced the editorial bake against the fitted
 *    student and pushed Grünfeld faster at four of six slots while saying *ruhiger*.
 *
 * Risk R9's "one local `Math.pow`" is the parity test: `transformInSpace` is not on espressivo's
 * barrel, so the closed form `μ·(x/μ)^s` is restated here and checked against what the engine
 * wrote. Risk R10's probe — whole-document exaggeration against a range-cut copy — is the last
 * test in the file.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    EXPRESSION_DIMENSION_CORRESPONDENCE,
    Mpm,
    allChildElements,
    canonicalMpm,
    exaggerateMpm,
    performMsmToData,
    weightedFactors,
    type Element,
} from 'espressivo';
import { describe, expect, it } from 'vitest';
import { implantLocal } from '../matcher';
import { measuredNotesFromPerformanceData, type MeasuredNote } from '../score/measured';
import { convert, perform } from '../services/mpmRenderer';
import { counterPerformance, allDimensions, spliceCapped, studentCenter } from './counter';
import { cutToRange } from './cut';
import { THRESHOLDS } from './diff';
import { evidenceForTake } from './evidence';
import type { Range, StructuredDiffEvent } from './types';

const load = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const mei = load('../../public/score.mei');
const referenceMpmText = load('../../public/performance.mpm');
const fittedReferenceMpmText = load('../../public/reference.fitted.mpm');
const scoreMsm = convert(mei);
const canonicalReference = canonicalMpm(referenceMpmText);

const scoreNotes: MeasuredNote[] = measuredNotesFromPerformanceData(
    performMsmToData({ msm: scoreMsm, mpm: referenceMpmText }, { expandOrnaments: false }),
);

/** Four bars, m5.1–m9.1 — the window every suite in this rewrite uses. */
const FOUR_BARS: Range = { from: 11520, to: 23040 };

/** The tuning table's ceilings, restated on purpose: changing the table must break this test. */
const MAX_ABS_DELTA: Record<string, Record<string, number>> = {
    dynamics: { volume: 12, 'transition.to': 12 },
    tempo: { bpm: 10, 'transition.to': 10 },
    articulation: { relativeDuration: 0.2, relativeVelocity: 0.2 },
    rubato: { intensity: 0.15 },
    ornament: { scale: 0.8, intensity: 0.25 },
    asynchrony: { 'milliseconds.offset': 40 },
    accentuationPattern: { scale: 0.6 },
};

const BOUNDS: Record<string, Record<string, [number, number]>> = {
    dynamics: { volume: [1, 127], 'transition.to': [1, 127] },
    tempo: { bpm: [10, 300], 'transition.to': [10, 300] },
    articulation: { relativeDuration: [0.1, 5], relativeVelocity: [0.1, 5] },
    rubato: { intensity: [0.01, 10] },
    ornament: { scale: [0.1, 20], intensity: [0.01, 10] },
    asynchrony: { 'milliseconds.offset': [-500, 500] },
    accentuationPattern: { scale: [0, 10] },
};

/** Which legacy type an element carries the attributes of, for the walk below. */
const TYPE_OF_ELEMENT: Record<string, string> = {
    tempo: 'tempo',
    dynamics: 'dynamics',
    rubato: 'rubato',
    accentuationPattern: 'accentuationPattern',
    asynchrony: 'asynchrony',
    articulation: 'articulation',
    ornament: 'ornament',
    articulationDef: 'articulation',
    temporalSpread: 'ornament',
};

type Reading = {
    element: string;
    type: string;
    date: number | null;
    values: Record<string, number>;
};

const num = (element: Element, name: string): number | null => {
    const raw = element.getAttributeValue(name);
    if (raw === null || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
};

/** Every element that carries a spliceable attribute, in document order. */
const readings = (mpmText: string): Reading[] => {
    const root = new Mpm(mpmText).getRootElement();
    const found: Reading[] = [];
    const walk = (element: Element): void => {
        const type = TYPE_OF_ELEMENT[element.getLocalName()];
        if (type) {
            const values: Record<string, number> = {};
            for (const attr of Object.keys(BOUNDS[type])) {
                const value = num(element, attr);
                if (value !== null) values[attr] = value;
            }
            found.push({ element: element.getLocalName(), type, date: num(element, 'date'), values });
        }
        for (const child of allChildElements(element)) walk(child);
    };
    if (root) walk(root);
    return found;
};

/** The reference and the counter-performance, element by element, in lockstep. */
const paired = (counter: string): { ref: Reading; got: Reading }[] => {
    const before = readings(canonicalReference);
    const after = readings(counter);
    expect(after).toHaveLength(before.length);
    return before.map((ref, index) => ({ ref, got: after[index] }));
};

/** One take, exactly as the browser makes it, and the evidence it produces. */
const takeOn = (mpmText: string, range: Range) => {
    const midi = perform(mei, mpmText, range);
    if (!midi) throw new Error('the take could not be rendered');
    const { notes, range: matched } = implantLocal(scoreNotes, midi, (range.from + range.to) / 2);
    const evidence = evidenceForTake({ notes, range: matched, scoreMsm, referenceMpmText, fittedReferenceMpmText });
    return { evidence, range: matched };
};

const counterFor = (
    range: Range,
    evidence: { levels: Parameters<typeof studentCenter>[0]; structuredDiff: StructuredDiffEvent[]; measuredTypes: readonly string[]; filled: readonly string[] },
    dimensions = allDimensions(),
): string =>
    counterPerformance({
        referenceMpmText,
        range,
        dimensions,
        center: studentCenter(evidence.levels),
        events: evidence.structuredDiff,
        measured: evidence.measuredTypes.filter((type) => evidence.filled.includes(type)),
    });

// ── 1. the caps ──────────────────────────────────────────────────────────────────────────

describe('the caps are ceilings, not targets', () => {
    /** An absurd push, computed by the engine itself, so nothing here mocks the maths. */
    const pushedHard = (): string => {
        const weights = Object.fromEntries(
            Object.keys(EXPRESSION_DIMENSION_CORRESPONDENCE).flatMap(
                (comparison) => EXPRESSION_DIMENSION_CORRESPONDENCE[comparison as keyof typeof EXPRESSION_DIMENSION_CORRESPONDENCE]
                    .map((expression) => [expression, 8]),
            ),
        ) as Record<string, number>;
        return exaggerateMpm(referenceMpmText, {
            factors: weightedFactors(2, weights),
            center: { tempo: 200, dynamics: 110 },
            velocityRange: { min: 1, max: 127 },
        }).mpm;
    };

    it('never moves an in-range attribute further than maxAbsDelta, however hard it was pushed', () => {
        const counter = spliceCapped(canonicalReference, pushedHard(), FOUR_BARS);

        let moved = 0;
        for (const { ref, got } of paired(counter)) {
            for (const [attr, refValue] of Object.entries(ref.values)) {
                const value = got.values[attr];
                expect(value).toBeDefined();
                if (value !== refValue) moved += 1;
                expect(
                    Math.abs(value - refValue),
                    `${ref.element}@${attr} at ${ref.date} moved ${Math.abs(value - refValue)}`,
                ).toBeLessThanOrEqual(MAX_ABS_DELTA[ref.type][attr] + 1e-9);
            }
        }
        // The test is only worth anything if something did move.
        expect(moved).toBeGreaterThan(10);
    });

    it('stays inside the renderable bounds', () => {
        const counter = spliceCapped(canonicalReference, pushedHard(), FOUR_BARS);

        for (const { ref, got } of paired(counter)) {
            for (const attr of Object.keys(ref.values)) {
                // Only what the demonstration *wrote*: the reference itself carries a couple of
                // values outside these bounds (a `@transition.to` of 9.5 bpm at the end of a
                // ritardando), and an attribute nothing pushed is never rewritten — which is
                // exactly what keeps an unmeasured dimension byte-identical.
                if (got.values[attr] === ref.values[attr]) continue;
                const [min, max] = BOUNDS[ref.type][attr];
                expect(Number.isFinite(got.values[attr])).toBe(true);
                expect(got.values[attr]).toBeGreaterThanOrEqual(min);
                expect(got.values[attr]).toBeLessThanOrEqual(max);
            }
        }
    });
});

// ── 2. range confinement and the pristine reference ──────────────────────────────────────

describe('range confinement', () => {
    const counter = spliceCapped(
        canonicalReference,
        exaggerateMpm(referenceMpmText, {
            factors: weightedFactors(2, { tempo: 0.5, dynamics: 0.5, rubato: 0.5, accentuation: 0.5, ornamentSpacing: 0.5, articulation: 0.5 }),
            center: { tempo: 90, dynamics: 80 },
        }).mpm,
        FOUR_BARS,
    );

    it('leaves every instruction outside the range byte-identical to the reference', () => {
        let outside = 0;
        for (const { ref, got } of paired(counter)) {
            if (ref.date === null) continue;
            if (ref.date >= FOUR_BARS.from && ref.date <= FOUR_BARS.to) continue;
            outside += 1;
            expect(got.values, `${ref.element} at ${ref.date}`).toEqual(ref.values);
        }
        expect(outside).toBeGreaterThan(100);
    });

    it('shapes instructions inside the range', () => {
        const inside = paired(counter).filter(({ ref }) =>
            ref.date !== null && ref.date >= FOUR_BARS.from && ref.date <= FOUR_BARS.to);
        expect(inside.length).toBeGreaterThan(10);
        expect(inside.some(({ ref, got }) =>
            Object.keys(ref.values).some((attr) => got.values[attr] !== ref.values[attr]))).toBe(true);
    });

    it('never touches the movement map — Grünfeld’s pedal survives the demonstration whole', () => {
        // Compared as values rather than as bytes: `canonicalMpm` and `Mpm.writeMpm` indent
        // differently, so a text comparison would be about the serializer, not the pedal.
        const movements = (text: string) => {
            const map = new Mpm(text).getPerformance(0)?.getGlobal()?.getDated()?.getMap('movementMap') ?? null;
            const rows: (number | null)[][] = [];
            for (let index = 0; index < (map?.size() ?? 0); index++) {
                const element = map!.getElement(index);
                if (element) rows.push([num(element, 'date'), num(element, 'position'), num(element, 'transition.to')]);
            }
            return rows;
        };
        expect(movements(counter).length).toBeGreaterThan(150);
        expect(movements(counter)).toEqual(movements(canonicalReference));
    });

    it('is deterministic: the same take twice is the same document', () => {
        const again = spliceCapped(
            canonicalReference,
            exaggerateMpm(referenceMpmText, {
                factors: weightedFactors(2, { tempo: 0.5, dynamics: 0.5, rubato: 0.5, accentuation: 0.5, ornamentSpacing: 0.5, articulation: 0.5 }),
                center: { tempo: 90, dynamics: 80 },
            }).mpm,
            FOUR_BARS,
        );
        expect(again).toBe(counter);
    });
});

// ── 3. the formula, restated (risk R9) ───────────────────────────────────────────────────

describe('the pivot is the student, and the formula is semantics 27’s', () => {
    /**
     * `transformInSpace` is exported from `src/expression/transforms.ts` but is not on
     * espressivo's barrel and not in `dist/index.d.ts` (DESIGN §2.1.1), so the closed form is
     * restated here — the one local `Math.pow` risk R9 budgets — and checked against the
     * engine's own writing.
     */
    const levelPivot = (x: number, mu: number, s: number): number => mu * Math.pow(x / mu, s);

    it('writes μ·(x/μ)^s for tempo, with μ the student’s own level', () => {
        const center = 72;
        const s = 1 + 0.2 * 0.35;
        const pushed = exaggerateMpm(referenceMpmText, {
            factors: weightedFactors(2, { tempo: s - 1 }),
            center: { tempo: center },
        }).mpm;

        const before = readings(canonicalReference).filter((r) => r.element === 'tempo');
        const after = readings(pushed).filter((r) => r.element === 'tempo');
        expect(before.length).toBeGreaterThan(50);
        for (const [index, ref] of before.entries()) {
            if (ref.values.bpm === undefined) continue;
            expect(after[index].values.bpm).toBeCloseTo(levelPivot(ref.values.bpm, center, s), 6);
        }
    });

    it('is exactly ref·(ref/student)^a — semantics 27 — because μ is the student', () => {
        // student·(ref/student)^(1+a) === ref·(ref/student)^a, the identity that lets espressivo
        // carry a pivot it has no parameter for.
        const student = 50;
        const ref = 115;
        const a = 0.2 * 0.35;
        expect(levelPivot(ref, student, 1 + a)).toBeCloseTo(ref * Math.pow(ref / student, a), 9);
    });

    it('aims at dimensions espressivo’s own correspondence agrees with', () => {
        const legacyToComparison: Record<string, keyof typeof EXPRESSION_DIMENSION_CORRESPONDENCE> = {
            tempo: 'tempo',
            dynamics: 'dynamics',
            rubato: 'rubato',
            articulation: 'articulation',
            accentuationPattern: 'accentuation',
            ornament: 'ornamentation',
            asynchrony: 'asynchrony',
        };
        const aimed: Record<string, string> = {
            tempo: 'tempo',
            dynamics: 'dynamics',
            rubato: 'rubato',
            articulation: 'articulation',
            accentuationPattern: 'accentuation',
            ornament: 'ornamentSpacing',
            asynchrony: 'asynchrony',
        };
        for (const [legacy, comparison] of Object.entries(legacyToComparison)) {
            expect(
                EXPRESSION_DIMENSION_CORRESPONDENCE[comparison] as readonly string[],
                `${legacy} aims outside its own correspondence`,
            ).toContain(aimed[legacy]);
        }
    });

    it('needs no beat-length normalisation, because the reference states one beat length', () => {
        // `center.tempo` is quarter-note bpm (`bpm · beatLength · 4`); the fitter copies the
        // reference's `@beatLength` into every slot, and every one of Grünfeld's is a quarter.
        const lengths = new Set(
            [...referenceMpmText.matchAll(/beatLength="([\d.]+)"/g)].map((match) => match[1]),
        );
        expect([...lengths]).toEqual(['0.25']);
    });
});

// ── 4. the two takes review-S5 asked for ─────────────────────────────────────────────────

describe('a take of Grünfeld playing himself', () => {
    const { evidence, range } = takeOn(referenceMpmText, FOUR_BARS);

    it('is measured as six dimensions fitted and few of them audible', () => {
        expect(evidence.filled.length).toBeGreaterThanOrEqual(5);
        // The gate is what keeps an identity take quiet; the numbers are S5 §7's.
        expect(evidence.measuredTypes.length).toBeLessThanOrEqual(3);
    });

    /**
     * The bias review-S5 found lived in the two **level** dimensions: the interim
     * `mpm/exaggerate.ts` priced the editorial bake against the fitted student and moved
     * `tempo_14400` from 83.2 to 85.0 on a take where the playing was identical. Those two are
     * where the identity take has to be silent, and the floor is the diff's own — 4 bpm,
     * 4 velocity.
     */
    it('leaves tempo and dynamics inaudibly close to Grünfeld’s own values', () => {
        const counter = counterFor(range, evidence);

        for (const { ref, got } of paired(counter)) {
            if (ref.type !== 'tempo' && ref.type !== 'dynamics') continue;
            for (const [attr, refValue] of Object.entries(ref.values)) {
                const delta = Math.abs(got.values[attr] - refValue);
                expect(
                    delta,
                    `${ref.type}@${attr} at ${ref.date} moved ${delta}, floor ${THRESHOLDS[attr]}`,
                ).toBeLessThan(THRESHOLDS[attr]);
            }
        }
    });

    /**
     * The rest is as quiet as the *evidence* is, which on this take is not silent: the fitter's
     * `<ornament @scale>` is unstable against the reference's own arpeggios (S5 §7, risk R3's
     * calibration item), so an identity take still reports two ornament findings — and the
     * demonstration honestly answers them. What it may not do is exceed a cap, or move toward
     * the student, or touch a dimension the take never measured (the test below).
     */
    it('answers only what the evidence said, within the caps and away from the student', () => {
        const counter = counterFor(range, evidence);
        const towards = new Map(evidence.structuredDiff.map(
            (event) => [event.type, Math.sign(event.studentValue - event.refValue)]));

        let moved = 0;
        for (const { ref, got } of paired(counter)) {
            for (const [attr, refValue] of Object.entries(ref.values)) {
                const delta = got.values[attr] - refValue;
                if (delta === 0) continue;
                moved += 1;
                expect(Math.abs(delta)).toBeLessThanOrEqual(MAX_ABS_DELTA[ref.type][attr] + 1e-9);
                const student = towards.get(ref.type) ?? 0;
                if (student !== 0) expect(Math.sign(delta)).not.toBe(student);
            }
        }
        expect(moved).toBeGreaterThan(0);
        expect(moved).toBeLessThan(60);
    });

    it('never shapes a dimension the take did not measure', () => {
        const measured: readonly string[] = evidence.measuredTypes.filter((type) => evidence.filled.includes(type));
        const counter = counterFor(range, evidence);

        for (const { ref, got } of paired(counter)) {
            if (measured.includes(ref.type)) continue;
            expect(got.values, `${ref.element} at ${ref.date} (${ref.type} was not measured)`).toEqual(ref.values);
        }
    });
});

describe('a student who hurries', () => {
    const hurried = referenceMpmText.replace(
        /bpm="([\d.]+)"/g,
        (_match, value: string) => `bpm="${(Number(value) * 1.15).toFixed(4)}"`,
    );
    const { evidence, range } = takeOn(hurried, FOUR_BARS);

    it('is heard as playing faster than Grünfeld', () => {
        const tempo = evidence.structuredDiff.filter((event) => event.type === 'tempo');
        expect(tempo.length).toBeGreaterThan(0);
        for (const event of tempo) {
            expect(event.studentValue).toBeGreaterThan(event.refValue);
            expect(event.direction).toBe('less');
            expect(event.cueText).toBe('ruhiger');
        }
    });

    it('is answered by a demonstration that goes slower at every tempo slot it touches', () => {
        const counter = counterFor(range, evidence);

        let touched = 0;
        for (const { ref, got } of paired(counter)) {
            if (ref.type !== 'tempo') continue;
            for (const attr of ['bpm', 'transition.to']) {
                const refValue = ref.values[attr];
                if (refValue === undefined || got.values[attr] === refValue) continue;
                touched += 1;
                expect(
                    got.values[attr],
                    `tempo@${attr} at ${ref.date} moved toward the student`,
                ).toBeLessThan(refValue);
            }
        }
        expect(touched).toBeGreaterThan(0);
    });

    it('holds every slot it touched inside the ±10 bpm cap', () => {
        const counter = counterFor(range, evidence);
        for (const { ref, got } of paired(counter)) {
            if (ref.type !== 'tempo') continue;
            for (const attr of ['bpm', 'transition.to']) {
                if (ref.values[attr] === undefined) continue;
                expect(Math.abs(got.values[attr] - ref.values[attr])).toBeLessThanOrEqual(10 + 1e-9);
            }
        }
    });
});

// ── 5. the plan's own vocabulary ─────────────────────────────────────────────────────────

describe('allDimensions', () => {
    it('covers every shapeable type at the default strength', () => {
        expect(allDimensions().map((dimension) => dimension.type)).toEqual([
            'dynamics', 'tempo', 'articulation', 'rubato', 'ornament', 'asynchrony', 'accentuationPattern',
        ]);
        expect(allDimensions().every((dimension) => dimension.strength === 0.2)).toBe(true);
    });

    it('does nothing at all when the plan named no dimension', () => {
        const counter = counterPerformance({
            referenceMpmText,
            range: FOUR_BARS,
            dimensions: [],
            center: { tempo: 72, dynamics: 55 },
        });
        expect(counter).toBe(canonicalReference);
    });

    it('ignores a type that is not shapeable, and an unusable strength', () => {
        const counter = counterPerformance({
            referenceMpmText,
            range: FOUR_BARS,
            dimensions: [{ type: 'phrasing', strength: 0.4 }, { type: 'tempo', strength: Number.NaN }],
            center: { tempo: 72, dynamics: 55 },
        });
        expect(counter).toBe(canonicalReference);
    });
});

// ── 6. risk R10's probe ──────────────────────────────────────────────────────────────────

describe('risk R10 — whole-document exaggeration against a range-cut copy', () => {
    it('agrees on every in-range attribute, because an explicit centre is population-free', () => {
        const factors = weightedFactors(2, {
            tempo: 0.35, dynamics: 0.45, rubato: 0.25, accentuation: 0.4, ornamentSpacing: 0.35, articulation: 0.5,
        });
        const center = { tempo: 72, dynamics: 55 };

        const whole = exaggerateMpm(referenceMpmText, { factors, center }).mpm;
        const cutFirst = exaggerateMpm(cutToRange(referenceMpmText, FOUR_BARS), { factors, center }).mpm;

        const wholeById = new Map(
            readings(whole)
                .filter((reading) => reading.date !== null)
                .map((reading) => [`${reading.element}::${reading.date}`, reading.values]),
        );

        let compared = 0;
        for (const reading of readings(cutFirst)) {
            if (reading.date === null) continue;
            if (reading.date < FOUR_BARS.from || reading.date > FOUR_BARS.to) continue;
            const fromWhole = wholeById.get(`${reading.element}::${reading.date}`);
            expect(fromWhole, `${reading.element} at ${reading.date} is missing from the whole-document run`).toBeDefined();
            for (const [attr, value] of Object.entries(reading.values)) {
                compared += 1;
                expect(value, `${reading.element}@${attr} at ${reading.date}`).toBeCloseTo(fromWhole![attr], 9);
            }
        }
        expect(compared).toBeGreaterThan(10);
    });
});
