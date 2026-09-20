/**
 * What the client sends to be decided on: one window of playing, priced against Grünfeld.
 *
 * This is the wire contract for `POST /decide`. The client builds it from a window's
 * `structuredDiff`; `client/src/services/decide.ts` holds the matching shape.
 */

/** The dimensions a short window can identify. `LIVE.md` §1 says why the others cannot. */
const LIVE_DIMENSIONS = ['tempo', 'dynamics'] as const;

type LiveDimension = typeof LIVE_DIMENSIONS[number];

export const isLiveDimension = (value: unknown): value is LiveDimension =>
    typeof value === 'string' && (LIVE_DIMENSIONS as readonly string[]).includes(value);

/** One priced departure, as `mpm/diff.ts` reports it. */
export type Deviation = {
    /** `m5.2`, from `tickToPos`. */
    readonly at: string;
    readonly dimension: string;
    readonly attribute: string;
    readonly severity: string;
    readonly direction: string;
    /** The German cue the diff already chose. */
    readonly cue: string;
    readonly gruenfeld: number;
    readonly student: number;
};

/** A point Grünfeld has already made, so he does not make it twice. */
export type Correction = {
    readonly bar: number;
    readonly dimension: string;
    readonly times: number;
};

export type DecisionState = {
    readonly position: string;
    readonly barsMeasured: string;
    readonly handsOffKeys: boolean;
    readonly alreadyCorrectedThisLesson: readonly Correction[];
    readonly deviations: readonly Deviation[];
};

/**
 * The reading the questions are asked against.
 *
 * Kept short deliberately: there is no prompt caching, so every call re-sends and re-bills this,
 * and the document dominates both the token bill and the latency tail.
 */
const READING =
    'Alfred Grünfeld, Welte-Mignon roll 1905. Unhurried, long phrases, the inner voices under '
    + 'the melody. He does not push the tempo and releases tension only at the cadence. He teaches '
    + 'by playing, comes in often and early, and plays fragments rather than whole passages.';

/** The `state` field of a Jev request. */
export const stateFor = (decision: DecisionState) => ({
    piece: 'Robert Schumann, Träumerei op. 15 nr. 7',
    reading: READING,
    position: decision.position,
    bars_measured: decision.barsMeasured,
    hands_off_keys: decision.handsOffKeys,
    already_corrected_this_lesson: decision.alreadyCorrectedThisLesson,
    deviations: decision.deviations,
});
