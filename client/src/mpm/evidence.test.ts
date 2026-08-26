/**
 * A take, from a MIDI file to the teacher's evidence — the path the browser runs, in Node.
 *
 * `mpm/compare.test.ts` builds its takes out of rendered *note data*; this file builds them out
 * of rendered **MIDI**, which is what a piano actually sends, and puts them through
 * `implantLocal` first. That is the seam S5 rewired: the matcher's reference side is no longer
 * an `mpmify` MSM but the score's notes as `performance.mpm` sounds them, and its output is no
 * longer an MSM but the take itself.
 *
 * DESIGN §5 test 11 (the budget) and the second half of test 6 (determinism through the whole
 * take, not just the fit) live here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performMsmToData } from 'espressivo';
import { describe, expect, it } from 'vitest';
import { implantLocal } from '../matcher';
import { measuredNotesFromPerformanceData, isImplanted, type MeasuredNote } from '../score/measured';
import { convert, perform } from '../services/mpmRenderer';
import { PPQ } from '../shared/constants';
import { evidenceForTake, type Evidence } from './evidence';
import type { Range } from './types';

const load = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const mei = load('../../public/score.mei');
const referenceMpmText = load('../../public/performance.mpm');
const fittedReferenceMpmText = load('../../public/reference.fitted.mpm');
const scoreMsm = convert(mei);

/** What `pipeline/boot.ts` derives once: the score, timed as Grünfeld's document sounds it. */
const scoreNotes: MeasuredNote[] = measuredNotesFromPerformanceData(
    performMsmToData({ msm: scoreMsm, mpm: referenceMpmText }, { expandOrnaments: false }),
);

/** Four bars, m5.1–m9.1 — the window every suite in this rewrite uses. */
const FOUR_BARS: Range = { from: 11520, to: 23040 };
/** The opening, where the fitter has no two `<tempo>` anchors to measure a tempo between. */
const OPENING: Range = { from: 0, to: 2880 };
/** Eight bars, the upper end of what DESIGN §5 test 11 budgets. */
const EIGHT_BARS: Range = { from: 11520, to: 34560 };

/** Grünfeld's document with one number scaled everywhere — a student who differs in one way. */
const scaled = (attribute: string, factor: number): string =>
    referenceMpmText.replace(
        new RegExp(`${attribute.replace('.', '\\.')}="([\\d.]+)"`, 'g'),
        (_match, value: string) => `${attribute}="${Number(value) * factor}"`,
    );

/**
 * One take, exactly as the browser makes it: render the performance to MIDI over the window,
 * parse it as if it had arrived from the keyboard, and match it back against the score.
 */
const takeFrom = (mpmText: string, range: Range) => {
    const midi = perform(mei, mpmText, range);
    if (!midi) throw new Error('the take could not be rendered');
    return implantLocal(scoreNotes, midi, (range.from + range.to) / 2);
};

const evidenceFor = (mpmText: string, range: Range): Evidence => {
    const { notes, range: matched } = takeFrom(mpmText, range);
    return evidenceForTake({
        notes,
        range: matched,
        scoreMsm,
        referenceMpmText,
        fittedReferenceMpmText,
    });
};

// ── the implant, in its new shape ────────────────────────────────────────────────────────

describe('implantLocal, on score notes', () => {
    it('finds the passage that was played and marks only those notes as the student’s', () => {
        const { notes, range } = takeFrom(referenceMpmText, FOUR_BARS);

        // The window is recovered from the playing itself, to within a note of its edges.
        expect(range.from).toBeGreaterThanOrEqual(FOUR_BARS.from);
        expect(range.to).toBeLessThan(FOUR_BARS.to);
        expect(range.to - range.from).toBeGreaterThan(2 * 4 * PPQ);

        const implanted = notes.filter(isImplanted);
        expect(implanted.length).toBeGreaterThan(30);
        for (const note of implanted) {
            expect(note.date).toBeGreaterThanOrEqual(range.from);
            expect(note.date).toBeLessThanOrEqual(range.to);
        }
        // Everything outside stays the reference's playing — it is not the student's, and
        // `evidenceForTake` drops it for exactly that reason.
        expect(notes.some((note) => !isImplanted(note))).toBe(true);
    });

    it('keeps the piece one timeline: the notes around the take are shifted, not reset', () => {
        const { notes, range } = takeFrom(referenceMpmText, FOUR_BARS);
        const before = notes.filter((note) => note.date < range.from);
        expect(before.length).toBeGreaterThan(0);

        for (const note of before) {
            // A duration is preserved by shifting both ends, and no note lands before zero.
            expect(note['milliseconds.date.end']).toBeGreaterThan(note['milliseconds.date']);
        }
        const first = notes.find((note) => isImplanted(note));
        const last = before[before.length - 1];
        expect(last['milliseconds.date']).toBeLessThan(first!['milliseconds.date']);
    });
});

