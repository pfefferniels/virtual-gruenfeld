/**
 * The comparison layer, measured on takes that are Grünfeld's own performance with one thing
 * changed.
 *
 * Each take is made the way a real one is: alter one attribute of `performance.mpm`, **render**
 * that document to sounding notes, and hand the notes to the fitter as if a student had played
 * them. Nothing is asserted about a hand-written MPM; everything is asserted about a
 * performance that was actually produced and then measured back.
 *
 * DESIGN §5 tests 3 (the identity take, now against the fitted reference), 4 (six altered
 * dimensions), 5 (rubato/tempo separation at the diff's level) and 8 (positions and the
 * anacrusis) live here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Mpm, performMsmToData } from 'espressivo';
import { describe, expect, it } from 'vitest';
import { measuredNotesFromPerformanceData, type MeasuredNote } from '../score/measured';
import { convert } from '../services/mpmRenderer';
import { PPQ, tickToPos } from '../shared/constants';
import { fitStudent } from '../student/fit';
import { readScaffold } from '../student/scaffold';
import {
    A_IS_STUDENT,
    DIMENSION_OF,
    JND_FLOOR,
    TAKE_WEIGHTS,
    audibilityGate,
    crossCheckDirections,
    localisationHeader,
    profileFallback,
    SUB_THRESHOLD_CEILING,
    takeEvidence,
    type SkippedSlot,
    type TakeEvidence,
    type TakeEvidenceInput,
} from './compare';
import { alter } from './pair.test';
import { pairInstructions } from './pair';
import { parseReferenceMpm } from './reference';
import type { Range } from './types';

const load = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const referenceText = load('../../public/performance.mpm');
const fittedText = load('../../public/reference.fitted.mpm');
const scoreMsm = convert(load('../../public/score.mei'));
const reference = parseReferenceMpm(referenceText);

/** The four-bar take every suite in this rewrite uses: m5.1 to m9.1. */
const TAKE: Range = { from: 11520, to: 23040 };
/** The whole piece — where the identity take is exact rather than merely small. */
const WHOLE: Range = { from: 0, to: 92160 };

/** One performance, played and measured back, over one window. */
const playedFrom = (mpmText: string, range: Range): MeasuredNote[] =>
    measuredNotesFromPerformanceData(
        performMsmToData({ msm: scoreMsm, mpm: mpmText }, { expandOrnaments: false }),
    ).filter((note) => note.date >= range.from && note.date < range.to);

/** A whole take: alter, render, fit, compare, pair, diff. */
const takeOf = (mpmText: string, range: Range = TAKE): TakeEvidence => {
    const fit = fitStudent(playedFrom(mpmText, range), readScaffold(reference, range), scoreMsm);
    const input: TakeEvidenceInput = {
        referenceMpmText: fittedText,
        studentMpmText: fit.studentMpmText,
        scoreMsm,
        range,
        skipped: fit.skipped,
    };
    return takeEvidence(input);
};

const countByType = (evidence: TakeEvidence): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const event of evidence.structuredDiff) counts[event.type] = (counts[event.type] ?? 0) + 1;
    return counts;
};

// ── DESIGN §5 test 3: the identity take, against the fitted reference ────────────────────

