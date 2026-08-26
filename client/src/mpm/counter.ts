/**
 * The counter-performance: Grünfeld pushed away from the student, capped, confined to the
 * passage the teacher wants heard.
 *
 * ```
 * exaggerateMpm(performance.mpm, { factors, center: the student's own levels })   espressivo
 *   → spliceCapped(canonicalMpm(performance.mpm), pushed, demoRange)              our discipline
 * ```
 *
 * **Why `center`.** Espressivo's exaggeration is `x' = μ·(x/μ)^s` with μ the population's own
 * geometric mean, so by default it pushes Grünfeld away from *himself*. Move the fixed point
 * onto the student — `μ = student level` — and the closed form becomes
 * `student·(ref/student)^s`, which is semantics 27's `ref·(ref/student)^a` exactly, with
 * `s = 1 + a`. That substitution is the whole reason this module can be four calls where
 * `mpm/exaggerate.ts` was a hand-written log-space walk.
 *
 * **Why the splice.** `center` reaches tempo and dynamics only (`CenterOverrides` has no other
 * field), the exaggeration is whole-document (there is no range-scoped API), and espressivo's
 * per-element clamps are not our pedagogical ceilings. So the transformed document is never
 * handed to the renderer: it is a *source of values*. `spliceCapped` walks it beside the
 * canonical reference and copies, for the instructions inside the demo range only, the
 * attributes `EXAGGERATION_SPEC` names, each clamped to `ref ± maxAbsDelta` and into its
 * bounds. Everything else — every out-of-range instruction, every attribute the table does not
 * name, Grünfeld's whole pedal — is the reference's own byte. That is semantics 28 (the caps),
 * 30 (nothing shared is mutated: text in, text out) and 31 (range confinement) in one pass, and
 * it is exact rather than approximate because espressivo guarantees the two documents have the
 * same skeleton (`src/api/expression.ts:204-211`): the walk is index-aligned by construction.
 *
 * **Two guards against the bake-vs-fit bias.** `performance.mpm` was drawn by hand and the
 * student's document is solved from onsets, and the gap between those two ways of writing one
 * performance measured 22 bpm and 9.2 JND on a take where the playing was identical (S4 §2).
 * Nothing here may price one against the other. So: the exaggeration only ever runs on
 * dimensions the take actually *measured* (`measured`, the audibility gate's list intersected
 * with what the fitter wrote), and every value the splice writes has to move away from the
 * student in the direction the **fitted** comparison found — a fitted-vs-fitted sign applied to
 * an editorial-vs-editorial move. A push that would move Grünfeld *toward* this student is
 * dropped and his own value stands, whatever the level pivot computed. That is the per-slot
 * protection `center` cannot give, since a level is one number for the whole passage.
 *
 * `EXAGGERATION_SPEC`, `EXAGGERATION_TUNING`, `applyExaggerationCap`,
 * `DEFAULT_EXAGGERATION_STRENGTH` and `allDimensions` come over from `mpm/exaggerate.ts`
 * unchanged (contract 7); what is gone is the formula they used to cap.
 */
import {
    EXPRESSION_DIMENSIONS,
    Mpm,
    allChildElements,
    canonicalMpm,
    exaggerateMpm,
    parentElement,
    weightedFactors,
    type Element,
    type ExpressionDimension,
} from 'espressivo';
import type { Range, StructuredDiffEvent } from './types';

/** How far one deviation type gets pushed, as the lesson plan asks for it. */
export type ExaggerationDimension = { type: string; strength: number };

/** The aggressiveness the fixed-pedagogy pipeline always used. */
const DEFAULT_EXAGGERATION_STRENGTH = 0.2;

/** The plan's two-sided clamp, re-applied here so a caller that skipped `lessonPlan.ts` cannot
 * hand espressivo an exponent nothing downstream would survive (semantics 29, both sides). */
const STRENGTH_MIN = 0.05;
const STRENGTH_MAX = 0.5;

