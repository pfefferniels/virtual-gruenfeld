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
import { measuredNotesFromPerformanceData, isImplanted, withoutUnisons, type MeasuredNote } from '../score/measured';
import { convert, perform } from '../services/mpmRenderer';
import { PPQ } from '../shared/constants';
import { evidenceForTake, forgetReferenceFits, type Evidence } from './evidence';
import type { Range } from './types';

const load = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const mei = load('../../public/score.mei');
const referenceMpmText = load('../../public/performance.mpm');
const scoreMsm = convert(mei);

/**
 * What `pipeline/boot.ts` derives once: the score, timed as Grünfeld's document sounds it, with
 * unisons folded — because MIDI cannot carry two notes of one pitch at one instant, and this
 * list is the matcher's reference side against real MIDI.
 */
const scoreNotes: MeasuredNote[] = withoutUnisons(measuredNotesFromPerformanceData(
    performMsmToData({ msm: scoreMsm, mpm: referenceMpmText }, { expandOrnaments: false }),
));

/** Four bars, m5.1–m9.1 — the window every suite in this rewrite uses. */
const FOUR_BARS: Range = { from: 11520, to: 23040 };
/** The opening, where the fitter has no two `<tempo>` anchors to measure a tempo between. */
const OPENING: Range = { from: 0, to: 2880 };
/** Eight bars, the upper end of what DESIGN §5 test 11 budgets. */
const EIGHT_BARS: Range = { from: 11520, to: 34560 };
/**
 * The three windows browser run #2 measured the identity take over — where it produced three
 * ornament criticisms apiece against the committed `reference.fitted.mpm` (3.35 · 3.64 · 4.10
 * JND). They are here so the fix is stated on the same passages the hole was found on.
 */
const IDENTITY_WINDOWS: readonly (readonly [string, Range])[] = [
    ['m5–m9', FOUR_BARS],
    ['m1–m5', { from: 0, to: 11520 }],
    ['m9–m13', { from: 23040, to: 34560 }],
];

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
    return evidenceForTake({ notes, range: matched, scoreMsm, scoreNotes, referenceMpmText });
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
    it('measures all six dimensions and stays silent in every one of them on an identity take', () => {
        const evidence = evidenceFor(referenceMpmText, FOUR_BARS);

        // Six of seven fitted, where the old pipeline measured three (semantics §0f).
        expect([...evidence.filled].sort()).toEqual([
            'accentuationPattern', 'articulation', 'dynamics', 'ornament', 'rubato', 'tempo',
        ]);

        // And the gate closes on all seven: the two documents are the same document.
        const suppressed = evidence.suppressed.map((entry) => entry.type).sort();
        expect(suppressed).toEqual([
            'accentuationPattern', 'articulation', 'asynchrony', 'dynamics', 'ornament',
            'rubato', 'tempo',
        ]);
        expect(evidence.measuredTypes).toEqual([]);
    });

    /**
     * The hole browser run #2 found, and the fix, on the three windows it was measured over.
     *
     * Against the old committed `reference.fitted.mpm` a student who played Grünfeld's own roll
     * back was criticised in *every* passage — three events apiece, always `<ornament @scale>`
     * or `@intensity`, at 3.35 · 3.64 · 4.10 JND (`m5.2 ornament.scale 7.00→4.00 large`, "oben
     * mehr zeigen"). The asset had been fitted from note *data* over the whole piece; a take
     * arrives as MIDI over its own window. Now both sides are one procedure over one encoding
     * of one window, so the subtraction is zero everywhere — and the two documents come out
     * byte-identical, which is the strongest form the claim has.
     */
    it.each(IDENTITY_WINDOWS)('says nothing at all about a flawless take (%s)', (_name, window) => {
        const evidence = evidenceFor(referenceMpmText, window);

        expect(evidence.referenceFitText).toBe(evidence.studentMpmText);
        expect(evidence.structuredDiff).toEqual([]);
        expect(evidence.peaks).toEqual([]);
        expect(evidence.aggregateJnd).toBe(0);
        expect(evidence.diffSummary).not.toMatch(/ornament/i);
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
            notes: [], range: point, scoreMsm, scoreNotes, referenceMpmText,
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
        const input = { notes, range, scoreMsm, scoreNotes, referenceMpmText };

        // Both directions. The take goes *into* the worker by structured clone and the
        // evidence comes back the same way; either would fail there and nowhere else, which is
        // the one bug a thin worker shell can still have.
        expect(() => structuredClone(input)).not.toThrow();
        expect(structuredClone(input)).toEqual(input);

        const evidence = evidenceForTake(input);
        expect(() => structuredClone(evidence)).not.toThrow();
        expect(structuredClone(evidence).studentMpmText).toBe(evidence.studentMpmText);
        expect(structuredClone(evidence).referenceFitText).toBe(evidence.referenceFitText);
    });

    it('is the same take twice (semantics 5)', () => {
        const { notes, range } = takeFrom(scaled('bpm', 1.15), FOUR_BARS);
        const input = { notes, range, scoreMsm, scoreNotes, referenceMpmText };

        // The memo is dropped between the two runs, so the reference fit is genuinely computed
        // twice rather than handed back: the claim is that the *procedure* is deterministic,
        // not that a `Map` returns what was put in it.
        forgetReferenceFits();
        const once = evidenceForTake(input);
        forgetReferenceFits();
        const again = evidenceForTake(input);

        expect(again.studentMpmText).toBe(once.studentMpmText);
        expect(again.referenceFitText).toBe(once.referenceFitText);
        expect(again.structuredDiff).toEqual(once.structuredDiff);
        expect(again.diffSummary).toBe(once.diffSummary);
    });
});