describe('the identity take', () => {
    it('says nothing at all when the whole piece is played back (risk R2, answered)', () => {
        // The strongest statement available: `reference.fitted.mpm` *is* this fit, so a student
        // who plays Grünfeld's roll exactly produces the reference document itself and the
        // subtraction is zero everywhere. Against the editorial `performance.mpm` the same take
        // produced 22 bpm of tempo difference and 9.2 JND — the bias this file exists to remove.
        const evidence = takeOf(referenceText, WHOLE);
        expect(evidence.peaks).toEqual([]);
        expect(evidence.structuredDiff).toEqual([]);
        expect(evidence.report.aggregate.mean).toBe(0);
        expect(evidence.report.segments).toEqual([]);
        expect(evidence.diffSummary).toContain('No significant differences found.');
    });

    it('says nothing on a four-bar take either, and states what is left over', () => {
        const evidence = takeOf(referenceText, TAKE);
        expect(evidence.structuredDiff).toEqual([]);
        expect(evidence.peaks).toEqual([]);

        // What the gate had to absorb. A take is fitted over its own window while the reference
        // was fitted over the whole piece, so the slots at the window's edges — and the
        // per-def medians articulation takes over "the notes in range" — do not land on exactly
        // the same numbers. Committed, so that a change to either fitter has to restate it:
        // every dimension stays under one JND, which is what makes the gate silence them.
        const means = Object.fromEntries(
            Object.entries(evidence.report.dimensions).map(([k, d]) => [k, d.mean ?? 0]),
        );
        expect(means.tempo).toBeLessThan(0.6);
        expect(means.dynamics).toBeLessThan(0.2);
        expect(means.rubato).toBeLessThan(0.2);
        expect(means.accentuation).toBeLessThan(0.2);
        expect(means.ornamentation).toBeLessThan(0.6);
        expect(evidence.report.aggregate.mean).toBeLessThan(1.5);
        for (const type of ['tempo', 'dynamics', 'rubato', 'accentuationPattern', 'ornament'] as const) {
            expect(evidence.suppressed.has(type)).toBe(true);
        }

        // Ungated, the leftovers are three instructions at the window's own edge — the number
        // the gate is measured against.
        const ungated = pairInstructions(new Mpm(fittedText), new Mpm(
            fitStudent(playedFrom(referenceText, TAKE), readScaffold(reference, TAKE), scoreMsm).studentMpmText,
        ), TAKE);
        expect(ungated).toHaveLength(3);
        expect(new Set(ungated.map((p) => p.type))).toEqual(new Set(['articulation', 'accentuationPattern']));
        expect(new Set(ungated.map((p) => p.date))).toEqual(new Set([11520, 11880]));
    });

    it('localises nothing, because there is nothing it may speak about', () => {
        const evidence = takeOf(referenceText, TAKE);
        // A take under threshold still has segments — they are cut out of the aggregate
        // density, which is never exactly zero, and here they are the two window edges. What
        // the header must not do is print bar numbers for a difference the gate has silenced.
        expect(evidence.report.segments.length).toBeGreaterThan(0);
        expect(localisationHeader(evidence.report, TAKE, evidence.suppressed).split('\n')).toHaveLength(1);
        expect(evidence.measuredTypes).toEqual([]);
        expect(evidence.disagreements).toEqual([]);
    });
});

// ── DESIGN §5 test 4: one dimension at a time ────────────────────────────────────────────