const EXAGGERATION_TUNING: Record<string, Record<string, { strength: number; maxAbsDelta: number }>> = {
    dynamics: {
        volume: { strength: 0.45, maxAbsDelta: 12 },
        'transition.to': { strength: 0.45, maxAbsDelta: 12 },
    },
    tempo: {
        bpm: { strength: 0.35, maxAbsDelta: 10 },
        'transition.to': { strength: 0.35, maxAbsDelta: 10 },
    },
    articulation: {
        relativeDuration: { strength: 0.5, maxAbsDelta: 0.2 },
        relativeVelocity: { strength: 0.45, maxAbsDelta: 0.2 },
    },
    rubato: {
        intensity: { strength: 0.25, maxAbsDelta: 0.15 },
    },
    ornament: {
        scale: { strength: 0.4, maxAbsDelta: 0.8 },
        intensity: { strength: 0.35, maxAbsDelta: 0.25 },
    },
    asynchrony: {
        'milliseconds.offset': { strength: 0.35, maxAbsDelta: 40 },
    },
    accentuationPattern: {
        scale: { strength: 0.4, maxAbsDelta: 0.6 },
    },
};

const EXAGGERATION_SPEC: Record<string, Array<{ attr: string; min: number; max: number }>> = {
    dynamics: [
        { attr: 'volume', min: 1, max: 127 },
        { attr: 'transition.to', min: 1, max: 127 },
    ],
    tempo: [
        { attr: 'bpm', min: 10, max: 300 },
        { attr: 'transition.to', min: 10, max: 300 },
    ],
    articulation: [
        { attr: 'relativeDuration', min: 0.1, max: 5 },
        { attr: 'relativeVelocity', min: 0.1, max: 5 },
    ],
    rubato: [
        { attr: 'intensity', min: 0.01, max: 10 },
    ],
    ornament: [
        { attr: 'scale', min: 0.1, max: 20 },
        { attr: 'intensity', min: 0.01, max: 10 },
    ],
    asynchrony: [
        { attr: 'milliseconds.offset', min: -500, max: 500 },
    ],
    accentuationPattern: [
        { attr: 'scale', min: 0, max: 10 },
    ],
};

const applyExaggerationCap = (
    refVal: number,
    exaggeratedVal: number,
    maxAbsDelta: number,
    min: number,
    max: number,
): number => {
    const lower = Math.max(min, refVal - maxAbsDelta);
    const upper = Math.min(max, refVal + maxAbsDelta);
    return Math.max(lower, Math.min(upper, exaggeratedVal));
};

/** Every shapeable dimension at one strength — the pre-Phase-3 behaviour. */
export const allDimensions = (
    strength: number = DEFAULT_EXAGGERATION_STRENGTH,
): ExaggerationDimension[] =>
    Object.keys(EXAGGERATION_SPEC).map((type) => ({ type, strength }));

// ── where the reference states each attribute ────────────────────────────────────────────

/**
 * Every element name that carries one of `EXAGGERATION_SPEC`'s attributes, and what it is
 * scoped by.
 *
 * `dated` is an instruction: it has an `@date` and is in range when that date is. `def` is a
 * header definition, which has no date of its own — it is in range when *every* instruction in
 * the document that references it is (see {@link defsInRange}). That is the strict reading of
 * semantics 31: a def shared with a passage outside the demo could not be touched without
 * changing how that passage sounds, and a `<style>`-scoped `legato` is exactly such a def.
 *
 * Both readings are needed because Grünfeld's document spells one quantity in two places:
 * `<ornament @scale>` on the instruction, `<temporalSpread @intensity>` on the def it names —
 * which is also where `mpm/pair.ts` reads `ornament.intensity` from, so the caps line up with
 * the numbers the teacher quotes.
 */
