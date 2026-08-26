/**
 * What the student's document already explains, so the next fit does not explain it again.
 *
 * This is mpmify's `without` discipline (semantics 2) reduced to what a single take needs.
 * Each stage of the fit measures only the part of the recording the stages before it have not
 * accounted for; without that, "you were 12 velocity units louder here" would be a statement
 * about dynamics *plus* accent *plus* articulation, and the teacher would be naming the wrong
 * thing.
 *
 * The residual comes in two halves, and they are taken in two different ways — semantics 11,
 * which is the one piece of mpmify's bookkeeping worth keeping exactly:
 *
 * - **velocity and sounding length** come from *actually rendering* the partially-filled
 *   student MPM through espressivo and subtracting the measurement. Reassembling a velocity by
 *   hand would be new code that has to stay in step with a renderer it does not own; a render
 *   is the renderer's own answer. Two renders per take, ~40 ms each.
 * - **ticks** come from a tempo walk, because a render cannot do it: each tempo boundary
 *   re-anchors on the *recorded* onset (semantics 3), which is what stops a student with steady
 *   rubato but a slightly different tempo from being told their rubato is wrong.
 *
 * The rubato warp itself is espressivo's, reached through mpm-desk's wrapper, copied verbatim.
 */
import {
    computeMillisecondsAt,
    dateAtMilliseconds,
    performMsmToData,
    resolveRubato,
    resolveSpan,
    rubatoAt,
    type AddRubatoOptions,
    type AddTempoOptions,
    type Rubato as ResolvedRubato,
} from 'espressivo';

// ── the render-based half ────────────────────────────────────────────────────────────────

/** One note as the document currently prescribes it: what the fit has to subtract. */
export type RenderedNote = {
    /** Symbolic onset, ticks. */
    readonly date: number;
    /** Symbolic duration, ticks. */
    readonly duration: number;
    /** The velocity the document prescribes — the divisor of `relativeVelocity` (semantics 12). */
    readonly velocity: number;
    /** Sounding onset, ms. */
    readonly msDate: number;
    /** Sounding end, ms. */
    readonly msEnd: number;
};

/**
 * The seed handed to a render, so an imprecision map — which this document never carries, but
 * a future one might — cannot make the residual differ between two runs of the same take.
 * mpmify's own fixed residual seed (semantics 5).
 */
export const RESIDUAL_SEED = 0x6d706d;

/**
 * Render the student's MPM over the score and index the result by note `xml:id`.
 *
 * `expandOrnaments: false` for the same reason mpm-desk uses it: a v3 ornament that generated
 * notes would put notes in the render that are in no measurement, and every one of them would
 * read as a residual nobody played.
 */
export const renderStudent = (
    scoreMsmText: string,
    studentMpmText: string,
): Map<string, RenderedNote> => {
    const data = performMsmToData(
        { msm: scoreMsmText, mpm: studentMpmText },
        { expandOrnaments: false, seed: RESIDUAL_SEED },
    );

    const byId = new Map<string, RenderedNote>();
    for (const part of data.parts) {
        for (const note of part.notes) {
            if (note.id === null) continue;
            byId.set(note.id, {
                date: note.date,
                duration: note.duration,
                velocity: note.velocity,
                msDate: note.milliseconds.date,
                msEnd: note.milliseconds.end,
            });
        }
    }
    return byId;
};

// ── the tick half: a clock over the fitted tempo, re-anchored at every boundary ──────────

/** One fitted `<tempo>` with the span it governs and the onset it was anchored to. */
export type AnchoredTempo = {
    readonly tempo: AddTempoOptions & { endDate: number };
    /** The *recorded* time of this boundary, ms — semantics 3's re-anchoring, made structural. */
    readonly anchorMs: number;
};

/** Ticks ⇄ milliseconds under a fitted tempo map. */
export type TempoClock = {
    /** Where a score tick lands in the recording, ms. */
    readonly msAt: (tick: number) => number;
    /** Where a recorded time lands on the score grid, ticks. */
    readonly tickAt: (ms: number) => number;
};

const lastIndexWhere = <T>(items: readonly T[], predicate: (item: T) => boolean): number => {
    let found = 0;
    for (let i = 0; i < items.length; i++) if (predicate(items[i])) found = i;
    return found;
};

