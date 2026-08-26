/**
 * The comparison: espressivo's JND layer over the paired instructions.
 *
 * `pair.ts` answers "which instruction differs, and by how much, in the units the cue table is
 * written in". It cannot answer "would anyone hear it" — the noise floor in `THRESHOLDS` is a
 * per-attribute constant, not a perceptual one, and four dimensions that were silent until this
 * rewrite are now live at once (risk R8). `compareMpm` integrates both documents into
 * just-noticeable differences over the take's window and supplies what an instruction pair
 * cannot:
 *
 * 1. **the audibility gate** — a whole type is dropped when the two performances are
 *    indistinguishable in it (§{@link audibilityGate});
 * 2. **the fallback curve** — where the student's fitter could not write a slot, the resolved
 *    curves still have a value at that date (§{@link profileFallback});
 * 3. **localisation** — which bars carry the difference, and whether it is a level or a shape
 *    (§{@link localisationHeader}); prose for the summary's header, never a `StructuredDiffEvent`;
 * 4. **the direction cross-check** — one number that says whether the two derivations agree
 *    about who did more (§{@link crossCheckDirections}).
 *
 * **Orientation.** `a` is the student and `b` is the reference, on every call, forever. The
 * report does not record which side was which (`inputs` echoes settings only), so this is an
 * asserted constant with a test rather than a convention: `meanSigned > 0` means *the student
 * exceeds*, the same polarity as `delta = student − ref` in `diff.ts:113`, so nothing is
 * flipped anywhere. `cumulativeDrift` is never read — it is a duration and its polarity is the
 * opposite one.
 *
 * **Which reference.** `b` is the *fitted* reference (`client/public/reference.fitted.mpm`),
 * not `performance.mpm`. Both sides then come out of one procedure and the fit-vs-bake bias
 * cancels; see `scripts/fit-reference.ts` for the measurement that forced it.
 */
import {
    Mpm,
    compareMpm,
    type ComparisonDimension,
    type ComparisonReport,
} from 'espressivo';
import { cutPairToRange } from './cut';
import { ATTRS_TO_COMPARE, diffFrom, diffStructuredFrom } from './diff';
import { ornamentStylesOf, pairInstructions } from './pair';
import {
    DIFF_TYPES,
    type DiffType,
    type InstructionDiff,
    type OrnamentStyleLookup,
    type Range,
    type StructuredDiffEvent,
} from './types';
import { PPQ, tickToPos } from '../shared/constants';

/**
 * `a` is the student. One constant, one test, and the reason the whole file can speak about
 * signs at all.
 */
export const A_IS_STUDENT = true;

/** The diff's seven types, as espressivo's eleven dimensions name them. */
export const DIMENSION_OF: Record<DiffType, ComparisonDimension> = {
    tempo: 'tempo',
    dynamics: 'dynamics',
    rubato: 'rubato',
    articulation: 'articulation',
    accentuationPattern: 'accentuation',
    ornament: 'ornamentation',
    asynchrony: 'asynchrony',
};

/**
 * The weights that define this application's metric.
 *
 * Five dimensions are zero because nothing in the evidence path can measure them, on either
 * side: `cut.ts` drops the movement map from both cut documents (so `pedal` has no student
 * answer and never will until Web MIDI gives us CC64), the reconstruction declares no
 * `<asynchrony>` and the student's fitter writes none, and neither document declares an
 * imprecision map. Left at 1 they would contribute nothing today and everything on the day one
 * side acquired such a map — an aggregate that moved for a difference the teacher cannot see.
 *
 * The six that remain are equal at 1. Risk R8's rule: when the teacher gets too loud, lower an
 * entry here — never a `THRESHOLD`, which is quoted verbatim in the server's prompt.
 */
export const TAKE_WEIGHTS: Partial<Record<ComparisonDimension, number>> = {
    tempo: 1,
    dynamics: 1,
    rubato: 1,
    accentuation: 1,
    articulation: 1,
    ornamentation: 1,
    asynchrony: 0,
    pedal: 0,
    imprecisionTiming: 0,
    imprecisionDynamics: 0,
    imprecisionDuration: 0,
};

/** The dimensions whose curve the profile fallback and the localisation header read. */
const PROFILED: readonly ComparisonDimension[] = ['tempo', 'dynamics', 'rubato', 'accentuation'];