const SPLICE_SITES: Record<string, { readonly type: string; readonly scope: 'dated' | 'def' }> = {
    tempo: { type: 'tempo', scope: 'dated' },
    dynamics: { type: 'dynamics', scope: 'dated' },
    rubato: { type: 'rubato', scope: 'dated' },
    accentuationPattern: { type: 'accentuationPattern', scope: 'dated' },
    asynchrony: { type: 'asynchrony', scope: 'dated' },
    articulation: { type: 'articulation', scope: 'dated' },
    ornament: { type: 'ornament', scope: 'dated' },
    articulationDef: { type: 'articulation', scope: 'def' },
    temporalSpread: { type: 'ornament', scope: 'def' },
};

/** The instruction element whose `@name.ref` reaches a def of this element name. */
const DEF_REFERRERS: Record<string, string> = {
    articulationDef: 'articulation',
    ornamentDef: 'ornament',
};

// ── aiming the exaggeration ──────────────────────────────────────────────────────────────

/**
 * Legacy diff type → the espressivo dimension whose registry rows write the attributes
 * `EXAGGERATION_SPEC` names.
 *
 * A subset of `EXPRESSION_DIMENSION_CORRESPONDENCE` (asserted by a test), narrowed to the rows
 * the splice can actually carry: `tempoShape`'s `@meanTempoAt`, `dynamicsShape`'s
 * `@curvature`/`@protraction`, `ornamentSpread`'s frame and `ornamentDynamics`' gradient are
 * all real levers of espressivo's, and all absent from the tuning table — pushing them would
 * produce values the splice then discards, and a report that overstates what was done.
 * `ornament` aims at `ornamentSpacing` because that is where `<temporalSpread @intensity>`
 * lives; `<ornament @scale>` has no registry row at all, so `@scale` is spliceable in
 * principle and never moves in practice.
 */
const EXPRESSION_DIMENSION_OF: Record<string, ExpressionDimension> = {
    tempo: 'tempo',
    dynamics: 'dynamics',
    rubato: 'rubato',
    articulation: 'articulation',
    accentuationPattern: 'accentuation',
    ornament: 'ornamentSpacing',
    asynchrony: 'asynchrony',
};

/**
 * The scale space each spliceable attribute is exaggerated in, as its registry row declares it
 * — `ratio` for `log-around-1` (neutral 1), `gain` for the two gain families (neutral 0).
 *
 * Read only to decide which way the push has to go; the transform itself is espressivo's.
 */
const PIVOT_SPACES: Record<string, Record<string, 'ratio' | 'gain'>> = {
    rubato: { intensity: 'ratio' },
    articulation: { relativeDuration: 'ratio', relativeVelocity: 'ratio' },
    ornament: { scale: 'ratio', intensity: 'ratio' },
    accentuationPattern: { scale: 'gain' },
    asynchrony: { 'milliseconds.offset': 'gain' },
};

/** The student's own level, as espressivo's fixed point wants it: one number per dimension. */
type StudentCenter = { tempo?: number; dynamics?: number };

/** What `student/fit.ts` measured, in the shape `FitResult.levels` has. */
export type StudentLevels = {
    readonly student: {
        readonly bpm: readonly number[];
        readonly volume: readonly number[];
    };
};

const geoMean = (values: readonly number[]): number | undefined => {
    const usable = values.filter((value) => Number.isFinite(value) && value > 0);
    if (usable.length === 0) return undefined;
    return Math.exp(usable.reduce((sum, value) => sum + Math.log(value), 0) / usable.length);
};

/**
 * The take's fixed point: the geometric means of what the student actually played.
 *
 * `@bpm` needs no normalisation into espressivo's quarter-note unit here because the fitter
 * copies the reference's `@beatLength` into every slot and Grünfeld's sixty `<tempo>` elements
 * are all at `0.25` — `bpm · 0.25 · 4 = bpm`. A reference with mixed beat lengths would have to
 * carry them alongside the levels; `counter.test.ts` fails if `performance.mpm` ever grows one.
 */
export const studentCenter = (levels: StudentLevels): StudentCenter => ({
    tempo: geoMean(levels.student.bpm),
    dynamics: geoMean(levels.student.volume),
});

const forward = (space: 'ratio' | 'gain', value: number): number =>
    space === 'ratio' ? Math.log(value) : value;

