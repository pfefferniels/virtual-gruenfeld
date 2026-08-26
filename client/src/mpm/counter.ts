/**
 * The counter-performance: Grünfeld pushed away from *this* student, one instruction at a time,
 * capped, confined to the passage the teacher wants heard.
 *
 * ```
 * for every paired attribute the take measured, inside the demo range:
 *     ratio  x' = x_ed · (ref_fit / student)^a          bpm, intensity, scale, frameLength, …
 *     offset x' = x_ed − (student − ref_fit) · a        volume, milliseconds.offset
 *     then   clamp to x_ed ± maxAbsDelta and into [min, max]
 * ```
 *
 * **Three documents, and which number comes from which.** `x_ed` is Grünfeld's *editorial*
 * value — `performance.mpm`, the document the demonstration is rendered from. `ref_fit` and
 * `student` are the take's own pair, both read out of *fitted* documents (`student/fit.ts`
 * run over Grünfeld and over the student, one range, one path), so the ratio prices the
 * student's playing and not the gap between a hand-drawn bake and a solved fit — review-S5's
 * finding 1, which is why the ratio may never be taken between `x_ed` and the student.
 *
 * **Why per instruction.** An earlier version of this module asked espressivo's
 * `exaggerateMpm` for one exponent per *dimension* and let a level pivot carry the direction.
 * review-S6 measured what that costs: one exponent per type can only push values on one side of
 * their neutral away from the student, and Grünfeld's rubato intensities straddle 1 inside a
 * single four-bar demo, so half the passage the teacher had just named was refused rather than
 * demonstrated (identity take 8 of 22 sites, rubato take 16 of 20, ornament 12 of 14).
 * `ref_fit / student` is a per-site number, so the question does not arise: every attribute
 * moves away from the student *it* was paired against, in the amount *it* deviated. A pair with
 * `ref_fit === student` — or with a deviation under the diff's own noise floor — is not a
 * deviation at all and its attribute is left exactly as Grünfeld wrote it, which is what makes
 * an identity take a no-op by construction rather than by a guard.
 *
 * **What the caps are for.** `strength` scales how far the push goes, never how far it is
 * *allowed* to go (semantics 28): `maxAbsDelta` and the per-attribute bounds are applied
 * afterwards and clamp the result unconditionally. The plan's `[0.05, 0.5]` clamp is
 * re-applied here so a caller that skipped `lessonPlan.ts` cannot hand this an exponent
 * nothing downstream would survive (semantics 29, both sides).
 *
 * **Text in, text out.** The caller's reference string cannot be mutated by anything here —
 * this module parses its own copy and serialises it back — which is what makes semantics 30
 * structural rather than a discipline, and what lets `mode: 'reference'` play the fetched bytes
 * untouched. Both return paths go through the same serializer, so "nothing was shaped" and
 * "something was shaped outside your range" are the same document byte for byte (review-S6,
 * finding 11).
 */
import {
    ARTICULATION_MAP,
    ARTICULATION_STYLE,
    ASYNCHRONY_MAP,
    DYNAMICS_MAP,
    METRICAL_ACCENTUATION_MAP,
    Mpm,
    ORNAMENTATION_MAP,
    ORNAMENTATION_STYLE,
    RUBATO_MAP,
    TEMPO_MAP,
    allChildElements,
    type Element,
} from 'espressivo';
import { THRESHOLDS } from './diff';
import type { InstructionDiff, Range } from './types';

/** How far one deviation type gets pushed, as the lesson plan asks for it. */
export type ExaggerationDimension = { type: string; strength: number };

/**
 * What `student/fit.ts` measured, in the shape `FitResult.levels` has.
 *
 * Not read here any more — the counter-performance pivots on each instruction's own pair, not
 * on a level for the whole passage — but `TakeSnapshot.levels` is typed with it and the fitter
 * still measures it, so the name stays where the take's other measurements are named.
 */
export type StudentLevels = {
    readonly student: {
        readonly bpm: readonly number[];
        readonly volume: readonly number[];
    };
};

