/**
 * One take, from measured notes to the teacher's evidence — the whole of DESIGN §3.1 steps 1–6
 * behind one pure call.
 *
 * ```
 * readScaffold(performance.mpm, range)  →  Grünfeld's own slots
 * fitStudent(notes, scaffold, scoreMsm) →  the student's MPM, written into those slots
 * fitReferenceForRange(range)           →  Grünfeld through the very same path (§below)
 * takeEvidence(student, that fit, scoreMsm, range)
 *                                       →  cut · compareMpm · gate · pair · diff
 * ```
 *
 * **Why the reference is fitted here, per take, instead of fetched.** `performance.mpm` is a
 * bake — sixty `<tempo>` elements drawn by hand — and a student's document is *solved* from
 * onsets; comparing the two measured 22 bpm and 9.2 JND on a take where the playing was
 * identical (S3). The first answer was a committed asset, `reference.fitted.mpm`, fitted once
 * from `performMsmToData` note *data* over the whole piece. That halved the problem and left
 * the other half: a take does not arrive as note data, it arrives as **MIDI** — unisons folded,
 * because MIDI cannot carry two notes of one pitch at one instant, velocities integer, the
 * matcher's assignment on top — and over its own window, not the piece. `<ornament @scale>` is
 * a ratio of the velocity gradient across a rolled chord and is sensitive to exactly that, so a
 * student who played the roll back perfectly was told in every passage that their arpeggios
 * were wrong (3.35 · 3.64 · 4.10 JND over three windows, three events each; browser run #2).
 *
 * So the reference goes through the student's own path, at take time, over the take's own
 * range: render `performance.mpm` to MIDI, match it back with `implantLocal`, fit it with
 * `fitStudent`. Both sides are then one procedure over one encoding of one window, and an
 * identity take is 0 events at 0 JND **by construction** — the two fitted documents come out
 * byte-identical (`evidence.test.ts`). Window-edge effects (S4 §2) cancel with it. The cost is
 * ~90 ms for four bars, ~160 ms for eight, memoized per range so a student repeating a passage
 * pays once.
 *
 * `performance.mpm` is untouched by all this: it remains the scaffold every `xml:id` is read
 * from, the counter-performance's base and the server's document. What the teacher quotes as
 * `refValue` is Grünfeld measured the way the student is measured, which is what makes the
 * subtraction mean anything.
 *
 * It exists as its own module for one reason: `workers/evidence.worker.ts` has to stay a
 * postMessage shell with no logic in it, and a shell needs something to call. Everything here
 * is therefore pure — the memo aside, which only ever caches a pure function of its key — runs
 * identically on the main thread and in a worker, and is tested directly; the worker never is.
 *
 * **Everything crossing this boundary is structured-clone-safe**: text, numbers, arrays and
 * plain objects, no `Map`, no `Set`, no espressivo document. That is what lets the same result
 * come back over `postMessage` or straight out of a function call, byte for byte the same.
 * `ComparisonReport` stays inside; the two numbers the judgement will want out of it
 * ({@link Evidence.aggregateJnd}, {@link Evidence.subThresholdFraction}) come out beside it.
 */
import { implantLocal } from '../matcher';
import { isImplanted, type MeasuredNote } from '../score/measured';
import { performMsm } from '../services/mpmRenderer';
import { fitStudent, type LegacyType } from '../student/fit';
import { readScaffold } from '../student/scaffold';
import { takeEvidence } from './compare';
import { parseReferenceMpm } from './reference';
import type { DiffType, InstructionDiff, Range, StructuredDiffEvent } from './types';

/** What one take needs to know: the take itself, and the documents it is read against. */
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
    /**
     * Every score note timed as `performance.mpm` sounds it — `pipeline/boot.ts`'s `scoreNotes`,
     * the matcher's reference side. Sent along because the reference is matched here too: the
     * take and Grünfeld are put through one `implantLocal` against one score.
     */
    readonly scoreNotes: readonly MeasuredNote[];
    /**
     * The **editorial** reference: `performance.mpm`. Both the scaffold every `xml:id` comes
     * from and, rendered over this range, the comparison side's own playing.
     */
    readonly referenceMpmText: string;
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
    /**
     * Grünfeld's own playing over this take's range, written by the same fitter — the side
     * every number in {@link peaks} and {@link structuredDiff} is measured against, and what
     * `mode: 'path'` reads as its `b` (`mpm/path.ts`). It carries the *editorial* document's
     * `xml:id`s, which is what the pairing joins on; only the values are the fit's.
     */
    readonly referenceFitText: string;
    readonly structuredDiff: StructuredDiffEvent[];
    /**
     * The paired instructions, per attribute, in raw MPM units: `{ref, student, delta}` for
     * every attribute both documents state at a slot the take measured. `structuredDiff` keeps
     * only each slot's *primary* attribute, and the counter-performance needs both halves of a
     * slot — `bpm` **and** `transition.to` — to push each of them away from this student
     * (`mpm/counter.ts`; review-S6 findings 6 and 7).
     */
    readonly peaks: readonly InstructionDiff[];
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
    readonly timings: {
        readonly fitMs: number;
        readonly evidenceMs: number;
        /** What the reference fit cost, or 0 when the memo answered it. */
        readonly referenceFitMs: number;
    };
};

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now());