/**
 * Which side of its neutral the push has to move Grünfeld, for the five dimensions `center`
 * cannot reach.
 *
 * With a fixed neutral the only free choice is the *sign* of the exponent: `s > 1` moves the
 * value further from the neutral, `s < 1` moves it closer. Away from the student is the first
 * where the reference already lies beyond the student, and the second where the student has
 * overshot the reference on the reference's own side — which in the transform space is one
 * condition, `sign(T(ref)) === sign(T(ref) − T(student))`. Each of the type's own diff events
 * casts one vote and the majority wins; a type with no events keeps espressivo's default,
 * away from the neutral.
 *
 * DESIGN §3.5 states this as "student exceeds ⇒ `s < 1`", which is the same rule wherever the
 * reference lies above its neutral — the arpeggio case it argues from. It is the opposite rule
 * where the reference lies below: Grünfeld's rubato intensities run 0.72–0.88 against a neutral
 * of 1, so pulling them toward 1 would move them toward a student who is already above him.
 * The condition above is the general form and reduces to DESIGN's on DESIGN's case.
 */
const pushesOutward = (type: string, events: readonly StructuredDiffEvent[]): boolean => {
    let votes = 0;
    for (const event of events) {
        if (event.type !== type) continue;
        const space = PIVOT_SPACES[type]?.[event.primaryAttr];
        if (!space) continue;
        if (space === 'ratio' && (event.refValue <= 0 || event.studentValue <= 0)) continue;
        const tRef = forward(space, event.refValue);
        const tStudent = forward(space, event.studentValue);
        votes += Math.sign(tRef) * Math.sign(tRef - tStudent);
    }
    return votes >= 0;
};

/** The largest inner strength the type's attributes carry: espressivo aims per dimension, the
 * tuning table per attribute, and the two differ only for `articulation` (0.5 / 0.45) and
 * `ornament` (0.4 / 0.35). The per-attribute number survives exactly where it decides the
 * outcome — in `maxAbsDelta`, which the splice applies attribute by attribute. */
const innerStrengthOf = (type: string): number =>
    Math.max(...Object.values(EXAGGERATION_TUNING[type] ?? {}).map((tuning) => tuning.strength), 0);

/**
 * The lesson plan and the take's evidence, as one `ExaggerationFactors` record.
 *
 * `weightedFactors(2, w)` is the lerp `1 + w·(s − 1)` at `s = 2`, i.e. `1 + w`: the weight
 * vector *is* the per-dimension exponent offset. DESIGN §3.5 writes
 * `weightedFactors(1 + strength, EXPRESSION_WEIGHTS_FOR(dimensions))`, which is the same record
 * whenever every named dimension shares one strength — but the plan gives a strength *per*
 * dimension and a single scalar cannot carry seven of them, so the strength rides in the
 * weight instead. An outward push is `1 + a`, an inward one its reciprocal `1/(1 + a)`, so the
 * two are mirror images in log space.
 *
 * Every dimension is named explicitly, including the ones held at 1: a key missing from
 * `weights` passes the scalar through untouched (`weights.ts:146`), so an omission would
 * exaggerate what nobody asked for.
 */