/** The aggressiveness the fixed-pedagogy pipeline always used. */
const DEFAULT_EXAGGERATION_STRENGTH = 0.2;

/** The plan's two-sided clamp (semantics 29). */
const STRENGTH_MIN = 0.05;
const STRENGTH_MAX = 0.5;

// ── the attribute table ──────────────────────────────────────────────────────────────────

/**
 * The space an attribute's deviation is expressed in.
 *
 * `ratio` is semantics 27's multiplicative branch, `x' = x_ed·(ref/student)^a`: right wherever
 * the quantity is a proportion of something — a speed, an exponent, a multiplier, a span.
 * `offset` is its signed branch, `x' = x_ed − (student − ref)·a`, for a quantity measured as a
 * distance on a bounded linear scale, where a ratio would be disproportionate at the ends and
 * meaningless at zero. MIDI velocity is such a scale, and so is a millisecond offset: the
 * diff's own floors and severity bands for both are stated in absolute units (4 / 12 / 30
 * velocity, 5 / 15 / 40 ms), which is the same judgement made twice.
 */
type Space = 'ratio' | 'offset';

/**
 * Where the reference states the attribute.
 *
 * `instruction` is the dated element itself. `def` is the definition its `@name.ref` reaches,
 * which carries no date of its own and is in range only when *every* instruction in the
 * document that reaches it is (see {@link defsInRange}) — the strict reading of semantics 31,
 * because a def shared with a passage outside the demo cannot be touched without changing how
 * that passage sounds.
 */
type Site = 'instruction' | 'def';

type AttributeRule = {
    readonly attr: string;
    readonly space: Space;
    /** The inner strength: `a = plan strength × this`. */
    readonly strength: number;
    /** The ceiling on |x' − x_ed|, in the attribute's own raw unit. */
    readonly maxAbsDelta: number;
    readonly min: number;
    readonly max: number;
    readonly site: Site;
    /**
     * Also write the instruction's own spelling of a `def` attribute, when it states one.
     * Grünfeld's v2-era document writes an ornament's `@intensity` twice — on the
     * `<ornament>` and on its def's `<temporalSpread>` — with the same number; the renderer
     * reads the def, `mpm/pair.ts` prefers it too, and leaving the twin behind would make one
     * quantity say two things.
     */
    readonly mirrorOnInstruction?: true;
};

/**
 * Every attribute the demonstration may write, with the space it moves in, its inner strength
 * and its ceiling.
 *
 * The inner strengths and `maxAbsDelta`s are `mpm/exaggerate.ts`'s table (mpmify-semantics
 * §3.2, contract 7) with three deliberate changes, each measured rather than guessed:
 *
 * 1. **`dynamics` moves in `offset`.** The legacy formula used the multiplicative branch for
 *    every type but `asynchrony`. On the `dynamics −18` take the two agree in direction and
 *    differ by under a velocity unit (offset +1.62, ratio +2.45 at the loudest slot), and the
 *    offset is the branch the attribute is *measured* in.
 * 2. **`rubato @intensity` takes the plan's strength undiminished (1.0, was 0.25).** At 0.25 a
 *    student who doubles Grünfeld's rubato is answered with 0.023–0.040 of intensity against a
 *    noise floor of 0.1 — review-S6's finding 10, "rubato cannot be demonstrated audibly at any
 *    admissible strength". At 1.0 the same take answers with 0.089–0.157 and reaches the ±0.15
 *    cap at its two loudest slots. The cap is untouched; the lever is the exponent, which is
 *    what that finding asked for.
 * 3. **`ornament @frameLength` is here at all**, at its sibling's strength, because the roll's
 *    *width* is where the diff measures an arpeggio (`mpm/pair.ts` reads it off the def) and a
 *    take that deviates only there would otherwise be answered with silence. `rubato
 *    @frameLength` is deliberately **not** here: a rubato frame is a tiling of the bar — the 56
 *    frames are all 720 ticks and abut — so changing one length leaves a gap or an overlap with
 *    its neighbour. It is a structural attribute, not an intensity.
 *
 * The key order is `allDimensions()`'s order, which a test pins.
 */