describe('a take with one dimension altered', () => {
    /**
     * Five of DESIGN's six, at the magnitudes at which they are actually audible.
     *
     * DESIGN's own figures were a guess at that, and two of them are below the just-noticeable
     * difference: a rubato scaled ×1.5 measures 0.95 JND and an accentuation `@scale` doubled
     * measures 0.12 — the gate silences both, correctly. The magnitudes here are the smallest
     * of the swept values that cross one JND. The sixth, articulation, is its own case below.
     */
    const cases = [
        {
            name: 'tempo ×1.15',
            take: () => alter(referenceText, 'tempo', ['bpm', 'transition.to'], (v) => v * 1.15),
            type: 'tempo',
            attrs: ['bpm', 'transition.to'],
            direction: 'less' as const,
            cues: ['ruhiger'],
            sign: 1,
        },
        {
            name: 'dynamics −18 velocity',
            take: () => alter(referenceText, 'dynamics', ['volume', 'transition.to'], (v) => Math.max(1, v - 18)),
            type: 'dynamics',
            attrs: ['volume', 'transition.to'],
            direction: 'more' as const,
            cues: ['lauter', 'mehr Crescendo'],
            sign: -1,
        },
        {
            name: 'rubato intensity ×2',
            take: () => alter(referenceText, 'rubato', ['intensity'], (v) => v * 2),
            type: 'rubato',
            attrs: ['intensity'],
            direction: 'less' as const,
            cues: ['ruhiger im Puls'],
            sign: 1,
        },
        {
            name: 'accentuation scale ×10',
            take: () => alter(referenceText, 'accentuationPattern', ['scale'], (v) => v * 10),
            type: 'accentuationPattern',
            attrs: ['scale'],
            direction: 'less' as const,
            cues: ['weniger betonen'],
            sign: 1,
        },
        {
            name: 'ornament frameLength ×2',
            take: () => alter(referenceText, 'temporalSpread', ['frameLength'], (v) => v * 2),
            type: 'ornament',
            attrs: ['frameLength'],
            direction: 'less' as const,
            cues: ['naeher zusammen'],
            sign: 1,
        },
    ] as const;

    it.each(cases.map((c) => [c.name, c] as const))(
        '%s is named, in the right direction, with the right cue',
        (_name, testCase) => {
            const evidence = takeOf(testCase.take());
            const events = evidence.structuredDiff.filter((event) => event.type === testCase.type);

            expect(evidence.suppressed.has(testCase.type)).toBe(false);
            expect(events.length).toBeGreaterThan(0);
            // `PER_TYPE_TOP_N = 3` is the cap that keeps the teacher from reciting (risk R8).
            expect(events.length).toBeLessThanOrEqual(3);

            for (const event of events) {
                expect(testCase.attrs).toContain(event.primaryAttr);
                expect(event.direction).toBe(testCase.direction);
                expect(testCase.cues).toContain(event.cueText);
                expect(['slight', 'mod', 'large']).toContain(event.severity);
                expect(Math.sign(event.studentValue - event.refValue)).toBe(testCase.sign);
                expect(event.position).toBe(tickToPos(event.date));
            }
        },
    );

    it.each(cases.map((c) => [c.name, c] as const))(
        '%s leaves the dimension it did not touch alone',
        (_name, testCase) => {
            const evidence = takeOf(testCase.take());
            // Dynamics is the one dimension nothing else leaks into: a tempo, a rubato, a roll
            // and a metrical accent all move onsets or the residual velocity around, but only a
            // dynamics change moves the level.
            if (testCase.type !== 'dynamics' && testCase.type !== 'accentuationPattern') {
                expect(evidence.suppressed.has('dynamics')).toBe(true);
            }
            expect(evidence.suppressed.has('asynchrony')).toBe(true);
            expect(evidence.disagreements).toEqual([]);
        },
    );

    it('caps the whole take at three findings per type', () => {
        const everything = alter(
            alter(referenceText, 'tempo', ['bpm', 'transition.to'], (v) => v * 1.15),
            'dynamics',
            ['volume', 'transition.to'],
            (v) => Math.max(1, v - 18),
        );
        const counts = countByType(takeOf(everything));
        for (const [, n] of Object.entries(counts)) expect(n).toBeLessThanOrEqual(3);
        expect(counts.tempo).toBeGreaterThan(0);
        expect(counts.dynamics).toBeGreaterThan(0);
    });

    /**
     * The sixth dimension, and why it cannot have a take.
     *
     * `performance.mpm`'s `articulationMap` declares no `<style>`, so `@name.ref` resolves to
     * nothing: the 47 `<articulation>` elements name 26 defs that neither the renderer nor
     * `compareMpm` ever looks up. Scaling every `@relativeDuration` by 0.7 therefore changes not
     * one sounding note, and there is no student who can differ from Grünfeld in articulation
     * because Grünfeld's document does not sound its own. The gate suppresses the type on every
     * take, which is exactly right — a difference nobody can hear is not evidence.
     *
     * Committed as a test because it is a property of the *document*, fixable there (one
     * `<style name.ref="performance_style">` in the map) and nowhere in this code.
     */
    it('articulation ×0.7 changes no sounding note, and is suppressed on every take', () => {
        const altered = alter(referenceText, 'articulationDef', ['relativeDuration'], (v) => v * 0.7);
        expect(altered).not.toBe(referenceText);

        const before = playedFrom(referenceText, WHOLE);
        const after = new Map(playedFrom(altered, WHOLE).map((note) => [note['xml:id'], note]));
        const moved = before.filter((note) => {
            const played = after.get(note['xml:id']);
            if (!played) return false;
            const one = note['milliseconds.date.end'] - note['milliseconds.date'];
            const other = played['milliseconds.date.end'] - played['milliseconds.date'];
            return Math.abs(one - other) > 0.5;
        });
        expect(moved).toHaveLength(0);
        expect(referenceText).not.toMatch(/<articulationMap>\s*<style/);

        const evidence = takeOf(altered);
        expect(evidence.report.dimensions.articulation.mean).toBe(0);
        expect(evidence.suppressed.get('articulation')?.reason).toContain('under one');
        expect(evidence.structuredDiff.filter((e) => e.type === 'articulation')).toEqual([]);
    });
});

// ── DESIGN §5 test 5: rubato and tempo, at the diff's level ──────────────────────────────