const factorsFor = (
    dimensions: readonly ExaggerationDimension[],
    events: readonly StructuredDiffEvent[],
    measured: readonly string[] | undefined,
    log: (msg: string) => void,
): { factors: Record<string, number>; named: string[] } => {
    const weights = Object.fromEntries(EXPRESSION_DIMENSIONS.map((d) => [d, 0])) as Record<ExpressionDimension, number>;
    const named: string[] = [];

    for (const dimension of dimensions) {
        const { type } = dimension;
        if (typeof dimension?.strength !== 'number' || !Number.isFinite(dimension.strength)) continue;
        if (!EXAGGERATION_SPEC[type] || named.includes(type)) continue;
        // A dimension the take did not measure has no student behind it: exaggerating it would
        // caricature the *bake*, which is the one thing the counter-performance must not do.
        if (measured !== undefined && !measured.includes(type)) {
            log(`counter: ${type} not measured on this take — Grünfeld's own value stands`);
            continue;
        }

        const target = EXPRESSION_DIMENSION_OF[type];
        const strength = Math.max(STRENGTH_MIN, Math.min(STRENGTH_MAX, dimension.strength));
        const a = strength * innerStrengthOf(type);
        // tempo and dynamics pivot on the student themselves (`center`), so their exponent is
        // always the outward one; the other five have only their neutral to pivot on.
        const outward = target === 'tempo' || target === 'dynamics' || pushesOutward(type, events);
        weights[target] = outward ? a : -a / (1 + a);
        named.push(type);
        log(`counter: ${type} → ${target} s=${(1 + weights[target]).toFixed(4)} (${outward ? 'away from the neutral' : 'toward the neutral'})`);
    }

    return { factors: weightedFactors(2, weights), named };
};

// ── the splice ───────────────────────────────────────────────────────────────────────────

