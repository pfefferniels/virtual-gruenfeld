/**
 * One take, from measured notes to the teacher's evidence — the whole of DESIGN §3.1 steps 1–6
 * behind one pure call.
 *
 * ```
 * readScaffold(performance.mpm, range)  →  Grünfeld's own slots
 * fitStudent(notes, scaffold, scoreMsm) →  the student's MPM, written into those slots
 * takeEvidence(student, reference.fitted.mpm, scoreMsm, range)
 *                                       →  cut · compareMpm · gate · pair · diff
 * ```
 *
 * It exists as its own module for one reason: `workers/evidence.worker.ts` has to stay a
 * postMessage shell with no logic in it, and a shell needs something to call. Everything here
 * is therefore pure, runs identically on the main thread and in a worker, and is tested
 * directly — the worker never is.
 *
 * **Everything crossing this boundary is structured-clone-safe**: text, numbers, arrays and
 * plain objects, no `Map`, no `Set`, no espressivo document. That is what lets the same result
 * come back over `postMessage` or straight out of a function call, byte for byte the same.
 * `ComparisonReport` stays inside; the two numbers the judgement will want out of it
 * ({@link Evidence.aggregateJnd}, {@link Evidence.subThresholdFraction}) come out beside it.
 */
import { isImplanted, type MeasuredNote } from '../score/measured';
import { fitStudent, type LegacyType } from '../student/fit';
import { readScaffold } from '../student/scaffold';
import { takeEvidence } from './compare';
import { parseReferenceMpm } from './reference';
import type { DiffType, Range, StructuredDiffEvent } from './types';

/** What one take needs to know: the take itself, and the three documents it is read against. */
export type EvidenceInput = {
    /**
     * The take, as `implantLocal` leaves it: every score note, the ones the student actually
     * played carrying their own timing (`source: 'implanted'`), the rest carrying the
     * reference's, shifted. Only the first kind is fitted, and {@link evidenceForTake} keeps
     * it that way by asking — see there for why the window alone would have been enough.
     */
    readonly notes: readonly MeasuredNote[];
    readonly range: Range;
    /** The score as MSM text — `services/mpmRenderer.convert(mei)`. */
    readonly scoreMsm: string;
    /** The **editorial** reference: `performance.mpm`, the scaffold every `xml:id` comes from. */
    readonly referenceMpmText: string;
    /** The **fitted** reference: `reference.fitted.mpm`, the comparison side (S4 §2). */
    readonly fittedReferenceMpmText: string;
};

/** A slot the fitter could not answer for, or a type the gate closed — logged, never silent. */
export type EvidenceNote = {
    readonly type: string;
    readonly reason: string;
    readonly date?: number;
};

export type Evidence = {
    /** The student's performance as the fitter wrote it. S6's counter-performance reads it. */
    readonly studentMpmText: string;
    readonly structuredDiff: StructuredDiffEvent[];
    readonly diffSummary: string;
    /**
     * Types the fitter wrote **and** the audibility gate let through (DESIGN §3.4) — the
     * intersection of {@link filled} with `TakeEvidence.measuredTypes`, taken here because
     * this is the only place both are known. What a plan may name (S7's `validateDimensions`).
     */
    readonly measuredTypes: readonly DiffType[];
    /** Types the fitter wrote at all, before the gate. */
    readonly filled: readonly LegacyType[];
    /** What the gate closed, and why. */
    readonly suppressed: readonly EvidenceNote[];
    /** Slots with too little playing in them to fit. */
    readonly skipped: readonly EvidenceNote[];
    /** Where the curve and the instruction pairs disagree about who did more (DESIGN §3.3.4). */
    readonly disagreements: readonly { type: string; meanSigned: number; medianDelta: number }[];
    /** The student's own tempo and volume levels — the counter-performance's pivot (S6). */
    readonly levels: { student: { bpm: number[]; volume: number[] } };
    /** `report.aggregate.mean`: the whole window's difference in just-noticeable differences. */
    readonly aggregateJnd: number;
    /** `report.equivalence.subThresholdMassFraction`: how much of it sits below threshold. */
    readonly subThresholdFraction: number;
    readonly timings: { readonly fitMs: number; readonly evidenceMs: number };
};

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now());

/**
 * Fit the take into Grünfeld's slots and price it against him. Pure; no I/O, no globals.
 *
 * The notes are windowed to `[range.from, range.to)` first, and that is a correctness matter
 * rather than a saving: outside the matched region a note carries the *reference's* timing,
 * shifted onto the student's clock, so fitting it would measure Grünfeld's playing at the
 * window's edge and report it as the student's. It is also exactly how every fixture in
 * `student/fit.test.ts` and `mpm/compare.test.ts` is built, so what a take does live is what
 * those tests measured.
 *
 * The window and `isImplanted` select the same notes — every unmatched reference note *inside*
 * the matched range is collected into the matcher's `deletions` and dropped there
 * (`matcher.ts:707-717`), so nothing in range can be anything but the student's. Both are
 * asked for anyway: the equivalence is three modules away and one range convention away from
 * being obvious, and this is the sentence that would be wrong if either ever changed.
 */
export const evidenceForTake = (input: EvidenceInput): Evidence => {
    const { notes, range, scoreMsm, referenceMpmText, fittedReferenceMpmText } = input;
    const played = notes.filter(
        (note) => isImplanted(note) && note.date >= range.from && note.date < range.to,
    );

    const fitStartedAt = now();
    const scaffold = readScaffold(parseReferenceMpm(referenceMpmText), range);
    const { studentMpmText, filled, levels, skipped } = fitStudent(played, scaffold, scoreMsm);
    const fitMs = now() - fitStartedAt;

    const evidenceStartedAt = now();
    const evidence = takeEvidence({
        referenceMpmText: fittedReferenceMpmText,
        studentMpmText,
        scoreMsm,
        range,
        skipped,
    });
    const evidenceMs = now() - evidenceStartedAt;

    return {
        studentMpmText,
        structuredDiff: evidence.structuredDiff,
        diffSummary: evidence.diffSummary,
        // Both halves of DESIGN §3.4, and this is the only place that has both: `takeEvidence`
        // knows what the gate let through, and only the fit knows what was written at all. A
        // type the fitter skipped whose reference side is loud enough to clear the gate passes
        // the first test and fails the second — real, not hypothetical: on the opening bars the
        // fitter writes no `<tempo>` and the gate still opens on tempo. Reporting it as
        // measured would let a plan name a dimension with no student measurement behind it.
        measuredTypes: evidence.measuredTypes.filter((type) => filled.has(type)),
        filled: [...filled],
        suppressed: [...evidence.suppressed.values()].map(({ type, reason }) => ({ type, reason })),
        skipped: skipped.map(({ type, date, reason }) => ({ type, date, reason })),
        disagreements: evidence.disagreements.map(({ type, meanSigned, medianDelta }) => ({
            type,
            meanSigned,
            medianDelta,
        })),
        levels,
        aggregateJnd: evidence.report.aggregate.mean ?? 0,
        subThresholdFraction: evidence.report.equivalence.subThresholdMassFraction,
        timings: { fitMs, evidenceMs },
    };
};