/** Quarters. One sample per sixteenth — fine enough to place a slot, cheap enough to keep. */
const PROFILE_STEP = 0.25;

// ── 1. the audibility gate ───────────────────────────────────────────────────────────────

/** One just-noticeable difference sustained through the window: the threshold of "audible". */
export const JND_FLOOR = 1;

/** Above this share of the difference sitting below threshold, the type is not worth naming. */
export const SUB_THRESHOLD_CEILING = 0.95;

export type Suppression = {
    readonly type: DiffType;
    readonly dimension: ComparisonDimension;
    readonly reason: string;
};

/**
 * Which types the take may not speak about.
 *
 * Three arms, any one of which silences a whole type — before the top-3 selection, so the ASCII
 * summary loses the section too rather than printing a heading over nothing:
 *
 * - `state === 'both-neutral'` — neither document says anything about this dimension. There is
 *   no difference to have an opinion about;
 * - `equivalence.byDimension[k].subThresholdMassFraction > 0.95` — 95 % of what difference there
 *   is sits below threshold;
 * - `mean < 1 JND` — the whole window's difference, sustained, is under one just-noticeable
 *   difference.
 *
 * This is a *second* floor above `THRESHOLDS`, never a replacement: an attribute still has to
 * clear its raw floor to become a peak at all (semantics 19). The gate is what keeps four newly
 * measured dimensions from turning every take into twenty-one findings.
 */
export const audibilityGate = (report: ComparisonReport): Map<DiffType, Suppression> => {
    const suppressed = new Map<DiffType, Suppression>();

    for (const type of DIFF_TYPES) {
        const dimension = DIMENSION_OF[type];
        const measured = report.dimensions[dimension];
        const equivalence = report.equivalence.byDimension[dimension];
        const mean = measured.mean;

        const reason =
            measured.state === 'both-neutral'
                ? 'both sides neutral'
                : equivalence.subThresholdMassFraction > SUB_THRESHOLD_CEILING
                  ? `${(equivalence.subThresholdMassFraction * 100).toFixed(0)}% of it is below threshold`
                  : mean === null || mean < JND_FLOOR
                    ? `${(mean ?? 0).toFixed(2)} JND — under one`
                    : null;

        if (reason !== null) suppressed.set(type, { type, dimension, reason });
    }

    return suppressed;
};

// ── 2. the fallback curve for slots the fitter could not write ───────────────────────────

/** What `FitResult.skipped` carries, structurally — `mpm/` does not import from `student/`. */
export type SkippedSlot = {
    readonly type: string;
    readonly xmlId: string;
    readonly date: number;
    readonly reason: string;
};

/**
 * The two types whose profile curve is the same quantity the diff compares.
 *
 * `tempo`'s curve is `ln(quarter-bpm)` and every `<tempo>` in this reconstruction carries
 * `beatLength="0.25"`, so inverting the log gives the slot's `@bpm` exactly; `dynamics`'
 * is `ln(volume)`, which inverts to the 0–127 `@volume`. The other two profiles are *not*
 * substitutable: `rubato`'s curve is a displacement in quarters and `accentuation`'s a velocity,
 * while the attributes the diff compares there are `@intensity` (a power exponent) and `@scale`
 * (a dimensionless multiplier on a pattern). Emitting one under the other's name would hand the
 * cue table a number in the wrong unit, and the cue table is what the student hears. A slot of
 * those types that the fitter skipped stays silent, and stays in `skipped`.
 */
const FALLBACK_ATTR: Partial<Record<DiffType, string>> = {
    tempo: 'bpm',
    dynamics: 'volume',
};

/** The inverse of the profile's forward map: `log-around-1` is a logarithm, `gain` is identity. */
const fromSpace = (space: string, value: number): number =>
    space === 'log-around-1' || space === 'log-around-center' ? Math.exp(value) : value;

/**
 * A slot the student's fitter could not answer for, priced off the resolved curves instead.
 *
 * The value is still there to be read: an instruction prevails until the next one, so at a date
 * where the student wrote nothing the previous element is what sounds, and that is what the
 * profile evaluates. Logged, never silent — every skipped slot either becomes one of these or
 * stays in `skipped` with its reason.
 */
