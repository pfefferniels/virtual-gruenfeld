/**
 * The rolled chord, read off the recording.
 *
 * A Welte roll of Träumerei is full of arpeggios, and 97 of the corpus's 136 argumentations
 * touch ornamentation — it is the dimension the teacher speaks about most. What makes a
 * spread chord measurable is that it is *one* chord: the notes carry one score date and
 * several onsets, and the ornament is the description of how those onsets were laid out.
 *
 * Two pieces are **copied verbatim from mpm-desk** (semantics 13 and 14), because they are
 * the measurement, not an implementation of it: `determineIntensity`'s golden-section power
 * fit and `determineSortDirection`, which decides whether a roll ran up or down the chord.
 * The detector around them is the body of mpm-desk's `InsertTemporalSpread.transform`,
 * rewritten against {@link MeasuredNote} — the same thresholds (0.8 of the span for
 * `noteoff.shift`, 20 ms for monophonic, the `estimate` placement) and the same arithmetic,
 * with two differences that are stated where they occur:
 *
 * 1. it **reports** the collapsed onset instead of writing it back onto the notes — the
 *    caller owns the note array, and a fitter that mutated its input could not be run twice
 *    on one take (determinism, semantics 5);
 * 2. the frame is reported in **milliseconds**, which is what was measured; `fit.ts` converts
 *    it to ticks at the fitted tempo, because the reference writes `time.unit="ticks"` and
 *    the two sides of a comparison have to be in one unit.
 */
import { elementAt, foldl, head, isNonEmpty, pairwise } from 'espressivo';
import type { MeasuredNote } from '../score/measured';

// ── copied from mpm-desk@dffb6c1 src/fitting/transformers/ornamentation/InsertTemporalSpread.ts:23-71

// onsets is a sorted array normalized to [0, 1]
export const determineIntensity = (onsets: number[]): number => {
    const n = onsets.length;
    // intensity only makes sense for more than 2 notes
    if (n <= 2) return 1;

    // The error function we want to minimize.
    const error = (intensity: number): number =>
        foldl(onsets, 0, (sum, onset, i) => {
            const diff = onset - Math.pow(i / (n - 1), intensity);
            return sum + diff * diff;
        });

    // Search bounds. TODO: make these configurable.
    let lower = 0.1,
        upper = 5.0;
    const tol = 1e-6;
    const goldenRatio = (Math.sqrt(5) + 1) / 2;

    let c = upper - (upper - lower) / goldenRatio;
    let d = lower + (upper - lower) / goldenRatio;

    // Continue refining the bounds until convergence.
    while (upper - lower > tol) {
        if (error(c) < error(d)) {
            upper = d;
        } else {
            lower = c;
        }
        c = upper - (upper - lower) / goldenRatio;
        d = lower + (upper - lower) / goldenRatio;
    }

    return (lower + upper) / 2;
};

/**
 * A little helper function to determine how an array is sorted.
 *
 * @param arr The array to check
 * @returns -1 if the array is sorted in descending order, 1 if its
 * sorted in ascending order, 0 if it isn't sorted.
 */
const determineSortDirection = (arr: number[]) => {
    const steps = pairwise(arr);
    if (!isNonEmpty(steps)) return 0;

    const [firstFrom, firstTo] = head(steps);
    const direction = Math.sign(firstTo - firstFrom);
    return steps.every(([from, to]) => Math.sign(to - from) === direction) ? direction : 0;
};

// ── end of the copied block

/** `@noteoff.shift`, spelled as the MPM attribute spells it. */
export type NoteOffShiftValue = 'false' | 'true' | 'monophonic';

/** What one rolled chord turned out to be. Milliseconds throughout; ticks are `fit.ts`'s job. */
export type Arpeggio = {
    /** The chord's score date, in ticks. */
    readonly date: number;
    /** `@note.order`: `'ascending pitch'`, `'descending pitch'`, or the ids in the order struck. */
    readonly noteOrder: string;
    /** Where the frame opens relative to the collapsed onset, in ms — negative for a roll before the beat. */
    readonly frameStartMs: number;
    /** The span from first onset to last, in ms. */
    readonly frameLengthMs: number;
    /** The power exponent of the onset spacing (semantics 13). */
    readonly intensity: number;
    readonly noteOffShift: NoteOffShiftValue;
    /** The single onset the chord collapses onto, in ms — the caller applies it. */
    readonly onsetMs: number;
    /** How far each note has to move to reach {@link onsetMs}, by `xml:id`. */
    readonly shiftMs: ReadonlyMap<string, number>;
};

/**
 * A roll shorter than this is not an ornament but the recording's own jitter, in ms.
 * mpm-desk's own default `durationThreshold`.
 */
export const DEFAULT_ROLL_THRESHOLD_MS = 35;

/**
 * Read one chord — all the measured notes sharing a score date — as an arpeggio, or answer
 * null where there is nothing to describe: fewer than two notes, or a spread too short to be
 * one.
 */