describe('rubato against tempo (risk R5)', () => {
    it('names the rubato, and states how much of it still reads as tempo', () => {
        const evidence = takeOf(alter(referenceText, 'rubato', ['intensity'], (v) => v * 2));
        const counts = countByType(evidence);

        expect(counts.rubato).toBeGreaterThanOrEqual(2);
        for (const event of evidence.structuredDiff.filter((e) => e.type === 'rubato')) {
            expect(event.primaryAttr).toBe('intensity');
            expect(event.studentValue).toBeGreaterThan(event.refValue);
        }

        // The leak, committed. A rubato warp *is* a local tempo change, so doubling every
        // `@intensity` moves the tempo curve too — the two dimensions share the onsets they are
        // both read from, and neither fitter nor comparison can fully separate them. What the
        // rewrite guarantees is that the rubato is named at all, which the old pipeline could
        // not do: it never wrote a `<rubato>` for the student.
        expect(evidence.report.dimensions.rubato.mean ?? 0).toBeGreaterThan(JND_FLOOR);
        expect(counts.tempo ?? 0).toBeLessThanOrEqual(counts.rubato);
    });

    it('leaves the rubato silent where it is under one JND, and says so', () => {
        // DESIGN's own ×1.5: 0.95 JND. Below the threshold of hearing, and therefore below the
        // threshold of saying — the audibility gate's whole purpose.
        const evidence = takeOf(alter(referenceText, 'rubato', ['intensity'], (v) => v * 1.5));
        expect(evidence.report.dimensions.rubato.mean ?? 0).toBeLessThan(JND_FLOOR);
        expect(evidence.suppressed.get('rubato')?.reason).toContain('under one');
        expect(evidence.structuredDiff.filter((e) => e.type === 'rubato')).toEqual([]);
    });
});

// ── the audibility gate on its own ───────────────────────────────────────────────────────

describe('the audibility gate', () => {
    it('silences a type the two documents are neutral in', () => {
        const evidence = takeOf(referenceText);
        expect(evidence.report.dimensions.asynchrony.state).toBe('both-neutral');
        expect(evidence.suppressed.get('asynchrony')?.reason).toBe('both sides neutral');
        expect(evidence.measuredTypes).not.toContain('asynchrony');
    });

    it('is a second floor, never a replacement for the raw one', () => {
        // A dimension can be well over one JND and still produce no event, because every
        // attribute stayed under `THRESHOLDS`. The two floors are independent by design.
        const evidence = takeOf(alter(referenceText, 'tempo', ['bpm', 'transition.to'], (v) => v * 1.15));
        expect(evidence.suppressed.has('tempo')).toBe(false);
        expect(evidence.measuredTypes).toContain('tempo');
        for (const peak of evidence.peaks.filter((p) => p.type === 'tempo')) {
            const cleared = Object.entries(peak.diffs).some(([attr, d]) =>
                Math.abs(d.delta) >= (attr === 'bpm' || attr === 'transition.to' ? 4 : 0),
            );
            expect(cleared).toBe(true);
        }
    });

    it('reads each type through its own comparison dimension', () => {
        expect(DIMENSION_OF.accentuationPattern).toBe('accentuation');
        expect(DIMENSION_OF.ornament).toBe('ornamentation');
        const evidence = takeOf(referenceText);
        for (const [type, suppression] of evidence.suppressed) {
            expect(suppression.dimension).toBe(DIMENSION_OF[type]);
            expect(suppression.reason.length).toBeGreaterThan(0);
        }
    });

    it('weights out what neither side can answer for', () => {
        expect(TAKE_WEIGHTS.pedal).toBe(0);
        expect(TAKE_WEIGHTS.asynchrony).toBe(0);
        expect(TAKE_WEIGHTS.imprecisionTiming).toBe(0);
        expect(TAKE_WEIGHTS.tempo).toBe(1);
        const evidence = takeOf(referenceText);
        expect(evidence.report.aggregate.weights.pedal).toBe(0);
    });
});

// ── the fallback curve ───────────────────────────────────────────────────────────────────