export const profileFallback = (
    report: ComparisonReport,
    skipped: readonly SkippedSlot[],
    range: Range,
): InstructionDiff[] => {
    const profiles = report.profiles;
    if (!profiles) return [];
    const emitted: InstructionDiff[] = [];

    for (const slot of skipped) {
        const type = slot.type as DiffType;
        const attr = FALLBACK_ATTR[type];
        if (attr === undefined) continue;
        if (slot.date < range.from || slot.date > range.to) continue;

        const profile = profiles[DIMENSION_OF[type]];
        if (!profile.valueA || !profile.valueB || profile.dates.length === 0) continue;

        const quarters = slot.date / PPQ;
        let nearest = 0;
        for (let i = 1; i < profile.dates.length; i++) {
            if (Math.abs(profile.dates[i] - quarters) < Math.abs(profile.dates[nearest] - quarters)) nearest = i;
        }

        const ref = fromSpace(profile.space, profile.valueB[nearest]);
        const student = fromSpace(profile.space, profile.valueA[nearest]);
        if (!Number.isFinite(ref) || !Number.isFinite(student)) continue;

        emitted.push({
            date: slot.date,
            type,
            diffs: { [attr]: { ref, student, delta: student - ref } },
            magnitude: Math.abs(student - ref),
        });
    }

    return emitted;
};

// ── 3. localisation ──────────────────────────────────────────────────────────────────────

/**
 * Whether a dimension's difference is a level or a shape, in the report's own terms.
 *
 * `decomposition` splits the difference into how far apart the two curves sit on average
 * (`level`) and how differently they move (`shape`): "simply slower" against "shaped
 * differently" is the distinction, and it is the one thing in the report a teacher would say
 * out loud unprompted.
 */
const shapeOrLevel = (report: ComparisonReport, dimension: ComparisonDimension): string => {
    const decomposition = report.dimensions[dimension].decomposition;
    if (!decomposition) return '';
    if (decomposition.shapeless) return ', level only';
    const level = Math.abs(decomposition.levelSigned);
    const shape = decomposition.shape ?? 0;
    return shape > level ? ', shaped differently' : ', simply more of it';
};

/**
 * The header the ASCII summary opens with: how big, where, and in what.
 *
 * Positions are `tickToPos`, never espressivo's `segment.measure.start.number`. The score opens
 * with an anacrusis (`<measure metcon="false" n="1">`), so the two numberings differ by a bar,
 * and the teacher may only name a place in the vocabulary the plan validator accepts and the
 * corpus spans are recorded in (semantics 23). The segment *boundaries* are espressivo's; the
 * words for them are ours.
 *
 * When `segments` is empty — which is the normal case for a take that sits under threshold, and
 * the case the docs warn about at `docs/comparison.md:348-354` — the header states the size and
 * says nothing about place: the diff's own table is chronological and does that job. The same
 * silence applies when the gate closed on every type: a take whose difference is entirely
 * inaudible still produces segments (they are cut out of the aggregate density, which is never
 * exactly zero), and localising a difference nobody may speak about would be noise with bar
 * numbers on it.
 */
export const localisationHeader = (
    report: ComparisonReport,
    range: Range,
    suppressed: ReadonlyMap<DiffType, Suppression> = audibilityGate(report),
): string => {
    const posOf = (quarters: number): string => tickToPos(Math.round(quarters * PPQ));
    const aggregate = report.aggregate.mean ?? 0;
    const below = report.equivalence.subThresholdMassFraction;

    const lines = [
        `Comparison over ${tickToPos(range.from)}–${tickToPos(range.to)}: ` +
            `${aggregate.toFixed(2)} JND, ${(below * 100).toFixed(0)}% of it below threshold.`,
    ];

    for (const type of DIFF_TYPES) {
        if (suppressed.has(type)) continue;
        const dimension = DIMENSION_OF[type];
        const measured = report.dimensions[dimension];
        const signed = measured.meanSigned;
        const who =
            signed === null || !Number.isFinite(signed)
                ? ''
                : signed > 0
                  ? ', student greater'
                  : signed < 0
                    ? ', student smaller'
                    : '';
        lines.push(`  ${type}: ${(measured.mean ?? 0).toFixed(2)} JND${who}${shapeOrLevel(report, dimension)}`);
    }

    if (suppressed.size === DIFF_TYPES.length) return lines.join('\n');

    for (const segment of report.segments.slice(0, 3)) {
        lines.push(
            `  ${posOf(segment.startQuarters)}–${posOf(segment.endQuarters)}: ` +
                `peak ${segment.peak.toFixed(1)} JND/quarter, ${segment.direction.replace('a-', 'student ').replace('b-', 'reference ')}`,
        );
    }

    return lines.join('\n');
};