/**
 * The reference fit, per range, for as long as the documents behind it stay the same.
 *
 * A student who repeats a passage — which is what practising *is* — pays the ~90 ms once. The
 * key is the range alone because the two documents are a session's constants; they are held
 * beside it and checked rather than hashed, so a changed reference clears the memo instead of
 * silently answering with the old one. Module-level, which in the browser means per worker.
 */
const referenceFits = new Map<string, string>();
let memoOf: { referenceMpmText: string; scoreMsm: string } | null = null;

/**
 * Grünfeld over `range`, through the student's path: render → MIDI → match → fit.
 *
 * Every step is the one a take takes, in the order it takes it, which is the whole point — see
 * the module header. Three details are load-bearing:
 *
 * - the render enters at `performMsm`, from the MSM text, because the worker has no MEI; it is
 *   byte-for-byte `render(mei, …)` (`services/mpmRenderer.test.ts`);
 * - the notes are windowed to `[range.from, range.to)` and asked for `isImplanted`, the same
 *   two filters {@link evidenceForTake} puts the take through, so the two fits see the same
 *   window on the same terms;
 * - the scaffold is read from the **editorial** document, as the student's is. Both documents
 *   therefore carry `performance.mpm`'s `xml:id`s, and `pair.ts`'s join is a `Map` lookup.
 *
 * The written document says `<performance name="student">`, because `fitStudent` writes that
 * and nothing keys on the name (`compareMpm`, `readScaffold` and `cutToRange` all take
 * performance 0). Renaming it would be legible and would cost the identity take its
 * byte-equality assertion, which is worth more.
 */
const fitReferenceForRange = (
    input: Pick<EvidenceInput, 'range' | 'scoreMsm' | 'scoreNotes' | 'referenceMpmText'>,
): string => {
    const { range, scoreMsm, scoreNotes, referenceMpmText } = input;

    if (memoOf === null || memoOf.referenceMpmText !== referenceMpmText || memoOf.scoreMsm !== scoreMsm) {
        referenceFits.clear();
        memoOf = { referenceMpmText, scoreMsm };
    }
    const key = `${range.from}:${range.to}`;
    const cached = referenceFits.get(key);
    if (cached !== undefined) return cached;

    // The scaffold first, and not only for tidiness: it is what rejects a range that is not one
    // (`from >= to`, the one-chord take `pipeline/takeRunner.ts` guards against), and that
    // rejection should not cost a render first.
    const scaffold = readScaffold(parseReferenceMpm(referenceMpmText), range);

    const midi = performMsm(scoreMsm, referenceMpmText, range);
    if (!midi) throw new Error('EVIDENCE: the reference could not be rendered over this range');

    const { notes } = implantLocal(scoreNotes, midi, (range.from + range.to) / 2);
    const played = notes.filter(
        (note) => isImplanted(note) && note.date >= range.from && note.date < range.to,
    );
    const { studentMpmText } = fitStudent(played, scaffold, scoreMsm);

    referenceFits.set(key, studentMpmText);
    return studentMpmText;
};

/** Drop the memoized reference fits. For tests, and for a re-boot on a different document. */
export const forgetReferenceFits = (): void => {
    referenceFits.clear();
    memoOf = null;
};

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
    const { notes, range, scoreMsm, scoreNotes, referenceMpmText } = input;
    const played = notes.filter(
        (note) => isImplanted(note) && note.date >= range.from && note.date < range.to,
    );

    // The comparison side first, because it is the one that can be answered from the memo and
    // because a range the reference cannot be rendered over is a range nothing can be said about.
    const referenceFitStartedAt = now();
    const referenceFitText = fitReferenceForRange({ range, scoreMsm, scoreNotes, referenceMpmText });
    const referenceFitMs = now() - referenceFitStartedAt;

    const fitStartedAt = now();
    const scaffold = readScaffold(parseReferenceMpm(referenceMpmText), range);
    const { studentMpmText, filled, levels, skipped } = fitStudent(played, scaffold, scoreMsm);
    const fitMs = now() - fitStartedAt;

    const evidenceStartedAt = now();
    const evidence = takeEvidence({
        referenceMpmText: referenceFitText,
        studentMpmText,
        scoreMsm,
        range,
        skipped,
    });
    const evidenceMs = now() - evidenceStartedAt;

    return {
        studentMpmText,
        referenceFitText,
        structuredDiff: evidence.structuredDiff,
        peaks: evidence.peaks,
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
        // Same `?? 0` as the line above: `takeRunner.ts` multiplies this by 100 and rounds it for
        // the log, and an omitted field would print `NaN` (final-contracts, finding 7).
        subThresholdFraction: evidence.report.equivalence.subThresholdMassFraction ?? 0,
        timings: { fitMs, evidenceMs, referenceFitMs },
    };
};