describe('the fallback for a slot the fitter could not write', () => {
    const evidence = takeOf(alter(referenceText, 'tempo', ['bpm', 'transition.to'], (v) => v * 1.15));

    it('prices a skipped tempo slot off the resolved curves', () => {
        const thin: SkippedSlot[] = [
            { type: 'tempo', xmlId: 'tempo_12240', date: 12240, reason: 'fewer than two notes played' },
        ];
        const emitted = profileFallback(evidence.report, thin, TAKE);
        expect(emitted).toHaveLength(1);
        expect(emitted[0].diffs.bpm.ref).toBeGreaterThan(20);
        expect(emitted[0].diffs.bpm.ref).toBeLessThan(200);
        // The take was played 15 % faster; the student's curve has to read higher there.
        expect(emitted[0].diffs.bpm.student).toBeGreaterThan(emitted[0].diffs.bpm.ref);
    });

    it('refuses to price a type whose curve is not the attribute the diff compares', () => {
        // `rubato`'s profile is a displacement in quarters and `accentuation`'s a velocity; the
        // diff compares an exponent and a multiplier. A number in the wrong unit reaching the
        // German cue table is worse than a silence, so those slots stay in `skipped`.
        expect(
            profileFallback(
                evidence.report,
                [
                    { type: 'rubato', xmlId: 'rubato_12240', date: 12240, reason: 'thin slot' },
                    { type: 'accentuationPattern', xmlId: 'x', date: 12240, reason: 'thin slot' },
                    { type: 'ornament', xmlId: 'y', date: 12240, reason: 'thin slot' },
                ],
                TAKE,
            ),
        ).toEqual([]);
    });

    it('returns nothing at all when no profile was asked for', () => {
        const withoutProfiles = { ...evidence.report, profiles: null };
        expect(profileFallback(withoutProfiles, [
            { type: 'tempo', xmlId: 'tempo_12240', date: 12240, reason: 'thin slot' },
        ], TAKE)).toEqual([]);
    });
});

// ── localisation ─────────────────────────────────────────────────────────────────────────

describe('the localisation header', () => {
    it('states the size, the share below threshold and the dimensions that carry it', () => {
        const evidence = takeOf(alter(referenceText, 'dynamics', ['volume', 'transition.to'], (v) => Math.max(1, v - 18)));
        const header = localisationHeader(evidence.report, TAKE);

        expect(header).toContain('Comparison over m5.1–m9.1');
        expect(header).toContain('JND');
        expect(header).toMatch(/dynamics: \d+\.\d\d JND, student smaller/);
        expect(header).toContain('simply more of it');
        // It is the summary's header and nothing else: no `StructuredDiffEvent` carries it.
        expect(evidence.diffSummary.startsWith(header)).toBe(true);
        for (const event of evidence.structuredDiff) {
            expect(JSON.stringify(event)).not.toContain('JND');
        }
    });

    it('says nothing about place when the gate closed on everything', () => {
        const header = localisationHeader(takeOf(referenceText).report, TAKE);
        expect(header.split('\n')).toHaveLength(1);
        expect(header).toContain('% of it below threshold');
    });

    it('names places in `tickToPos`, and records what espressivo would number them (test 8)', () => {
        // DESIGN §2.1.6 expected an offset here: the score opens `<measure xml:id="mjpcx1"
        // metcon="false" n="1">`, an anacrusis, and espressivo's `segment.measure.number` was
        // therefore not to be used for a position. **The measured offset is zero** — the MSM's
        // measure grid is built from the time signature and starts a full 4/4 bar at quarter 0,
        // with Träumerei's upbeat notated *inside* bar 1 rather than before it, which is the
        // same arithmetic `tickToPos` does. Committed as a check, not as a licence: the header
        // still converts every segment boundary through `tickToPos`, because that is the only
        // vocabulary the plan validator accepts and the corpus spans are recorded in.
        const evidence = takeOf(alter(referenceText, 'tempo', ['bpm', 'transition.to'], (v) => v * 1.15));
        const measures = evidence.report.measures;
        expect(measures).not.toBeNull();

        const at = (ticks: number): number => {
            const quarters = ticks / PPQ;
            let found = measures![0];
            for (const entry of measures!) if (entry.startQuarters <= quarters + 1e-9) found = entry;
            return found.number;
        };

        for (const ticks of [0, 2880, 11520, 23040, 34560]) {
            const bar = Number(tickToPos(ticks).slice(1).split('.')[0]);
            expect(at(ticks) - bar).toBe(0);
        }
        expect(measures![0]).toMatchObject({ number: 1, startQuarters: 0 });
        expect(measures![1]).toMatchObject({ number: 2, startQuarters: 4 });

        const header = localisationHeader(evidence.report, TAKE, evidence.suppressed);
        expect(evidence.report.segments.length).toBeGreaterThan(0);
        for (const segment of evidence.report.segments.slice(0, 3)) {
            expect(header).toContain(tickToPos(Math.round(segment.startQuarters * PPQ)));
        }
    });
});

// ── the direction cross-check ────────────────────────────────────────────────────────────