// ── the whole take ───────────────────────────────────────────────────────────────────────

describe('one take, end to end', () => {
    it('measures all six dimensions and stays silent in five of them on an identity take', () => {
        const evidence = evidenceFor(referenceMpmText, FOUR_BARS);

        // Six of seven fitted, where the old pipeline measured three (semantics §0f).
        expect([...evidence.filled].sort()).toEqual([
            'accentuationPattern', 'articulation', 'dynamics', 'ornament', 'rubato', 'tempo',
        ]);

        // The gate closes on everything the take cannot hear a difference in. `asynchrony` is
        // `both-neutral` by construction; the other four are under one JND.
        const suppressed = evidence.suppressed.map((entry) => entry.type).sort();
        expect(suppressed).toEqual([
            'accentuationPattern', 'articulation', 'asynchrony', 'dynamics', 'rubato',
        ]);

        // Nothing is said about level or shape: no dynamics, no rubato, no accentuation event.
        const types = new Set(evidence.structuredDiff.map((event) => event.type));
        expect(types.has('dynamics')).toBe(false);
        expect(types.has('rubato')).toBe(false);
        expect(types.has('accentuationPattern')).toBe(false);
    });

    it('commits what a MIDI keyboard cannot give back (the S5 residual, for calibration)', () => {
        // A take reaches the fitter through MIDI, and MIDI cannot carry two notes of the same
        // pitch at the same instant — a piano score writes them whenever two voices meet, 18
        // times in this piece. `reference.fitted.mpm` was fitted from rendered note *data*,
        // where both are present, so a rolled chord's velocity gradient is measured across one
        // more note there than any keyboard can deliver, and `<ornament @scale>` — a ratio of
        // exactly that gradient — comes out low.
        //
        // Refitting the reference from the folded note set does not remove it (measured: the
        // same size, on a different slot), because `@scale` is window-sensitive in the fitter
        // itself. So it is stated here rather than papered over: risk R3's calibration item,
        // for the first browser session and for whoever tunes `TAKE_WEIGHTS` next. Everything
        // else on an identity take is silent.
        const evidence = evidenceFor(referenceMpmText, FOUR_BARS);
        const ornament = evidence.structuredDiff.filter((event) => event.type === 'ornament');
        const tempo = evidence.structuredDiff.filter((event) => event.type === 'tempo');

        expect(ornament.length).toBeGreaterThan(0);
        expect(ornament.length).toBeLessThanOrEqual(3);
        expect(evidence.structuredDiff.length).toBe(ornament.length + tempo.length);

        // The tempo leftovers are the take's own window edges (S4 §2), and stay `slight`.
        for (const event of tempo) expect(event.severity).toBe('slight');

        // The whole take, in JND. Committed so any change to either fitter restates it.
        expect(evidence.aggregateJnd).toBeGreaterThan(2);
        expect(evidence.aggregateJnd).toBeLessThan(5);
    });

    it('names the tempo, in the right direction, when the student hurried', () => {
        const evidence = evidenceFor(scaled('bpm', 1.15), FOUR_BARS);

        const tempo = evidence.structuredDiff.filter((event) => event.type === 'tempo');
        expect(tempo.length).toBeGreaterThan(0);
        expect(evidence.measuredTypes).toContain('tempo');
        for (const event of tempo) {
            // `delta = student − ref > 0` for a faster student, and the German cue tells them so.
            expect(event.studentValue).toBeGreaterThan(event.refValue);
            expect(event.direction).toBe('less');
            expect(event.cueText).toBe('ruhiger');
        }
    });

    it('has no window to fit a one-chord take into', () => {
        // What `pipeline/takeRunner.ts` guards against before it ever gets here: a take whose
        // matched notes all land on one date collapses the matcher's range to a point, and a
        // point is not a passage. Stated as a contract, because the guard is the only thing
        // standing between it and a rejection nobody awaits (`midi.ts:94`).
        const point: Range = { from: 11520, to: 11520 };
        expect(() => evidenceForTake({
            notes: [], range: point, scoreMsm, referenceMpmText, fittedReferenceMpmText,
        })).toThrow('is not a range');
    });

    it('measures only what the student was actually measured in', () => {
        // Both halves of DESIGN §3.4. On the opening bars the fitter writes no `<tempo>` — one
        // anchor, nothing to measure a tempo between — while the gate, which sees the
        // reference's side too, opens on tempo anyway. Reported as measured, it would let a
        // plan name a dimension with no student measurement behind it (S7).
        const evidence = evidenceFor(referenceMpmText, OPENING);
        const filled = new Set<string>(evidence.filled);

        expect(filled.has('tempo')).toBe(false);
        expect(evidence.measuredTypes).not.toContain('tempo');
        expect(evidence.measuredTypes.every((type) => filled.has(type))).toBe(true);
        // The gate is still the other half: it closed on types the fitter did write.
        expect(evidence.measuredTypes.length).toBeLessThan(filled.size);
    });

    it('fits the notes the student played, which inside the window is all of them', () => {
        // `evidenceForTake` asks for both `isImplanted` and the window. They select the same
        // notes — the matcher collects every unmatched reference note in range into its
        // `deletions` — and this is the assertion that says so out loud.
        const { notes, range } = takeFrom(referenceMpmText, FOUR_BARS);
        const inWindow = notes.filter((note) => note.date >= range.from && note.date < range.to);

        expect(inWindow.length).toBeGreaterThan(30);
        expect(inWindow.every(isImplanted)).toBe(true);
    });

    it('carries only what can cross a postMessage boundary', () => {
        const { notes, range } = takeFrom(referenceMpmText, FOUR_BARS);
        const input = { notes, range, scoreMsm, referenceMpmText, fittedReferenceMpmText };

        // Both directions. The take goes *into* the worker by structured clone and the
        // evidence comes back the same way; either would fail there and nowhere else, which is
        // the one bug a thin worker shell can still have.
        expect(() => structuredClone(input)).not.toThrow();
        expect(structuredClone(input)).toEqual(input);

        const evidence = evidenceForTake(input);
        expect(() => structuredClone(evidence)).not.toThrow();
        expect(structuredClone(evidence).studentMpmText).toBe(evidence.studentMpmText);
    });

    it('is the same take twice (semantics 5)', () => {
        const { notes, range } = takeFrom(scaled('bpm', 1.15), FOUR_BARS);
        const input = { notes, range, scoreMsm, referenceMpmText, fittedReferenceMpmText };

        const once = evidenceForTake(input);
        const again = evidenceForTake(input);

        expect(again.studentMpmText).toBe(once.studentMpmText);
        expect(again.structuredDiff).toEqual(once.structuredDiff);
        expect(again.diffSummary).toBe(once.diffSummary);
    });
});

// ── DESIGN §5 test 11: the budget ────────────────────────────────────────────────────────

describe('the budget', () => {
    it('fits and compares an eight-bar take well inside a second', () => {
        const { notes, range } = takeFrom(referenceMpmText, EIGHT_BARS);

        const startedAt = performance.now();
        const evidence = evidenceForTake({
            notes,
            range,
            scoreMsm,
            referenceMpmText,
            fittedReferenceMpmText,
        });
        const elapsed = performance.now() - startedAt;

        // Logged with real figures, as the design asks, so a regression is visible in CI output
        // rather than only in a failing threshold.
        console.log(
            `evidence, ${range.to - range.from} ticks, ${notes.filter(isImplanted).length} played notes: ` +
            `fit ${evidence.timings.fitMs.toFixed(1)} ms + compare ${evidence.timings.evidenceMs.toFixed(1)} ms ` +
            `= ${elapsed.toFixed(1)} ms`,
        );

        expect(elapsed).toBeLessThan(1000);
    });
});