const numberAttribute = (element: Element, name: string): number | null => {
    const raw = element.getAttributeValue(name);
    if (raw === null || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
};

/** Written values are rounded here and nowhere else, so the counter-performance is byte-stable
 * across runs and readable in the document (semantics 5's write-boundary rule). */
const ROUNDING = 6;
const round = (value: number): number => Number(value.toFixed(ROUNDING));

/**
 * The defs no instruction reaches from outside `range`.
 *
 * A def with no referring instruction at all is excluded: it belongs to a passage that is not
 * in this document's demo, and the reference's own value is the safe answer.
 */
const defsInRange = (root: Element, range: Range): Set<string> => {
    const dates = new Map<string, number[]>();
    const collect = (element: Element): void => {
        const referrer = element.getLocalName();
        const nameRef = element.getAttributeValue('name.ref');
        const date = numberAttribute(element, 'date');
        if (nameRef !== null && date !== null) {
            const key = `${referrer}::${nameRef}`;
            const seen = dates.get(key);
            if (seen) seen.push(date);
            else dates.set(key, [date]);
        }
        for (const child of allChildElements(element)) collect(child);
    };
    collect(root);

    const reachable = new Set<string>();
    for (const [defElement, referrer] of Object.entries(DEF_REFERRERS)) {
        for (const [key, seen] of dates) {
            if (!key.startsWith(`${referrer}::`)) continue;
            const name = key.slice(referrer.length + 2);
            if (seen.every((date) => date >= range.from && date <= range.to)) {
                reachable.add(`${defElement}::${name}`);
            }
        }
    }
    return reachable;
};

/**
 * Which way the counter-performance is allowed to move, per slot: `+1` it may only go up, `−1`
 * only down, `0` no opinion.
 *
 * The sign is `−sign(student − reference)` read off the take's own findings, so both sides of
 * it come from the **fitted** documents and the two numbers are commensurable. It is then
 * applied to a move between two *editorial* values. A slot with its own event gets its own
 * sign; the rest of the type follows the median of that type's events, which is the direction
 * the spoken cue names.
 */
type DirectionGuard = {
    readonly bySlot: ReadonlyMap<string, number>;
    readonly byType: ReadonlyMap<string, number>;
};

const median = (values: readonly number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const directionGuard = (events: readonly StructuredDiffEvent[]): DirectionGuard => {
    const bySlot = new Map<string, number>();
    const deltas = new Map<string, number[]>();
    for (const event of events) {
        const delta = event.studentValue - event.refValue;
        if (!Number.isFinite(delta)) continue;
        bySlot.set(`${event.type}::${event.date}`, -Math.sign(delta));
        const seen = deltas.get(event.type);
        if (seen) seen.push(delta);
        else deltas.set(event.type, [delta]);
    }
    const byType = new Map<string, number>();
    for (const [type, values] of deltas) byType.set(type, -Math.sign(median(values)));
    return { bySlot, byType };
};

/** The `@name` of the definition an element belongs to — its own, or its parent def's for a
 * `<temporalSpread>`, which is where the ornament's intensity is spelled. */
const defKeyOf = (element: Element): string | null => {
    const own = element.getAttributeValue('name');
    if (own !== null) return `${element.getLocalName()}::${own}`;
    const parent = parentElement(element);
    const parentName = parent?.getAttributeValue('name') ?? null;
    return parentName === null ? null : `${parent?.getLocalName()}::${parentName}`;
};

/**
 * Copy the exaggerated values onto the reference, capped, for the demo range only.
 *
 * The two documents are index-aligned: `exaggerateMpm` writes no element, no attribute and no
 * `@date`, so `pushed` and `canonicalMpm(reference)` differ in attribute *values* alone. The
 * walk asserts that rather than assuming it — an arity or name mismatch means the guarantee
 * broke and the counter-performance would be silently misassembled.
 *
 * @param referenceMpmText the reference in its canonical form; the result is a copy of it
 * @param pushedMpmText what `exaggerateMpm` returned for the same document
 */
export const spliceCapped = (
    referenceMpmText: string,
    pushedMpmText: string,
    range: Range,
    events: readonly StructuredDiffEvent[] = [],
    log: (msg: string) => void = () => {},
): string => {
    const document = new Mpm(referenceMpmText);
    const pushed = new Mpm(pushedMpmText);
    const target = document.getRootElement();
    const source = pushed.getRootElement();
    if (!target || !source) throw new Error('counter-performance: a document has no root');

    const reachable = defsInRange(target, range);
    const guard = directionGuard(events);
    let writes = 0;
    let capped = 0;
    let refused = 0;

    const walk = (a: Element, b: Element): void => {
        if (a.getLocalName() !== b.getLocalName()) {
            throw new Error(`counter-performance: <${a.getLocalName()}> vs <${b.getLocalName()}> — the exaggeration changed the document's shape`);
        }

        const site = SPLICE_SITES[a.getLocalName()];
        if (site) {
            const date = site.scope === 'dated' ? numberAttribute(a, 'date') : null;
            const inRange = site.scope === 'dated'
                ? date !== null && date >= range.from && date <= range.to
                : (() => {
                    const key = defKeyOf(a);
                    return key !== null && reachable.has(key);
                })();
            const allowed = (date === null ? undefined : guard.bySlot.get(`${site.type}::${date}`))
                ?? guard.byType.get(site.type)
                ?? 0;

            if (inRange) {
                for (const { attr, min, max } of EXAGGERATION_SPEC[site.type]) {
                    const refValue = numberAttribute(a, attr);
                    const pushedValue = numberAttribute(b, attr);
                    if (refValue === null || pushedValue === null) continue;
                    // The engine left this attribute alone — an identity factor, an inert site,
                    // a refusal. Then so does the splice: rounding an untouched value would be
                    // an edit nobody asked for, and would make a dimension the take never
                    // measured show up as changed.
                    if (pushedValue === refValue) continue;

                    // The bias guard. A level pivot is one number for a whole passage, so it
                    // can move a slot that already lies past the student further past *the
                    // level* and yet toward *that slot's* student value. Where the take's own
                    // fitted comparison says which way is away, that sign wins and a push
                    // against it is simply not taken.
                    if (allowed !== 0 && Math.sign(pushedValue - refValue) === -allowed) {
                        refused += 1;
                        continue;
                    }

                    const { maxAbsDelta } = EXAGGERATION_TUNING[site.type]?.[attr] ?? { maxAbsDelta: max };
                    const exact = applyExaggerationCap(refValue, pushedValue, maxAbsDelta, min, max);
                    // Rounded where rounding is free; the exact clamp where it would step over
                    // a bound. A cap is a ceiling, and a written value may never sit above it.
                    const rounded = round(exact);
                    const value = rounded >= min && rounded <= max && Math.abs(rounded - refValue) <= maxAbsDelta
                        ? rounded
                        : exact;
                    if (value === refValue) continue;

                    a.getAttribute(attr)?.setValue(String(value));
                    writes += 1;
                    if (Math.abs(pushedValue - refValue) > maxAbsDelta + 1e-12) capped += 1;
                }
            }
        }

        const childrenA = allChildElements(a);
        const childrenB = allChildElements(b);
        if (childrenA.length !== childrenB.length) {
            throw new Error(`counter-performance: <${a.getLocalName()}> has ${childrenA.length} children against ${childrenB.length} — the exaggeration changed the document's shape`);
        }
        for (let i = 0; i < childrenA.length; i++) walk(childrenA[i], childrenB[i]);
    };
    walk(target, source);

    log(`counter: ${writes} attribute(s) shaped in [${range.from}, ${range.to}], ${capped} at the cap, ${refused} refused for moving toward the student`);

    const text = document.writeMpm();
    if (text === null) throw new Error('counter-performance: the document could not be written');
    return text;
};

// ── the one call the strategy makes ──────────────────────────────────────────────────────

type CounterPerformanceInput = {
    /** The **editorial** reference, `performance.mpm`, uncut: the counter-performance keeps
     * Grünfeld's pedal, which the comparison's cut documents drop. */
    readonly referenceMpmText: string;
    /** The passage the demonstration covers — the plan's range, else the take's. */
    readonly range: Range;
    /** What the teacher asked to be heard. Empty means nothing is shaped. */
    readonly dimensions: readonly ExaggerationDimension[];
    /** `studentCenter(evidence.levels)` — the fixed point the push happens around. */
    readonly center: StudentCenter;
    /**
     * The take's own findings, read off the **fitted** comparison: the pivot's sign for the
     * five dimensions `center` cannot reach, and the per-slot direction guard for all seven.
     */
    readonly events?: readonly StructuredDiffEvent[];
    /**
     * The types this take actually measured — `TakeEvidence.measuredTypes` intersected with
     * what the fitter wrote. A dimension outside it is never exaggerated, whatever the plan
     * asked for: there is no student behind it, so the push could only caricature the
     * editorial bake. Omitted means "no gate", which only a unit test should want.
     */
    readonly measured?: readonly string[];
    readonly log?: (msg: string) => void;
};

/**
 * Grünfeld's performance, pushed away from this student, as MPM text.
 *
 * Text in, text out, and nothing shared: the caller's reference string cannot be mutated by
 * anything here, which is what makes semantics 30 structural rather than a discipline.
 */
export const counterPerformance = ({
    referenceMpmText,
    range,
    dimensions,
    center,
    events = [],
    measured,
    log = () => {},
}: CounterPerformanceInput): string => {
    const canonical = canonicalMpm(referenceMpmText);
    const { factors, named } = factorsFor(dimensions, events, measured, log);
    if (named.length === 0) {
        log('counter: no dimension to shape — Grünfeld plays as he played');
        return canonical;
    }

    // A level with nothing measured behind it is omitted rather than guessed: espressivo then
    // pivots that dimension on Grünfeld's own mean, which is a weaker demonstration but never
    // a wrong-way one.
    const usable: StudentCenter = {};
    if (Number.isFinite(center.tempo) && (center.tempo ?? 0) > 0) usable.tempo = center.tempo;
    if (Number.isFinite(center.dynamics) && (center.dynamics ?? 0) > 0) usable.dynamics = center.dynamics;
    if (usable.tempo === undefined && named.includes('tempo')) log('counter: no student tempo level — pivoting on Grünfeld’s own');
    if (usable.dynamics === undefined && named.includes('dynamics')) log('counter: no student volume level — pivoting on Grünfeld’s own');

    const { mpm: pushed, report } = exaggerateMpm(referenceMpmText, {
        factors,
        center: usable,
        velocityRange: { min: 1, max: 127 },
    });
    log(`counter: ${named.join(', ')} pushed around tempo=${usable.tempo?.toFixed(2) ?? 'self'} dynamics=${usable.dynamics?.toFixed(2) ?? 'self'} (${report.totalWrites} writes)`);

    return spliceCapped(canonical, pushed, range, events, log);
};