describe('the direction cross-check', () => {
    it('holds `a` to be the student', () => {
        expect(A_IS_STUDENT).toBe(true);
        // A student who played louder must read positive: `meanSigned = T(a) − T(b)`.
        const evidence = takeOf(alter(referenceText, 'dynamics', ['volume', 'transition.to'], (v) => v + 12));
        expect(evidence.report.dimensions.dynamics.meanSigned ?? 0).toBeGreaterThan(0);
        for (const event of evidence.structuredDiff.filter((e) => e.type === 'dynamics')) {
            expect(event.studentValue).toBeGreaterThan(event.refValue);
        }
        expect(evidence.disagreements).toEqual([]);
    });

    it('agrees with the paired instructions on every altered take', () => {
        for (const take of [
            alter(referenceText, 'tempo', ['bpm', 'transition.to'], (v) => v * 1.15),
            alter(referenceText, 'dynamics', ['volume', 'transition.to'], (v) => Math.max(1, v - 18)),
            alter(referenceText, 'rubato', ['intensity'], (v) => v * 2),
            alter(referenceText, 'accentuationPattern', ['scale'], (v) => v * 10),
            alter(referenceText, 'temporalSpread', ['frameLength'], (v) => v * 2),
        ]) {
            expect(takeOf(take).disagreements).toEqual([]);
        }
    });

    it('reports a disagreement when the two derivations really do point opposite ways', () => {
        const evidence = takeOf(alter(referenceText, 'tempo', ['bpm', 'transition.to'], (v) => v * 1.15));
        // The same report against peaks whose deltas have been negated: the curve says the
        // student was faster, the instructions say slower, and the check has to notice.
        const flipped = evidence.peaks
            .filter((peak) => peak.type === 'tempo')
            .map((peak) => ({
                ...peak,
                diffs: Object.fromEntries(
                    Object.entries(peak.diffs).map(([attr, d]) => [
                        attr,
                        { ref: d.student, student: d.ref, delta: -d.delta },
                    ]),
                ),
            }));
        const disagreements = crossCheckDirections(evidence.report, flipped);
        expect(disagreements.map((d) => d.type)).toEqual(['tempo']);
        expect(disagreements[0].meanSigned).toBeGreaterThan(0);
        expect(disagreements[0].medianDelta).toBeLessThan(0);
    });

    it('does not ask who did more where the difference is a shape, not a level', () => {
        // A take whose rubato was doubled reads 10.8 JND of tempo difference with almost no net
        // level: the two curves cross each other repeatedly. `meanSigned` is then a number about
        // nothing, and cross-checking it against raw deltas would fail the suite on noise.
        const evidence = takeOf(alter(referenceText, 'rubato', ['intensity'], (v) => v * 2));
        const tempo = evidence.report.dimensions.tempo;
        expect(tempo.mean ?? 0).toBeGreaterThan(JND_FLOOR);
        expect(Math.abs(tempo.decomposition?.levelSigned ?? 0)).toBeLessThan(tempo.decomposition?.shape ?? 0);
        expect(evidence.disagreements).toEqual([]);
    });
});

// ── the gate applied to a report, without a take ─────────────────────────────────────────

describe('audibilityGate', () => {
    const evidence = takeOf(alter(referenceText, 'tempo', ['bpm', 'transition.to'], (v) => v * 1.15));

    it('opens for the type that moved and closes for the rest', () => {
        const gate = audibilityGate(evidence.report);
        expect(gate.has('tempo')).toBe(false);
        expect(gate.has('dynamics')).toBe(true);
        expect(gate.has('rubato')).toBe(true);
    });

    it('closes on a type whose difference is almost entirely below threshold', () => {
        const justOver = SUB_THRESHOLD_CEILING + 0.02;
        const nearlyEquivalent = {
            ...evidence.report,
            dimensions: {
                ...evidence.report.dimensions,
                tempo: { ...evidence.report.dimensions.tempo, mean: 40 },
            },
            equivalence: {
                ...evidence.report.equivalence,
                byDimension: {
                    ...evidence.report.equivalence.byDimension,
                    tempo: { subThresholdMassFraction: justOver, aboveThresholdLengthFraction: 1 - justOver },
                },
            },
        };
        expect(audibilityGate(nearlyEquivalent).get('tempo')?.reason).toBe(
            `${(justOver * 100).toFixed(0)}% of it is below threshold`,
        );
    });
});