/**
 * The clock the rubato fit measures against.
 *
 * Every span is timed from its own recorded onset rather than from the accumulated total, so
 * an error inside one span cannot travel into the next. That is not an optimisation: it is the
 * difference between measuring a student's rubato and measuring the tempo fit's own drift.
 *
 * An empty span list is the identity-free case and answers with the input, which keeps a take
 * whose tempo could not be fitted from producing `NaN` positions downstream.
 */
export const tempoClock = (spans: readonly AnchoredTempo[], ppq: number): TempoClock => {
    if (spans.length === 0) return { msAt: (tick) => tick, tickAt: (ms) => ms };

    const ordered = [...spans].sort((a, b) => a.tempo.date - b.tempo.date);

    return {
        msAt: (tick) => {
            const i = lastIndexWhere(ordered, (span) => span.tempo.date <= tick);
            const { tempo, anchorMs } = ordered[i];
            return anchorMs + computeMillisecondsAt(tick, tempo, ppq);
        },
        tickAt: (ms) => {
            const i = lastIndexWhere(ordered, (span) => span.anchorMs <= ms);
            const { tempo, anchorMs } = ordered[i];
            return dateAtMilliseconds(ms - anchorMs, resolveSpan(tempo), ppq);
        },
    };
};

// ── the rubato warp ──────────────────────────────────────────────────────────────────────
// copied from mpm-desk@dffb6c1 src/fitting/transformers/rubato/rubatoMath.ts:29-110
// (the forward warp only; `removeRubatoDistortion` is mpm-desk's chain bookkeeping and has
// no counterpart here — the clock above is what takes the tempo off a recorded position.)

/**
 * What this module needs a `<rubato>` to say: where its first frame begins, and the five
 * parameters the warp is built from.
 *
 * Narrower than the whole of `AddRubatoOptions` on purpose — `@name.ref` and `@xml:id` say
 * nothing about where a date lands, and naming only the fields that do lets a caller hand in
 * anything shaped like a frame, which is what the tests do.
 */
export type RubatoFrame = Pick<
    AddRubatoOptions,
    'date' | 'frameLength' | 'intensity' | 'lateStart' | 'earlyEnd' | 'loop'
>;

/**
 * One `<rubato>` record with its parameters defaulted and clamped the way the renderer does it.
 *
 * The defaulting and the clamping are the renderer's, not written out here. Written out, they
 * drift from meico in two ways that a perfectly ordinary document reaches: capping `lateStart`
 * at 0.9 and flooring `earlyEnd` at 0.1 (neither bound exists in meico), and leaving an
 * inverted or empty window inverted, producing a *reversed* warp where meico widens it to the
 * whole frame and produces the identity. Measured on a 720-tick frame read at its midpoint,
 * four of seven test windows disagreed, by up to 72 ticks. `resolveRubato` is the renderer's
 * own resolution and settles all of it, in RubatoMap.java's order, including the `@intensity`
 * default of 1.0.
 *
 * `null` where there is no frame to warp — an absent `@frameLength`, which is the one parameter
 * with no default. Without the early return the span arithmetic divides by `undefined` and
 * hands back `NaN`.
 *
 * The `def` argument is `null` because no `<rubatoDef>` is modelled here: every parameter is
 * written onto the instruction.
 */
const resolve = (rubato: RubatoFrame): ResolvedRubato | null => {
    if (rubato.frameLength === undefined) return null;

    return resolveRubato(
        { startDate: rubato.date, endDate: rubato.date + rubato.frameLength },
        {
            frameLength: rubato.frameLength,
            intensity: rubato.intensity,
            lateStart: rubato.lateStart,
            earlyEnd: rubato.earlyEnd,
            loop: rubato.loop,
        },
        null,
    );
};

/**
 * Where a symbolic date lands once the rubato has warped its frame.
 *
 * espressivo's `rubatoAt`. An unresolvable rubato leaves the date where it was, which is what
 * an identity warp means.
 */
export const calculateRubatoOnDate = (date: number, rubato: RubatoFrame): number => {
    const rd = resolve(rubato);
    if (rd === null) return date;
    return rubatoAt(rd, date);
};
