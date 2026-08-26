/**
 * The counter-performance, per instruction — DESIGN §5 test 10, rewritten around the pivot the
 * design correction put in.
 *
 * Four things are under test and they are different in kind:
 *
 * 1. **An identity take is a no-op.** Not "small", not "under the floor": a student whose
 *    playing produces the same fitted numbers as the reference produces *no pair*, and a
 *    document with no pairs comes out attribute-for-attribute as it went in. That is the
 *    property review-S5's finding 1 asked for and the level pivot could only approximate.
 * 2. **Every dimension moves, and moves away from *this* student.** One altered take per
 *    dimension, rendered and fitted the way a real one is, each checked attribute by attribute:
 *    the sign is the opposite of the student's deviation, the magnitude grows with it, both
 *    halves of a slot move (`bpm` *and* `transition.to`), and nothing exceeds its cap. Rubato,
 *    which review-S6 measured at ten times under the threshold of hearing, has to clear the
 *    diff's own floor.
 * 3. **Nothing else moves.** Out of range, out of plan, out of the take's measured types, or
 *    reached by an instruction outside the range — untouched, by value, including Grünfeld's
 *    200-element pedal.
 * 4. **The caps are ceilings, not targets**, at any strength and against any pair.
 *
 * Two ways of making a take appear here, and they answer different questions. `takeOf` renders
 * the altered performance and fits the sounding notes directly — the cleanest statement of
 * "one dimension deviates". `takeThroughMidi` puts the same render through the MIDI encoder and
 * the matcher first, which is what the browser does and which adds the round trip's own noise;
 * it is the one review-S5's finding 5 asked for.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Mpm, allChildElements, performMsmToData, type Element } from 'espressivo';
import { describe, expect, it } from 'vitest';
import { extractNotesFromMidi, implantLocal } from '../matcher';
import { measuredNotesFromPerformanceData, type MeasuredNote } from '../score/measured';
import { convert, perform } from '../services/mpmRenderer';
import { takeEvidence } from './compare';
import { allDimensions, counterPerformance } from './counter';
import { THRESHOLDS } from './diff';
import { evidenceForTake } from './evidence';
import { alter } from './pair.test';
import { parseReferenceMpm } from './reference';
import { fitStudent } from '../student/fit';
import { readScaffold } from '../student/scaffold';
import type { InstructionDiff, Range } from './types';

const load = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const mei = load('../../public/score.mei');
const referenceMpmText = load('../../public/performance.mpm');
const scoreMsm = convert(mei);
const reference = parseReferenceMpm(referenceMpmText);

const scoreNotes: MeasuredNote[] = measuredNotesFromPerformanceData(
    performMsmToData({ msm: scoreMsm, mpm: referenceMpmText }, { expandOrnaments: false }),
);

/** Four bars, m5.1–m9.1 — the window every suite in this rewrite uses. */
const FOUR_BARS: Range = { from: 11520, to: 23040 };

/**
 * The table's ceilings and bounds, restated on purpose: changing `EXAGGERATION_SPEC` must break
 * this test rather than quietly widen the demonstration.
 */
const MAX_ABS_DELTA: Record<string, Record<string, number>> = {
    dynamics: { volume: 12, 'transition.to': 12 },
    tempo: { bpm: 10, 'transition.to': 10 },
    articulation: { relativeDuration: 0.2, relativeVelocity: 0.2 },
    rubato: { intensity: 0.15 },
    ornament: { scale: 2.0, intensity: 0.25, frameLength: 150 },
    asynchrony: { 'milliseconds.offset': 40 },
    accentuationPattern: { scale: 2.5 },
};

const BOUNDS: Record<string, Record<string, [number, number]>> = {
    dynamics: { volume: [1, 127], 'transition.to': [1, 127] },
    tempo: { bpm: [10, 300], 'transition.to': [10, 300] },
    articulation: { relativeDuration: [0.1, 5], relativeVelocity: [0.1, 5] },
    rubato: { intensity: [0.01, 10] },
    ornament: { scale: [0.1, 20], intensity: [0.01, 10], frameLength: [1, 720] },
    asynchrony: { 'milliseconds.offset': [-500, 500] },
    accentuationPattern: { scale: [0, 10] },
};

/** Which legacy type an element carries the attributes of, and which of them it states. */
const SITES: Record<string, { type: string; attrs: readonly string[] }> = {
    tempo: { type: 'tempo', attrs: ['bpm', 'transition.to'] },
    dynamics: { type: 'dynamics', attrs: ['volume', 'transition.to'] },
    rubato: { type: 'rubato', attrs: ['intensity', 'frameLength'] },
    accentuationPattern: { type: 'accentuationPattern', attrs: ['scale'] },
    asynchrony: { type: 'asynchrony', attrs: ['milliseconds.offset'] },
    articulation: { type: 'articulation', attrs: ['relativeDuration', 'relativeVelocity'] },
    ornament: { type: 'ornament', attrs: ['scale', 'intensity'] },
    articulationDef: { type: 'articulation', attrs: ['relativeDuration', 'relativeVelocity'] },
    // `frame.start` is not a spliceable attribute; it follows `frameLength` so that a narrowed
    // roll keeps its place around the beat, and the test below asserts exactly that coupling.
    temporalSpread: { type: 'ornament', attrs: ['intensity', 'frameLength', 'frame.start'] },
};