// ── 4. the direction cross-check ─────────────────────────────────────────────────────────

/**
 * How a dimension's `meanSigned` relates to the sign of `delta = student − ref` on the
 * attribute the cue table speaks about.
 *
 * `+1` — the two agree, because the comparison's T-space is a monotone function of the very
 * attribute the diff compares: tempo is `ln(quarter-bpm)` against `@bpm` (every `<tempo>` in
 * this reconstruction carries `beatLength="0.25"`), dynamics is `ln(volume)` against `@volume`.
 *
 * `-1` — they are opposite. Rubato's T-space is the displacement δ in quarters, and MPM warps a
 * frame by `t ↦ frameLength·(t/frameLength)^intensity`: a *larger* `@intensity` pulls every note
 * inside the frame *earlier*. Measured on a take whose rubato was scaled ×1.5, ×2 and ×2.5, the
 * raw `@intensity` deltas were `+0.47` and `meanSigned` `−0.030`, `−0.051`, `−0.066` — monotone
 * and inverted. This is the sign trap the scout's §4.2 warns about, and it is why this is a
 * table rather than a `Math.sign` comparison.
 *
 * `0` — no cross-check is possible, and the reason differs per row:
 *
 * - `articulation` and `ornamentation` accumulate over rows in four different units and report
 *   `meanSigned: null` by construction;
 * - `accentuationPattern`'s `@scale` is a *magnitude* on a pattern whose own values are signed.
 *   Whether scaling it up raises or lowers the accent curve depends on the def's shape and on
 *   where the window falls. Measured: a student accenting ×2, ×5 and ×10 more than the
 *   reference gave `meanSigned` `−0.14`, `−0.81`, `−1.92` — increasingly *negative* for
 *   increasingly *positive* `@scale` deltas. There is no fixed sign to check against;
 * - `asynchrony` is never fitted.
 */
const SIGN_AGREEMENT: Record<DiffType, 1 | -1 | 0> = {
    tempo: 1,
    dynamics: 1,
    rubato: -1,
    accentuationPattern: 0,
    articulation: 0,
    ornament: 0,
    asynchrony: 0,
};

export type DirectionDisagreement = {
    readonly type: DiffType;
    readonly meanSigned: number;
    readonly medianDelta: number;
};