export const detectArpeggio = (
    date: number,
    chord: readonly MeasuredNote[],
    rollThresholdMs: number = DEFAULT_ROLL_THRESHOLD_MS,
): Arpeggio | null => {
    // Less than two notes cannot be arpeggiated
    const arpeggioNotes = chord.filter((note) => Number.isFinite(note['milliseconds.date']));
    if (arpeggioNotes.length < 2) return null;

    // `slice()` first: mpm-desk sorts the chord in place, which is safe there because the
    // alignment is the transformer's own. Here the note array belongs to the caller.
    const sortedByOnset = arpeggioNotes
        .slice()
        .sort((a, b) => a['milliseconds.date'] - b['milliseconds.date']);
    const firstNote = elementAt(sortedByOnset, 0, 'the arpeggiated chord');
    const lastNote = elementAt(sortedByOnset, sortedByOnset.length - 1, 'the arpeggiated chord');

    // detecting the direction of the arpeggiated notes.
    const arpeggioDirection = determineSortDirection(sortedByOnset.map((note) => note['midi.pitch']));
    let noteOrder = '';
    if (arpeggioDirection === 1) noteOrder = 'ascending pitch';
    else if (arpeggioDirection === -1) noteOrder = 'descending pitch';
    else noteOrder = sortedByOnset.map((note) => `#${note['xml:id']}`).join(' ');

    // the arpeggio's duration is the time distance between first and last onset, in ms
    const duration = lastNote['milliseconds.date'] - firstNote['milliseconds.date'];
    if (duration <= rollThresholdMs) return null;

    // by default, no offset shifting is applied
    let noteOffShift: NoteOffShiftValue = 'false';

    const sortedByOffset = sortedByOnset
        .slice()
        .sort((a, b) => a['milliseconds.date.end'] - b['milliseconds.date.end']);
    const sameOrder = sortedByOnset.every((note, i) => note === sortedByOffset[i]);

    const offsetScaleTolerance = 0.8;
    const minOffsetDistance = duration * offsetScaleTolerance;
    if (
        lastNote['milliseconds.date.end'] - firstNote['milliseconds.date.end'] > minOffsetDistance &&
        sameOrder
    ) {
        noteOffShift = 'true';
    }

    // in ms: how far a release may sit from the next onset and still count as one
    // note giving way to the next
    const monophonicTolerance = 20;
    const isMonophonic = pairwise(sortedByOnset).every(
        ([prev, curr]) =>
            Math.abs(prev['milliseconds.date.end'] - curr['milliseconds.date']) <= monophonicTolerance,
    );
    if (isMonophonic) noteOffShift = 'monophonic';

    // `placement: 'estimate'` — the beat is where the chord's onsets average out, which is the
    // only placement a recording can answer for itself (the other three are editorial choices
    // mpm-desk offers a human).
    const onsetMs =
        sortedByOnset.reduce((sum, note) => sum + note['milliseconds.date'], 0) / arpeggioNotes.length;
    const frameStartMs = firstNote['milliseconds.date'] - onsetMs;

    // determine the ornament's intensity
    const normalizedOnsets = sortedByOnset
        .map((note) => note['milliseconds.date'])
        .map((onset) => (onset - firstNote['milliseconds.date']) / duration);
    const intensity = determineIntensity(normalizedOnsets);

    // Each release travels the same distance as its onset: what is taken out here is the
    // stagger, not the length the note was held for.
    const shiftMs = new Map<string, number>();
    for (const note of sortedByOnset) shiftMs.set(note['xml:id'], onsetMs - note['milliseconds.date']);

    return {
        date,
        noteOrder,
        frameStartMs,
        frameLengthMs: duration,
        intensity,
        noteOffShift,
        onsetMs,
        shiftMs,
    };
};

/** A `<dynamicsGradient>`'s two numbers, in the normalized units `transition.from/to` use. */
export type GradientRange = { readonly from: number; readonly to: number };

/**
 * `@scale`: how big the velocity ramp across a roll is, given the shape it is drawn on.
 *
 * MPM splits the shading of an ornament into a *shape* on the `<ornamentDef>` — two numbers in
 * [-1, 1] — and a *size* on the `<ornament>` that multiplies it. The split is not unique:
 * `scale 7` over a `1 → 0` ramp and `scale 3.5` over a `1 → −1` one are the same seven
 * velocity units. mpm-desk resolves it by letting a human choose the shape (a crescendo and a
 * decrescendo default) and fitting only the scale, which is why Grünfeld's ornament defs carry
 * four different shapes; the student's shape is copied from the reference for the same reason
 * the accentuation pattern is, and this is the scale that goes with it.
 *
 * The formula is mpm-desk's, and so is the refusal: a flat chord (`diffVel === 0`) or a shape
 * with no ramp in it (`diffGradient === 0`) has no scale to state, and answers null rather
 * than a zero that would read as "played perfectly evenly".
 */
// adapted from mpm-desk@dffb6c1 src/fitting/transformers/ornamentation/InsertDynamicsGradient.ts:110-127
export const gradientScale = (
    chord: readonly MeasuredNote[],
    gradient: GradientRange | null,
): number | null => {
    if (!gradient) return null;
    const sorted = chord
        .filter((note) => Number.isFinite(note['milliseconds.date']))
        .slice()
        .sort((a, b) => a['milliseconds.date'] - b['milliseconds.date']);
    if (sorted.length < 2) return null;

    const diffVel = sorted[sorted.length - 1].velocity - sorted[0].velocity;
    if (diffVel === 0) return null;

    const diffGradient = gradient.to - gradient.from;
    if (diffGradient === 0) return null;

    return diffVel / diffGradient;
};