type Reading = {
    element: string;
    type: string;
    date: number | null;
    /** The def's `@name`, or the owning def's, for the header sites. */
    name: string | null;
    values: Record<string, number>;
};

const num = (element: Element, name: string): number | null => {
    const raw = element.getAttributeValue(name);
    if (raw === null || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
};

/** Every element that carries a writable attribute, in document order. */
const readings = (mpmText: string): Reading[] => {
    const root = new Mpm(mpmText).getRootElement();
    const found: Reading[] = [];
    const walk = (element: Element, defName: string | null): void => {
        const own = element.getAttributeValue('name');
        const site = SITES[element.getLocalName()];
        if (site) {
            const values: Record<string, number> = {};
            for (const attr of site.attrs) {
                const value = num(element, attr);
                if (value !== null) values[attr] = value;
            }
            found.push({
                element: element.getLocalName(),
                type: site.type,
                date: num(element, 'date'),
                name: own ?? defName,
                values,
            });
        }
        for (const child of allChildElements(element)) walk(child, own ?? defName);
    };
    if (root) walk(root, null);
    return found;
};

/** The reference as this module serialises it — the document a no-op comes back as. */
const untouched = counterPerformance({ referenceMpmText, range: FOUR_BARS, dimensions: [] });
const before = readings(untouched);

/** The reference and one counter-performance, element by element, in lockstep. */
const paired = (counter: string): { ref: Reading; got: Reading }[] => {
    const after = readings(counter);
    expect(after).toHaveLength(before.length);
    return before.map((ref, index) => ({ ref, got: after[index] }));
};

/** Every attribute one counter-performance actually wrote. */
const moved = (counter: string): { ref: Reading; attr: string; from: number; to: number }[] =>
    paired(counter).flatMap(({ ref, got }) =>
        Object.entries(ref.values)
            .filter(([attr, value]) => got.values[attr] !== value)
            .map(([attr, value]) => ({ ref, attr, from: value, to: got.values[attr] })),
    );

// ── the takes ────────────────────────────────────────────────────────────────────────────

type Take = { peaks: readonly InstructionDiff[]; measured: readonly string[]; range: Range };

/** Every take is built once: a render, a fit and a comparison are ~300 ms each. */
const takes = new Map<string, Take>();
const memoized = (key: string, build: () => Take): Take => {
    const found = takes.get(key);
    if (found) return found;
    const built = build();
    takes.set(key, built);
    return built;
};

/** Render, fit, compare: one take with one dimension altered, without the MIDI round trip. */
const takeOf = (mpmText: string, range: Range = FOUR_BARS): Take =>
    memoized(`fit:${range.from}:${range.to}:${mpmText}`, () => buildTakeOf(mpmText, range));

const buildTakeOf = (mpmText: string, range: Range): Take => {
    const played = measuredNotesFromPerformanceData(
        performMsmToData({ msm: scoreMsm, mpm: mpmText }, { expandOrnaments: false }),
    ).filter((note) => note.date >= range.from && note.date < range.to);
    const fit = fitStudent(played, readScaffold(reference, range), scoreMsm);
    // The comparison side, as `mpm/evidence.ts` computes it per take: Grünfeld through this
    // same fitter over this same window (there from MIDI; here from note data, like the take).
    const referenceFit = fitStudent(
        measuredNotesFromPerformanceData(
            performMsmToData({ msm: scoreMsm, mpm: referenceMpmText }, { expandOrnaments: false }),
        ).filter((note) => note.date >= range.from && note.date < range.to),
        readScaffold(reference, range),
        scoreMsm,
    );
    const evidence = takeEvidence({
        referenceMpmText: referenceFit.studentMpmText,
        studentMpmText: fit.studentMpmText,
        scoreMsm,
        range,
        skipped: fit.skipped,
    });
    return {
        peaks: evidence.peaks,
        measured: evidence.measuredTypes.filter((type) => fit.filled.has(type)),
        range,
    };
};

/** One take exactly as the browser makes it: MIDI out, matcher in, then the same evidence. */
const takeThroughMidi = (mpmText: string, range: Range = FOUR_BARS): Take =>
    memoized(`midi:${range.from}:${range.to}:${mpmText}`, () => buildTakeThroughMidi(mpmText, range));

const buildTakeThroughMidi = (mpmText: string, range: Range): Take => {
    const midi = perform(mei, mpmText, range);
    if (!midi) throw new Error('the take could not be rendered');
    const { notes, range: matched } = implantLocal(scoreNotes, midi, (range.from + range.to) / 2);
    const evidence = evidenceForTake({ notes, range: matched, scoreMsm, scoreNotes, referenceMpmText });
    return {
        peaks: evidence.peaks,
        measured: evidence.measuredTypes.filter((type) => evidence.filled.includes(type)),
        range: matched,
    };
};

const counterFor = (take: Take, dimensions = allDimensions()): string =>
    counterPerformance({
        referenceMpmText,
        range: take.range,
        dimensions,
        peaks: take.peaks,
        measured: take.measured,
    });

/** The deviation the take measured at one slot, as the demonstration reads it. */
const deviationAt = (take: Take, type: string, date: number, attr: string): number | undefined =>
    take.peaks.find((peak) => peak.type === type && peak.date === date)?.diffs[attr]?.delta;

/** One altered performance per dimension — S4 §4's six takes, plus the ornament's own weight. */
const ALTERED = {
    tempo: alter(referenceMpmText, 'tempo', ['bpm', 'transition.to'], (v) => v * 1.15),
    tempoMore: alter(referenceMpmText, 'tempo', ['bpm', 'transition.to'], (v) => v * 1.3),
    dynamics: alter(referenceMpmText, 'dynamics', ['volume', 'transition.to'], (v) => Math.max(1, v - 18)),
    rubato: alter(referenceMpmText, 'rubato', ['intensity'], (v) => v * 2),
    accentuation: alter(referenceMpmText, 'accentuationPattern', ['scale'], (v) => v * 10),
    ornamentFrame: alter(referenceMpmText, 'temporalSpread', ['frameLength'], (v) => v * 2),
    // ×0.25, not ×0.5: with Grünfeld fitted over the take's own window rather than over the
    // whole piece, halving the gradient measures 0.67 JND and the audibility gate rightly
    // silences it. Swept — 0.5 → 0.67, 0.35 → 0.87, 0.25 → 1.00 — this is the smallest of the
    // values that crosses one JND, which is the rule `mpm/compare.test.ts` sets for these
    // fixtures. The bias, not the alteration, used to carry the old magnitude over the line.
    ornamentScale: alter(referenceMpmText, 'ornament', ['scale'], (v) => v * 0.25),
    articulation: alter(referenceMpmText, 'articulationDef', ['relativeDuration'], (v) => v * 0.7),
};

// ── 1. the plan's vocabulary ─────────────────────────────────────────────────────────────

describe('allDimensions', () => {
    it('covers every shapeable type at the default strength', () => {
        expect(allDimensions().map((dimension) => dimension.type)).toEqual([
            'dynamics', 'tempo', 'articulation', 'rubato', 'ornament', 'asynchrony', 'accentuationPattern',
        ]);
        expect(allDimensions().every((dimension) => dimension.strength === 0.2)).toBe(true);
    });

    it('does nothing at all when the plan named no dimension', () => {
        expect(counterPerformance({ referenceMpmText, range: FOUR_BARS, dimensions: [] })).toBe(untouched);
    });

    it('ignores a type that is not shapeable, and an unusable strength', () => {
        expect(counterPerformance({
            referenceMpmText,
            range: FOUR_BARS,
            dimensions: [{ type: 'phrasing', strength: 0.4 }, { type: 'tempo', strength: Number.NaN }],
            peaks: takeOf(ALTERED.tempo).peaks,
        })).toBe(untouched);
    });

    it('serialises both return paths the same way, so “nothing changed” is byte-comparable', () => {
        // review-S6, finding 11: the two paths used two serializers, and a caller diffing the
        // texts to ask "did anything change?" got a false positive from the XML declaration.
        const shaped = counterFor(takeOf(ALTERED.tempo));
        expect(shaped).not.toBe(untouched);
        expect(shaped.slice(0, 40)).toBe(untouched.slice(0, 40));
        expect(shaped.split('\n')).toHaveLength(untouched.split('\n').length);
    });
});

// ── 2. the identity take ─────────────────────────────────────────────────────────────────

describe('a take of Grünfeld playing himself', () => {
    it('produces no pair at all, so no attribute of the demonstration moves', () => {
        const take = takeOf(referenceMpmText);
        expect(take.peaks).toEqual([]);
        expect(counterFor(take)).toBe(untouched);
    });

    it('is a no-op even with every dimension forced open at full strength', () => {
        // No gate, no plan restraint: the *pairs* are what a demonstration is made of, and an
        // identity take has none. This is semantics 27 as a structural property rather than a
        // measured smallness.
        const counter = counterPerformance({
            referenceMpmText,
            range: FOUR_BARS,
            dimensions: allDimensions(0.5),
            peaks: takeOf(referenceMpmText).peaks,
        });
        expect(counter).toBe(untouched);
    });

    /**
     * The same claim for the take the browser actually runs — through the MIDI encoder and the
     * matcher, not from note data.
     *
     * This used to move four attributes. The comparison side was then a document fitted from
     * note *data* over the whole piece, while a take arrives as MIDI over its own window, and
     * the fitter's `<ornament @scale>` and one window-edge tempo slot cleared their floors on
     * that difference alone. Grünfeld is now fitted per take through this very path
     * (`mpm/evidence.ts`), so a round trip of his own playing finds no pair at all — and a
     * demonstration with nothing to answer answers nothing.
     */
    it('leaves the document untouched when a real round trip found nothing to answer', () => {
        const take = takeThroughMidi(referenceMpmText);

        expect(take.peaks).toEqual([]);
        expect(take.measured).toEqual([]);
        expect(moved(counterFor(take))).toEqual([]);
    });

    it('leaves tempo and dynamics inaudibly close to Grünfeld’s own values', () => {
        const counter = counterFor(takeThroughMidi(referenceMpmText));
        for (const { ref, got } of paired(counter)) {
            if (ref.type !== 'tempo' && ref.type !== 'dynamics') continue;
            for (const [attr, refValue] of Object.entries(ref.values)) {
                const delta = Math.abs(got.values[attr] - refValue);
                expect(delta, `${ref.type}@${attr} at ${ref.date} moved ${delta}`).toBeLessThan(THRESHOLDS[attr]);
            }
        }
    });
});

// ── 3. one dimension at a time ───────────────────────────────────────────────────────────

describe('one dimension at a time', () => {
    const cases: { name: string; take: () => Take; type: string }[] = [
        { name: 'tempo ×1.15', take: () => takeOf(ALTERED.tempo), type: 'tempo' },
        { name: 'dynamics −18', take: () => takeOf(ALTERED.dynamics), type: 'dynamics' },
        { name: 'rubato ×2', take: () => takeOf(ALTERED.rubato), type: 'rubato' },
        { name: 'accentuation ×10', take: () => takeOf(ALTERED.accentuation), type: 'accentuationPattern' },
        { name: 'ornament frameLength ×2', take: () => takeOf(ALTERED.ornamentFrame), type: 'ornament' },
        { name: 'ornament scale ×0.5', take: () => takeOf(ALTERED.ornamentScale), type: 'ornament' },
    ];

    for (const { name, take: build, type } of cases) {
        describe(name, () => {
            const take = build();
            const counter = counterFor(take);
            const writes = moved(counter);

            it('shapes the dimension the take measured', () => {
                expect(take.measured).toContain(type);
                expect(writes.filter((write) => write.ref.type === type).length).toBeGreaterThan(0);
            });

            it('moves every attribute it writes away from the student, in proportion', () => {
                for (const { ref, attr, from, to } of writes) {
                    if (attr === 'frame.start') continue;
                    const deviation = ref.date === null
                        ? take.peaks.find((peak) => peak.nameRef === ref.name)?.diffs[attr]?.delta
                        : deviationAt(take, ref.type, ref.date, attr);
                    expect(deviation, `${ref.element}@${attr} at ${ref.date ?? ref.name}`).toBeDefined();
                    expect(Math.abs(deviation!)).toBeGreaterThanOrEqual(THRESHOLDS[attr]);
                    expect(
                        Math.sign(to - from),
                        `${ref.element}@${attr} at ${ref.date ?? ref.name} moved toward the student`,
                    ).toBe(-Math.sign(deviation!));
                }
            });

            it('stays inside every cap and every bound', () => {
                for (const { ref, attr, from, to } of writes) {
                    if (attr === 'frame.start') continue;
                    expect(
                        Math.abs(to - from),
                        `${ref.element}@${attr} at ${ref.date ?? ref.name} moved ${Math.abs(to - from)}`,
                    ).toBeLessThanOrEqual(MAX_ABS_DELTA[ref.type][attr] + 1e-9);
                    const [min, max] = BOUNDS[ref.type][attr];
                    expect(to).toBeGreaterThanOrEqual(min);
                    expect(to).toBeLessThanOrEqual(max);
                }
            });

            it('leaves every type the take did not measure exactly as it was', () => {
                for (const { ref, got } of paired(counter)) {
                    if (take.measured.includes(ref.type)) continue;
                    expect(got.values, `${ref.element} at ${ref.date ?? ref.name} (${ref.type} unmeasured)`).toEqual(ref.values);
                }
            });

            it('leaves every instruction outside the range exactly as it was', () => {
                let outside = 0;
                for (const { ref, got } of paired(counter)) {
                    if (ref.date === null) continue;
                    if (ref.date >= take.range.from && ref.date <= take.range.to) continue;
                    outside += 1;
                    expect(got.values, `${ref.element} at ${ref.date}`).toEqual(ref.values);
                }
                expect(outside).toBeGreaterThan(100);
            });
        });
    }

    it('moves both halves of a tempo slot — the level and the transition it is heading for', () => {
        // `StructuredDiffEvent` carries only a slot's *primary* attribute, so this is what the
        // per-attribute pairs bought (review-S6, findings 6 and 7).
        const writes = moved(counterFor(takeOf(ALTERED.tempo)));
        const slots = new Map<number | null, Set<string>>();
        for (const { ref, attr } of writes) {
            if (ref.type !== 'tempo') continue;
            slots.set(ref.date, (slots.get(ref.date) ?? new Set()).add(attr));
        }
        const both = [...slots.values()].filter((attrs) => attrs.has('bpm') && attrs.has('transition.to'));
        expect(both.length).toBeGreaterThan(3);
    });

    it('moves both halves of a dynamics slot', () => {
        const writes = moved(counterFor(takeOf(ALTERED.dynamics)));
        const slots = new Map<number | null, Set<string>>();
        for (const { ref, attr } of writes) {
            if (ref.type !== 'dynamics') continue;
            slots.set(ref.date, (slots.get(ref.date) ?? new Set()).add(attr));
        }
        const both = [...slots.values()].filter((attrs) => attrs.has('volume') && attrs.has('transition.to'));
        expect(both.length).toBeGreaterThan(3);
    });

    it('answers a doubled rubato audibly — over the diff’s own floor', () => {
        // review-S6, finding 10: at the legacy inner strength the same take was answered with
        // 0.023–0.040 of intensity against a floor of 0.1, so rubato was measured and could not
        // be demonstrated. The lever is the exponent, never the cap.
        const writes = moved(counterFor(takeOf(ALTERED.rubato)))
            .filter((write) => write.ref.type === 'rubato' && write.attr === 'intensity');
        expect(writes.length).toBeGreaterThan(2);
        const largest = Math.max(...writes.map((write) => Math.abs(write.to - write.from)));
        expect(largest).toBeGreaterThanOrEqual(THRESHOLDS.intensity);
        expect(largest).toBeLessThanOrEqual(MAX_ABS_DELTA.rubato.intensity + 1e-9);
    });

    it('writes `<ornament @scale>` itself — the loudest ornament finding on every take', () => {
        // review-S6, finding 2: aimed through espressivo's registry, `@scale` had no row and
        // could never move, so the ornament push came out as a change to the spacing curve.
        const writes = moved(counterFor(takeOf(ALTERED.ornamentScale)))
            .filter((write) => write.ref.element === 'ornament' && write.attr === 'scale');
        expect(writes.length).toBeGreaterThan(5);
        expect(Math.max(...writes.map((write) => Math.abs(write.to - write.from)))).toBeGreaterThanOrEqual(THRESHOLDS.scale);
    });

    it('narrows an over-wide roll and keeps it on its beat', () => {
        const counter = counterFor(takeOf(ALTERED.ornamentFrame));
        const spreads = paired(counter).filter(({ ref }) => ref.element === 'temporalSpread');
        const narrowed = spreads.filter(({ ref, got }) => got.values.frameLength !== ref.values.frameLength);
        expect(narrowed.length).toBeGreaterThan(3);
        for (const { ref, got } of narrowed) {
            expect(got.values.frameLength).toBeLessThan(ref.values.frameLength);
            if (ref.values['frame.start'] === undefined || ref.values['frame.start'] === 0) continue;
            // The offset is scaled with the length, so the roll keeps its shape around the beat.
            expect(got.values['frame.start'] / ref.values['frame.start']).toBeCloseTo(
                got.values.frameLength / ref.values.frameLength, 6);
        }
    });

    it('pushes further when the student is further away', () => {
        const near = moved(counterFor(takeOf(ALTERED.tempo))).filter((w) => w.ref.type === 'tempo');
        const far = moved(counterFor(takeOf(ALTERED.tempoMore))).filter((w) => w.ref.type === 'tempo');
        const bySlot = new Map(far.map((write) => [`${write.ref.date}::${write.attr}`, write]));

        let compared = 0;
        for (const write of near) {
            const other = bySlot.get(`${write.ref.date}::${write.attr}`);
            if (!other) continue;
            compared += 1;
            expect(
                Math.abs(other.to - other.from),
                `tempo@${write.attr} at ${write.ref.date} did not grow with the deviation`,
            ).toBeGreaterThan(Math.abs(write.to - write.from));
        }
        expect(compared).toBeGreaterThan(8);
    });

    it('says nothing about articulation, because nothing in this document can hear it', () => {
        // `performance.mpm`'s articulationMap declares no `<style>`, so `@name.ref` resolves to
        // nothing and scaling every `@relativeDuration` changes no sounding note (S4 §5). The
        // gate suppresses the type, there is no pair, and the demonstration is silent — which
        // is right. The test below shows the mechanism itself is not.
        const take = takeOf(ALTERED.articulation);
        expect(take.measured).not.toContain('articulation');
        expect(take.peaks.some((peak) => peak.type === 'articulation')).toBe(false);
        expect(counterFor(take)).toBe(untouched);
    });
});

// ── 3b. what the student actually hears ──────────────────────────────────────────────────

/**
 * The demonstration against `mode: 'reference'`, as sound.
 *
 * Every assertion above this point is on the *document*: which attribute moved, by how much, in
 * which direction, inside which cap. None of that says whether the student can hear it, and
 * `THRESHOLDS` — used as the yardstick until now — is the wrong instrument for the question: it
 * is the diff's per-instruction *measurement* floor, so it mis-ranks every time-domain dimension
 * upward and every velocity-domain one downward. A 0.65 bpm change is far under it and displaces
 * the passage by 171 ms; a ±0.6 accentuation scale is well over it and does not survive the
 * first note (final-pedagogy §1–2, DECISIONS 2026-08-26T20:22:18Z).
 *
 * So these render both documents over the same window and compare the MIDI: the counter-
 * performance against the plain reference, which is exactly the choice the plan makes between
 * `mode: 'exaggerated'` and `mode: 'reference'`. Notes are paired **by order** after sorting on
 * (onset, pitch), which is sound because the counter-performance only ever rewrites values —
 * it adds and removes nothing, and the pairing asserts the two renders agree on note count.
 */
type Audibility = {
    /** Largest onset difference, in milliseconds. */
    readonly maxOnsetMs: number;
    /** Root mean square of the onset differences, in milliseconds. */
    readonly rmsOnsetMs: number;
    /** Largest velocity difference, in MIDI velocity units. */
    readonly maxVelocity: number;
    /** Root mean square of the velocity differences. */
    readonly rmsVelocity: number;
    readonly notes: number;
};

const sortedNotes = (mpmText: string, range: Range) => {
    const midi = perform(mei, mpmText, range);
    if (!midi) throw new Error('the demonstration could not be rendered');
    return extractNotesFromMidi(midi)
        .slice()
        .sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
};

const audibility = (counterMpmText: string, range: Range = FOUR_BARS): Audibility => {
    const demo = sortedNotes(counterMpmText, range);
    const plain = sortedNotes(referenceMpmText, range);
    expect(demo.length, 'the demonstration lost or gained notes').toBe(plain.length);

    let maxOnsetMs = 0;
    let sumOnsetSq = 0;
    let maxVelocity = 0;
    let sumVelocitySq = 0;
    for (let index = 0; index < demo.length; index++) {
        const onsetMs = Math.abs(demo[index].onset - plain[index].onset) * 1000;
        const velocity = Math.abs(demo[index].velocity - plain[index].velocity);
        maxOnsetMs = Math.max(maxOnsetMs, onsetMs);
        maxVelocity = Math.max(maxVelocity, velocity);
        sumOnsetSq += onsetMs * onsetMs;
        sumVelocitySq += velocity * velocity;
    }
    const n = Math.max(1, demo.length);
    return {
        maxOnsetMs,
        rmsOnsetMs: Math.sqrt(sumOnsetSq / n),
        maxVelocity,
        rmsVelocity: Math.sqrt(sumVelocitySq / n),
        notes: demo.length,
    };
};

describe('audible at the default strength, measured on the render', () => {
    const report = (name: string, heard: Audibility): void => {
        console.log(
            `counter, ${name}: ${heard.notes} notes, onset max ${heard.maxOnsetMs.toFixed(1)} ms / `
            + `rms ${heard.rmsOnsetMs.toFixed(1)} ms, velocity max ${heard.maxVelocity.toFixed(2)} / `
            + `rms ${heard.rmsVelocity.toFixed(2)}`,
        );
    };

    it('displaces a hurried take’s passage by at least 100 ms', () => {
        const heard = audibility(counterFor(takeOf(ALTERED.tempo)));
        report('tempo x1.15', heard);
        expect(heard.maxOnsetMs).toBeGreaterThanOrEqual(100);
    });

    it('answers a quiet take by at least 3 velocity RMS', () => {
        // The row that moved: `dynamics @volume` inner strength 0.45 -> 1.0. At 0.45 this take was
        // answered with 1.8 velocity RMS — a demonstration inside the noise of a piano sample.
        const heard = audibility(counterFor(takeOf(ALTERED.dynamics)));
        report('dynamics -18', heard);
        expect(heard.rmsVelocity).toBeGreaterThanOrEqual(3);
    });

    /**
     * **The two `@scale` dimensions are still not audible, and this is the record of it.**
     *
     * The calibration widened their caps — `accentuationPattern @scale` 0.6 -> 2.5, `ornament
     * @scale` 0.8 -> 2.0 — on final-pedagogy's reading that the cap was the binding constraint
     * and ±2.5 / ±2.0 "would put both at ~4 velocity on their peaks". Measured on the render
     * afterwards, that estimate does not hold. Before and after, at the default strength:
     *
     * | take | before | after | target |
     * |---|---|---|---|
     * | accentuation x10 | 1 vel peak / 0.236 RMS | 1 vel peak / **0.272** RMS | 3 vel peak |
     * | ornament scale x0.25 | 1 vel peak / 0.333 RMS | 1 vel peak / **0.333** RMS | 3 vel peak |
     *
     * The cap stopped binding and the *exponent* started: the natural push at
     * `a = 0.2 x 0.4 = 0.08` is 0.86 for accentuation (was clipped to 0.6) and 0.82 for ornament
     * (was clipped to 0.8, so that row's sound did not change at all). Sweeping the inner
     * strength to saturation — 2.0, 4.0, 8.0, all identical, i.e. against the new cap — gives a
     * **ceiling of 3 velocity for accentuation and 2 for ornament @scale**. So 3 velocity is
     * reachable for accentuation only by also raising its inner strength to ~2.0, which would
     * make every measurable deviation saturate the cap and cost the demonstration its sense of
     * magnitude; and for `ornament @scale` it is **not reachable inside a ±2.0 cap at any
     * strength**. Both are one more constants row and Niels' call, so the assertions below pin
     * what the shipped table actually does rather than a target it does not meet.
     */
    it('answers an over-accented take, though still under the 3-velocity target', () => {
        const heard = audibility(counterFor(takeOf(ALTERED.accentuation)));
        report('accentuation x10', heard);
        // A real, if small, effect — and a guard against the dimension going silent altogether.
        expect(heard.maxVelocity).toBeGreaterThanOrEqual(1);
        expect(heard.rmsVelocity).toBeGreaterThan(0.25);
    });

    it('answers a flattened arpeggio, though still under the 3-velocity target', () => {
        const heard = audibility(counterFor(takeOf(ALTERED.ornamentScale)));
        report('ornament scale x0.25', heard);
        expect(heard.maxVelocity).toBeGreaterThanOrEqual(1);
        expect(heard.rmsVelocity).toBeGreaterThan(0.3);
    });

    it('writes further than the old cap allowed, which is what the widening bought', () => {
        // The document side of the two rows above: the widened caps are load-bearing on the
        // accentuation row (0.60 clipped -> 0.86 natural) and marginal on the ornament one
        // (0.80 clipped -> 0.82 natural). Without this the cap change would be invisible to
        // every test in the file, since the render cannot yet tell the difference.
        const largest = (take: Take, type: string): number => Math.max(
            ...moved(counterFor(take))
                .filter((write) => write.ref.type === type && write.attr === 'scale')
                .map((write) => Math.abs(write.to - write.from)),
        );

        expect(largest(takeOf(ALTERED.accentuation), 'accentuationPattern')).toBeGreaterThan(0.6);
        expect(largest(takeOf(ALTERED.ornamentScale), 'ornament')).toBeGreaterThan(0.8);
    });

    it('answers an over-wide roll by at least 20 ms', () => {
        // The row that moved: `ornament @frameLength` inner strength 0.35 -> 2.0. At 0.35 the
        // rolls narrowed by 4 ms RMS, which is nothing.
        const heard = audibility(counterFor(takeOf(ALTERED.ornamentFrame)));
        report('ornament frameLength x2', heard);
        expect(heard.maxOnsetMs).toBeGreaterThanOrEqual(20);
    });

    it('says nothing at all on an identity take, in sound as in bytes', () => {
        const heard = audibility(counterFor(takeOf(referenceMpmText)));
        expect(heard.maxOnsetMs).toBe(0);
        expect(heard.maxVelocity).toBe(0);
    });
});

// ── 4. the definitions ───────────────────────────────────────────────────────────────────

describe('attributes that live on a definition', () => {
    /** An in-range `<articulation>` and the def it names, from the reference itself. */
    const inRangeArticulation = (): { date: number; nameRef: string } => {
        const map = reference.getPerformance(0)?.getGlobal()?.getDated()?.getMap('articulationMap');
        const dates = new Map<string, number[]>();
        for (let index = 0; index < (map?.size() ?? 0); index++) {
            const element = map!.getElement(index);
            const nameRef = element?.getAttributeValue('name.ref');
            const date = element ? num(element, 'date') : null;
            if (!nameRef || date === null) continue;
            dates.set(nameRef, [...(dates.get(nameRef) ?? []), date]);
        }
        for (const [nameRef, seen] of dates) {
            if (seen.every((date) => date >= FOUR_BARS.from && date <= FOUR_BARS.to)) {
                return { date: seen[0], nameRef };
            }
        }
        throw new Error('the reference has no articulation def local to the demo range');
    };

    const articulationPair = (student: number): InstructionDiff[] => {
        const { date, nameRef } = inRangeArticulation();
        return [{
            date,
            type: 'articulation',
            nameRef,
            diffs: { relativeDuration: { ref: 1, student, delta: student - 1 } },
            magnitude: Math.abs(student - 1),
        }];
    };

    /**
     * review-S6, finding 4: aimed through one exponent per type, articulation could not move at
     * all — at any strength, in either student direction — because the sign was read off the
     * fitted document and applied to editorial values on the other side of their neutral.
     */
    it('moves an `<articulationDef>`, in both student directions', () => {
        for (const [student, expected] of [[2, -1], [0.5, +1]] as const) {
            const counter = counterPerformance({
                referenceMpmText,
                range: FOUR_BARS,
                dimensions: [{ type: 'articulation', strength: 0.2 }],
                peaks: articulationPair(student),
                measured: ['articulation'],
            });
            const writes = moved(counter);
            expect(writes.length, `student=${student}`).toBe(1);
            expect(writes[0].ref.element).toBe('articulationDef');
            expect(writes[0].attr).toBe('relativeDuration');
            expect(Math.sign(writes[0].to - writes[0].from)).toBe(expected);
            expect(Math.abs(writes[0].to - writes[0].from)).toBeLessThanOrEqual(MAX_ABS_DELTA.articulation.relativeDuration + 1e-9);
        }
    });

    /**
     * review-S6, finding 13: def keys carried no style-collection scoping, so two `<styleDef>`s
     * in one collection sharing a def name would splice whichever the reader reached first —
     * silently, and possibly not the one the renderer resolves.
     */
    const TWO_STYLE_DEFS = `<mpm>
  <performance name="two" pulsesPerQuarter="720">
    <global>
      <header>
        <articulationStyles>
          <styleDef name="first"><articulationDef name="legato" relativeDuration="2"></articulationDef></styleDef>
          <styleDef name="second"><articulationDef name="legato" relativeDuration="3"></articulationDef></styleDef>
        </articulationStyles>
      </header>
      <dated>
        <articulationMap>
          <articulation xml:id="articulation_720" date="720" name.ref="legato" noteid="#n1"></articulation>
        </articulationMap>
      </dated>
    </global>
  </performance>
</mpm>`;

    const twoStyleDefsCounter = (text: string, peaks: InstructionDiff[]): number[] => {
        const counter = counterPerformance({
            referenceMpmText: text,
            range: { from: 0, to: 1440 },
            dimensions: [{ type: 'articulation', strength: 0.5 }],
            peaks,
            measured: ['articulation'],
        });
        return readings(counter)
            .filter((r) => r.element === 'articulationDef')
            .map((r) => r.values.relativeDuration);
    };

    const legatoPair = (date: number): InstructionDiff[] => [{
        date,
        type: 'articulation',
        nameRef: 'legato',
        diffs: { relativeDuration: { ref: 1, student: 2, delta: 1 } },
        magnitude: 1,
    }];

    it('writes the def the reference resolves to, and only that one', () => {
        const [first, second] = twoStyleDefsCounter(TWO_STYLE_DEFS, legatoPair(720));
        expect(first).toBeLessThan(2);
        expect(second).toBe(3);
    });

    it('never touches a def an instruction outside the range also reaches', () => {
        // Semantics 31, strictly: a `<style>`-scoped `legato` shared with bar 20 cannot be
        // touched for a demo of bars 5-8 without changing how bar 20 sounds. Every referrer
        // counts, whatever type the plan named.
        const shared = TWO_STYLE_DEFS.replace(
            '</articulationMap>',
            '<articulation xml:id="articulation_5760" date="5760" name.ref="legato" noteid="#n2"></articulation></articulationMap>',
        );
        expect(twoStyleDefsCounter(shared, legatoPair(720))).toEqual([2, 3]);
    });

    it('cannot be kept in range by a referrer with no date, because there is no such referrer', () => {
        // review-S6, finding 14, answered one level below this module: `Mpm` drops an
        // instruction that states no `@date`, so it never reaches the map `defsInRange` walks.
        // A def *only* such an instruction names therefore has no referrer at all and is left
        // alone, which is the same answer from the other side. `defsInRange` states the rule
        // anyway rather than resting on a parser it does not own.
        const dateless = TWO_STYLE_DEFS.replace(
            '<articulation xml:id="articulation_720" date="720" name.ref="legato" noteid="#n1"></articulation>',
            '<articulation xml:id="articulation_x" name.ref="legato" noteid="#n1"></articulation>',
        );
        const map = new Mpm(dateless).getPerformance(0)?.getGlobal()?.getDated()?.getMap('articulationMap');
        expect(map?.size() ?? 0).toBe(0);
        expect(twoStyleDefsCounter(dateless, legatoPair(720))).toEqual([2, 3]);
    });
});

// ── 5. the caps are ceilings, not targets ────────────────────────────────────────────────

describe('the caps', () => {
    /** An absurd deviation in every dimension, at the largest strength the plan may ask for. */
    const absurd = (): string => {
        const peaks: InstructionDiff[] = [];
        for (const { ref } of paired(untouched)) {
            if (ref.date === null || ref.date < FOUR_BARS.from || ref.date > FOUR_BARS.to) continue;
            const diffs: Record<string, { ref: number; student: number; delta: number }> = {};
            for (const attr of Object.keys(MAX_ABS_DELTA[ref.type])) {
                diffs[attr] = { ref: 1, student: 400, delta: 399 };
            }
            peaks.push({ date: ref.date, type: ref.type, nameRef: ref.name ?? undefined, diffs, magnitude: 399 });
        }
        return counterPerformance({
            referenceMpmText,
            range: FOUR_BARS,
            dimensions: allDimensions(9),
            peaks,
        });
    };

    it('never moves an attribute further than its maxAbsDelta, however far the student was', () => {
        const writes = moved(absurd());
        expect(writes.length).toBeGreaterThan(10);
        for (const { ref, attr, from, to } of writes) {
            if (attr === 'frame.start') continue;
            expect(
                Math.abs(to - from),
                `${ref.element}@${attr} at ${ref.date ?? ref.name} moved ${Math.abs(to - from)}`,
            ).toBeLessThanOrEqual(MAX_ABS_DELTA[ref.type][attr] + 1e-9);
        }
    });

    it('stays inside the renderable bounds', () => {
        for (const { ref, attr, to } of moved(absurd())) {
            if (attr === 'frame.start') continue;
            const [min, max] = BOUNDS[ref.type][attr];
            expect(Number.isFinite(to)).toBe(true);
            expect(to).toBeGreaterThanOrEqual(min);
            expect(to).toBeLessThanOrEqual(max);
        }
    });

    it('clamps the plan’s strength on both sides', () => {
        const peaks = takeOf(ALTERED.tempo).peaks;
        const shape = (strength: number): string =>
            counterPerformance({
                referenceMpmText, range: FOUR_BARS, peaks,
                dimensions: [{ type: 'tempo', strength }],
            });
        expect(shape(0.0001)).toBe(shape(0.05));
        expect(shape(9)).toBe(shape(0.5));
        expect(shape(0.05)).not.toBe(shape(0.5));
    });
});

// ── 6. what the demonstration must never touch ───────────────────────────────────────────

describe('range confinement and the pristine reference', () => {
    const counter = counterFor(takeOf(ALTERED.tempo));

    it('never touches the movement map — Grünfeld’s pedal survives the demonstration whole', () => {
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
        expect(movements(counter)).toEqual(movements(untouched));
    });

    it('cannot mutate the caller’s document, because it never holds one', () => {
        const first = counterFor(takeOf(ALTERED.tempo));
        expect(counterPerformance({ referenceMpmText, range: FOUR_BARS, dimensions: [] })).toBe(untouched);
        expect(first).toBe(counter);
    });
});

describe('determinism and cost', () => {
    it('gives the same bytes for the same take, twice', () => {
        const take = takeOf(ALTERED.dynamics);
        expect(counterFor(take)).toBe(counterFor(take));
    });

    it('costs under 50 ms for an eight-bar demonstration', () => {
        const eightBars: Range = { from: 11520, to: 34560 };
        const take = takeOf(ALTERED.tempo, eightBars);
        counterFor(take); // warm the parser
        const started = performance.now();
        counterFor(take);
        const elapsed = performance.now() - started;
        expect(elapsed, `counter-performance took ${elapsed.toFixed(1)} ms`).toBeLessThan(50);
    });
});