// ── DESIGN §5 test 11: the budget ────────────────────────────────────────────────────────

describe('the budget', () => {
    it('fits and compares an eight-bar take well inside a second, reference fit included', () => {
        const { notes, range } = takeFrom(referenceMpmText, EIGHT_BARS);
        const input = { notes, range, scoreMsm, scoreNotes, referenceMpmText };

        forgetReferenceFits();
        const startedAt = performance.now();
        const evidence = evidenceForTake(input);
        const elapsed = performance.now() - startedAt;

        // Logged with real figures, as the design asks, so a regression is visible in CI output
        // rather than only in a failing threshold.
        console.log(
            `evidence, ${range.to - range.from} ticks, ${notes.filter(isImplanted).length} played notes: ` +
            `reference fit ${evidence.timings.referenceFitMs.toFixed(1)} ms + ` +
            `fit ${evidence.timings.fitMs.toFixed(1)} ms + compare ${evidence.timings.evidenceMs.toFixed(1)} ms ` +
            `= ${elapsed.toFixed(1)} ms`,
        );

        // The comparison side is now computed rather than fetched. What that costs over eight
        // bars — one render, one match, one fit — is 90–230 ms on this machine depending on how
        // loaded it is; the ceiling is a ceiling, not a target, and the real figure is logged
        // above so a regression shows up in the output before it shows up in a failure.
        expect(evidence.timings.referenceFitMs).toBeLessThan(600);
        expect(elapsed).toBeLessThan(1000);
    });

    it('makes the student pay for the reference fit once per passage, not once per take', () => {
        // Practising is repetition. A second take over the same window must not re-render, and
        // re-match, and re-fit Grünfeld to arrive at the document it already has.
        const { notes, range } = takeFrom(scaled('bpm', 1.15), FOUR_BARS);
        const input = { notes, range, scoreMsm, scoreNotes, referenceMpmText };

        forgetReferenceFits();
        const first = evidenceForTake(input);
        const second = evidenceForTake(input);

        expect(first.timings.referenceFitMs).toBeGreaterThan(10);
        expect(second.timings.referenceFitMs).toBeLessThan(5);
        expect(second.referenceFitText).toBe(first.referenceFitText);
    });
});