const EXAGGERATION_SPEC: Record<string, readonly AttributeRule[]> = {
    dynamics: [
        { attr: 'volume', space: 'offset', strength: 0.45, maxAbsDelta: 12, min: 1, max: 127, site: 'instruction' },
        { attr: 'transition.to', space: 'offset', strength: 0.45, maxAbsDelta: 12, min: 1, max: 127, site: 'instruction' },
    ],
    tempo: [
        { attr: 'bpm', space: 'ratio', strength: 0.35, maxAbsDelta: 10, min: 10, max: 300, site: 'instruction' },
        { attr: 'transition.to', space: 'ratio', strength: 0.35, maxAbsDelta: 10, min: 10, max: 300, site: 'instruction' },
    ],
    articulation: [
        { attr: 'relativeDuration', space: 'ratio', strength: 0.5, maxAbsDelta: 0.2, min: 0.1, max: 5, site: 'def' },
        { attr: 'relativeVelocity', space: 'ratio', strength: 0.45, maxAbsDelta: 0.2, min: 0.1, max: 5, site: 'def' },
    ],
    rubato: [
        { attr: 'intensity', space: 'ratio', strength: 1, maxAbsDelta: 0.15, min: 0.01, max: 10, site: 'instruction' },
    ],
    ornament: [
        { attr: 'scale', space: 'ratio', strength: 0.4, maxAbsDelta: 0.8, min: 0.1, max: 20, site: 'instruction' },
        { attr: 'intensity', space: 'ratio', strength: 0.35, maxAbsDelta: 0.25, min: 0.01, max: 10, site: 'def', mirrorOnInstruction: true },
        { attr: 'frameLength', space: 'ratio', strength: 0.35, maxAbsDelta: 150, min: 1, max: 720, site: 'def' },
    ],
    asynchrony: [
        { attr: 'milliseconds.offset', space: 'offset', strength: 0.35, maxAbsDelta: 40, min: -500, max: 500, site: 'instruction' },
    ],
    accentuationPattern: [
        { attr: 'scale', space: 'ratio', strength: 0.4, maxAbsDelta: 0.6, min: 0, max: 10, site: 'instruction' },
    ],
};

/**
 * Where each type's instructions live, and — for the two types whose numbers sit on a
 * definition — which style collection the `@name.ref` resolves in and which child of the def
 * carries them. `mpm/pair.ts` reads exactly these places, so the caps apply to the numbers the
 * teacher quotes.
 */