const median = (values: readonly number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Does the integrated curve agree with the paired instructions about who did more?
 *
 * Two independent derivations of one performance: one reads the document's attributes, the
 * other renders both documents and integrates the difference. They can disagree — a student who
 * writes a higher `@bpm` at every boundary but spends the bar inside a rubato that eats it, for
 * instance — and when they do, something is wrong with a fit or with a sign.
 *
 * Only asked where the question is well formed. `meanSigned` is a *net level* statement, and a
 * dimension whose difference is mostly shape has no net level worth the name: a take whose
 * rubato was scaled ×1.5 reads `tempo` at 3.46 JND with `|levelSigned| = 0.016` against
 * `shape = 0.58` — the two tempo curves cross each other repeatedly and neither side is
 * "faster". Asking who did more there and failing the suite on the answer would be measuring
 * noise. So the check runs where `decomposition` says the difference is level-dominated, which
 * is exactly where the comparison itself would say "simply faster" rather than "shaped
 * differently".
 *
 * The suite fails on a disagreement. In production it is logged and **the instruction pair
 * wins**, because the cue table, the severity ladder and the German phrases are all calibrated
 * on raw deltas; the comparison is the second opinion, not the first.
 */
export const crossCheckDirections = (
    report: ComparisonReport,
    peaks: readonly InstructionDiff[],
): DirectionDisagreement[] => {
    const disagreements: DirectionDisagreement[] = [];

    for (const type of DIFF_TYPES) {
        const agreement = SIGN_AGREEMENT[type];
        if (agreement === 0) continue;

        const measured = report.dimensions[DIMENSION_OF[type]];
        const meanSigned = measured.meanSigned;
        if (meanSigned === null || !Number.isFinite(meanSigned) || meanSigned === 0) continue;

        const decomposition = measured.decomposition;
        if (!decomposition) continue;
        if (!decomposition.shapeless && Math.abs(decomposition.levelSigned) < (decomposition.shape ?? 0)) continue;

        // The level attribute of the type — the quantity `meanSigned` is about.
        const attr = ATTRS_TO_COMPARE[type]?.[0];
        const deltas = peaks
            .filter((peak) => peak.type === type && peak.diffs[attr] !== undefined)
            .map((peak) => peak.diffs[attr].delta);
        if (deltas.length === 0) continue;

        const medianDelta = median(deltas);
        if (medianDelta === 0) continue;
        if (Math.sign(medianDelta) === Math.sign(meanSigned) * agreement) continue;

        disagreements.push({ type, meanSigned, medianDelta });
    }

    return disagreements;
};

// ── the one call the take makes ──────────────────────────────────────────────────────────

export type TakeEvidenceInput = {
    /** The **fitted** reference, as text — `client/public/reference.fitted.mpm`. */
    readonly referenceMpmText: string;
    /** The student's performance, as `fitStudent` wrote it. */
    readonly studentMpmText: string;
    /** The score as MSM text. Part of the metric: the window, the measures, the beat grid. */
    readonly scoreMsm: string;
    readonly range: Range;
    /** `FitResult.skipped` — the input to the profile fallback. */
    readonly skipped?: readonly SkippedSlot[];
    readonly weights?: Partial<Record<ComparisonDimension, number>>;
    readonly perTypeN?: number;
};

export type TakeEvidence = {
    /** What `diff.ts` consumes: the paired instructions, gated, with the fallbacks folded in. */
    readonly peaks: readonly InstructionDiff[];
    readonly structuredDiff: StructuredDiffEvent[];
    readonly diffSummary: string;
    readonly report: ComparisonReport;
    readonly suppressed: ReadonlyMap<DiffType, Suppression>;
    readonly disagreements: readonly DirectionDisagreement[];
    /**
     * Types that survived the gate. Half of DESIGN §3.4's "measured": what the fitter actually
     * wrote is not known here, and `mpm/evidence.ts` intersects this with it.
     */
    readonly measuredTypes: readonly DiffType[];
    readonly ornamentStyles: OrnamentStyleLookup;
};

/**
 * One take's evidence: cut, compare, gate, pair, diff.
 *
 * This is the call that replaces `mpmify(studentMsm, …)` followed by `diff(ref, stu, range)` in
 * the take runner. The cut is only for the comparison — `pairInstructions` reads the whole
 * documents, because an `xml:id` is an `xml:id` wherever it sits, and cutting first would only
 * cost a parse.
 */
export const takeEvidence = (input: TakeEvidenceInput): TakeEvidence => {
    const { referenceMpmText, studentMpmText, scoreMsm, range, skipped = [], weights, perTypeN } = input;

    const { refCut, stuCut } = cutPairToRange(referenceMpmText, studentMpmText, range);
    const { report } = compareMpm({
        a: stuCut,
        b: refCut,
        msm: scoreMsm,
        window: { start: range.from / PPQ, end: range.to / PPQ },
        weights: weights ?? TAKE_WEIGHTS,
        profile: { dimensions: PROFILED, grid: { step: PROFILE_STEP } },
    });

    const suppressed = audibilityGate(report);
    const reference = new Mpm(referenceMpmText);
    const student = new Mpm(studentMpmText);

    const peaks = pairInstructions(reference, student, range, {
        suppressed: new Set(suppressed.keys()),
        fallback: profileFallback(report, skipped, range),
    });

    const ornamentStyles = ornamentStylesOf(reference);
    const measuredTypes = DIFF_TYPES.filter((type) => !suppressed.has(type));

    return {
        peaks,
        structuredDiff: diffStructuredFrom(peaks, range, perTypeN),
        diffSummary: `${localisationHeader(report, range, suppressed)}\n\n${diffFrom(peaks, range, ornamentStyles, perTypeN)}`,
        report,
        suppressed,
        disagreements: crossCheckDirections(report, peaks),
        measuredTypes,
        ornamentStyles,
    };
};