const SOURCES: Record<string, {
    readonly map: string;
    readonly element: string;
    readonly defs?: { readonly collection: string; readonly child?: string };
}> = {
    tempo: { map: TEMPO_MAP, element: 'tempo' },
    dynamics: { map: DYNAMICS_MAP, element: 'dynamics' },
    rubato: { map: RUBATO_MAP, element: 'rubato' },
    articulation: { map: ARTICULATION_MAP, element: 'articulation', defs: { collection: ARTICULATION_STYLE } },
    accentuationPattern: { map: METRICAL_ACCENTUATION_MAP, element: 'accentuationPattern' },
    ornament: { map: ORNAMENTATION_MAP, element: 'ornament', defs: { collection: ORNAMENTATION_STYLE, child: 'temporalSpread' } },
    asynchrony: { map: ASYNCHRONY_MAP, element: 'asynchrony' },
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

// ── reading and writing one document ─────────────────────────────────────────────────────

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

/** Every element of one map, in document order — the instructions of one type. */
const instructionsOf = (document: Mpm, type: string): Element[] => {
    const { map: mapName, element: elementName } = SOURCES[type];
    const map = document.getPerformance(0)?.getGlobal()?.getDated()?.getMap(mapName) ?? null;
    const found: Element[] = [];
    for (let index = 0; index < (map?.size() ?? 0); index++) {
        const element = map!.getElement(index);
        if (element && element.getLocalName() === elementName) found.push(element);
    }
    return found;
};

/**
 * One definition, as the demonstration needs it: the element to write on, and an identity to
 * decide in-range-ness by.
 *
 * The key names the owning `<styleDef>` as well as the def — `mpm/pair.ts` resolves a
 * `@name.ref` first-wins across a collection's style definitions, and two `<styleDef>`s in one
 * collection sharing a def name would otherwise splice whichever the reader happened to reach
 * (review-S6, finding 13). No such collision exists in `performance.mpm`; the key costs
 * nothing and removes the silence.
 */
type DefTarget = { readonly key: string; readonly xml: Element };

/**
 * Every def of one style collection by `@name`, resolved as the renderer would with no
 * `<style>` switch in force: document order, first wins — `mpm/pair.ts`'s rule, so both sides
 * read the same definition.
 */
const defsOf = (document: Mpm, collection: string): Map<string, DefTarget> => {
    const header = document.getPerformance(0)?.getGlobal()?.getHeader() ?? null;
    const found = new Map<string, DefTarget>();
    for (const [styleName, style] of header?.getAllStyleDefs(collection)?.entries() ?? []) {
        for (const [name, def] of style.getAllDefs()) {
            const xml = def.getXmlOrNull();
            if (xml && !found.has(name)) found.set(name, { key: `${collection}::${styleName}::${name}`, xml });
        }
    }
    return found;
};

/**
 * The def keys no instruction reaches from outside `range`.
 *
 * Every referrer counts, whatever type the plan asked for: a def is shared by whoever names
 * it, and the demonstration may not change how a passage outside its own range sounds. A def
 * with no referrer at all is not reachable in this demonstration and is left alone.
 *
 * A referrer carrying `@name.ref` but **no** `@date` cannot be shown to be inside the range, so
 * it blocks the def outright (review-S6, finding 14). `Mpm` in fact drops such an instruction
 * before it reaches this walk — a test asserts that — so the branch is the belt to that
 * braces: the rule is stated here rather than rested on a parser this module does not own.
 */
const defsInRange = (document: Mpm, range: Range): Set<string> => {
    const reachable = new Set<string>();
    const blocked = new Set<string>();

    for (const [type, source] of Object.entries(SOURCES)) {
        if (!source.defs) continue;
        const defs = defsOf(document, source.defs.collection);
        for (const element of instructionsOf(document, type)) {
            const nameRef = element.getAttributeValue('name.ref');
            if (nameRef === null) continue;
            const target = defs.get(nameRef);
            if (!target) continue;
            const date = numberAttribute(element, 'date');
            if (date === null || date < range.from || date > range.to) blocked.add(target.key);
            else reachable.add(target.key);
        }
    }

    for (const key of blocked) reachable.delete(key);
    return reachable;
};

// ── the push ─────────────────────────────────────────────────────────────────────────────

/** One attribute's pair, as `mpm/pair.ts` priced it: both sides fitted, in raw MPM units. */
type Pair = { readonly ref: number; readonly student: number; readonly delta: number };

type Outcome = 'written' | 'capped' | 'unmoved';

/**
 * Push one attribute of one element away from the student it was paired against.
 *
 * `x_ed` is read off the element being written, so each spelling of a quantity is transformed
 * from its own value and the document stays self-consistent. Four ways this declines to
 * write, all of them meaning "Grünfeld's own value is the honest answer":
 *
 * - the editorial document does not state the attribute at all (nothing to scale);
 * - a `ratio` push with a non-positive number on either side, where the ratio has no meaning;
 * - a clamped result that lands on the student's side of `x_ed`. That cannot come from the
 *   push, which is away from the student by construction, but it can come from the bounds:
 *   `performance.mpm` states a `@transition.to` of 9.5 bpm against a floor of 10, and
 *   correcting the reference is not this module's business;
 * - a result that rounds back onto `x_ed`, where rewriting the attribute would be an edit
 *   nobody asked for.
 */
const push = (element: Element, rule: AttributeRule, pair: Pair, a: number): Outcome => {
    const editorial = numberAttribute(element, rule.attr);
    if (editorial === null) return 'unmoved';

    let pushed: number;
    if (rule.space === 'ratio') {
        if (pair.ref <= 0 || pair.student <= 0 || editorial <= 0) return 'unmoved';
        pushed = editorial * Math.pow(pair.ref / pair.student, a);
    } else {
        pushed = editorial - pair.delta * a;
    }
    if (!Number.isFinite(pushed)) return 'unmoved';

    const exact = applyExaggerationCap(editorial, pushed, rule.maxAbsDelta, rule.min, rule.max);
    if (Math.sign(exact - editorial) === Math.sign(pair.delta)) return 'unmoved';

    // Rounded where rounding is free; the exact clamp where it would step over a bound. A cap
    // is a ceiling, and a written value may never sit above it.
    const rounded = round(exact);
    const value = rounded >= rule.min && rounded <= rule.max && Math.abs(rounded - editorial) <= rule.maxAbsDelta
        ? rounded
        : exact;
    if (value === editorial) return 'unmoved';

    element.getAttribute(rule.attr)?.setValue(String(value));

    // A `<temporalSpread>` frame is `[date + frame.start, date + frame.start + frameLength]`,
    // and Grünfeld's before-beat rolls are written with `frame.start ≈ −frameLength` so that
    // the roll *lands* on the beat. Narrowing the roll without moving its start would drag the
    // arpeggio off the note it ornaments — a change nobody asked for — so the offset is scaled
    // with the length and the frame keeps its shape around the beat: a before-beat roll still
    // ends on it, a straddling one still straddles it in the same proportion.
    if (rule.attr === 'frameLength') {
        const start = numberAttribute(element, 'frame.start');
        if (start !== null && start !== 0) {
            element.getAttribute('frame.start')?.setValue(String(round(start * (value / editorial))));
        }
    }

    return Math.abs(pushed - editorial) > rule.maxAbsDelta + 1e-12 ? 'capped' : 'written';
};

/**
 * The plan's dimensions, narrowed to what may actually be shaped, with the strength clamped.
 *
 * A dimension the take did not measure has no student behind it: pushing it could only
 * caricature the editorial bake, which is the one thing the counter-performance must not do
 * (review-S5, finding 1).
 */
const strengthsFor = (
    dimensions: readonly ExaggerationDimension[],
    measured: readonly string[] | undefined,
    log: (msg: string) => void,
): Map<string, number> => {
    const chosen = new Map<string, number>();
    for (const dimension of dimensions) {
        const { type } = dimension;
        if (typeof dimension?.strength !== 'number' || !Number.isFinite(dimension.strength)) continue;
        if (!EXAGGERATION_SPEC[type] || chosen.has(type)) continue;
        if (measured !== undefined && !measured.includes(type)) {
            log(`counter: ${type} not measured on this take — Grünfeld's own value stands`);
            continue;
        }
        chosen.set(type, Math.max(STRENGTH_MIN, Math.min(STRENGTH_MAX, dimension.strength)));
    }
    return chosen;
};

/**
 * The take's pairs by `${type}::${date}`, which is the identity `${type}_${date}` prints.
 *
 * `InstructionDiff` carries no `xml:id` — it is built from the reference's own instructions, so
 * the date *is* the join, and both documents state it. Where a document puts two instructions
 * of one type at one date the first pair stands for both: they describe one slot, and MPM lets
 * the later element prevail in the render either way.
 */
const pairsBySlot = (peaks: readonly InstructionDiff[]): Map<string, InstructionDiff> => {
    const found = new Map<string, InstructionDiff>();
    for (const peak of peaks) {
        const key = `${peak.type}::${peak.date}`;
        if (!found.has(key)) found.set(key, peak);
    }
    return found;
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
    /**
     * The take's paired instructions — `Evidence.peaks`, per attribute, both sides fitted, in
     * raw MPM units. This is what the push is computed from; with none of them nothing moves.
     */
    readonly peaks?: readonly InstructionDiff[];
    /**
     * The types this take actually measured — `TakeEvidence.measuredTypes` intersected with
     * what the fitter wrote. A dimension outside it is never shaped, whatever the plan asked
     * for. Omitted means "no gate", which only a unit test should want.
     */
    readonly measured?: readonly string[];
    readonly log?: (msg: string) => void;
};

/**
 * Grünfeld's performance, pushed away from this student, as MPM text.
 *
 * Everything outside `range`, every type the plan did not name or the take did not measure, and
 * every attribute the table does not list — Grünfeld's whole pedal among them — comes out
 * exactly as it went in.
 */
export const counterPerformance = ({
    referenceMpmText,
    range,
    dimensions,
    peaks = [],
    measured,
    log = () => {},
}: CounterPerformanceInput): string => {
    const document = new Mpm(referenceMpmText);
    const serialize = (): string => {
        const text = document.writeMpm();
        if (text === null) throw new Error('counter-performance: the document could not be written');
        return text;
    };

    const strengths = strengthsFor(dimensions, measured, log);
    if (strengths.size === 0) {
        log('counter: no dimension to shape — Grünfeld plays as he played');
        return serialize();
    }

    const pairs = pairsBySlot(peaks);
    const reachableDefs = defsInRange(document, range);
    const written = new Set<string>();
    let writes = 0;
    let capped = 0;
    let underFloor = 0;

    for (const [type, strength] of strengths) {
        const rules = EXAGGERATION_SPEC[type];
        const definitions = SOURCES[type].defs;
        const defs = definitions ? defsOf(document, definitions.collection) : null;
        let slots = 0;

        for (const element of instructionsOf(document, type)) {
            const date = numberAttribute(element, 'date');
            if (date === null || date < range.from || date > range.to) continue;
            const pair = pairs.get(`${type}::${date}`);
            if (!pair) continue;
            slots += 1;

            for (const rule of rules) {
                const measurement = pair.diffs[rule.attr];
                if (!measurement) continue;
                // Below the diff's own floor the difference is measurement, not playing
                // (semantics 19) — and an attribute nobody deviated in is an attribute the
                // demonstration has nothing to say about.
                if (Math.abs(measurement.delta) < (THRESHOLDS[rule.attr] ?? 0)) {
                    underFloor += 1;
                    continue;
                }
                const a = strength * rule.strength;

                if (rule.site === 'instruction') {
                    const outcome = push(element, rule, measurement, a);
                    if (outcome !== 'unmoved') writes += 1;
                    if (outcome === 'capped') capped += 1;
                    continue;
                }

                const nameRef = element.getAttributeValue('name.ref');
                const target = nameRef === null ? undefined : defs?.get(nameRef);
                // The def is what the renderer reads, so a def the demonstration may not touch
                // means the whole attribute stands — the instruction's twin spelling included,
                // which would otherwise disagree with the number actually sounding.
                if (!target || !reachableDefs.has(target.key)) continue;

                if (rule.mirrorOnInstruction) {
                    const mirrored = push(element, rule, measurement, a);
                    if (mirrored !== 'unmoved') writes += 1;
                    if (mirrored === 'capped') capped += 1;
                }

                // One def, one write: several instructions reach the same definition and they
                // all carry the same pair for it, so applying the push once is the whole of it.
                const once = `${target.key}::${rule.attr}`;
                if (written.has(once)) continue;
                written.add(once);

                const holder = definitions?.child
                    ? allChildElements(target.xml, definitions.child)[0]
                    : target.xml;
                if (!holder) continue;
                const outcome = push(holder, rule, measurement, a);
                if (outcome !== 'unmoved') writes += 1;
                if (outcome === 'capped') capped += 1;
            }
        }

        log(`counter: ${type} strength=${strength.toFixed(2)} — ${slots} paired slot(s) in range`);
    }

    log(
        `counter: ${writes} attribute(s) shaped in [${range.from}, ${range.to}], ` +
        `${capped} at the cap, ${underFloor} under the noise floor`,
    );

    return serialize();
};
