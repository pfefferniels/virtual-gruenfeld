/**
 * `mode: 'path'` — the student's own playing, with the k costliest edits put right.
 *
 * *"Your Träumerei, with the three things that matter corrected."* The other two demonstrations
 * play **Grünfeld**: `exaggerated` pushes his reconstruction away from the student until the
 * divergence is audible by contrast, `reference` plays it untouched. This one plays the
 * **student** — their fit, their tempo, their dynamics, everything they did — with a handful of
 * attributes overwritten by Grünfeld's own. What comes back is the smallest audible statement of
 * "this, and only this, is what I would change".
 *
 * The edit script is where that list comes from. `compareMpm` answers "how far apart, and in
 * what"; `diffMpm` answers "which elements, and by how much each" — a dynamic-programming
 * alignment of the two documents' instructions whose ops carry `valueA → valueB` per priced
 * attribute and a `cost` in JND·quarters. `script.topByCost` ranks them. Taking the k costliest,
 * writing `a.name := a.valueB` into the student's document and rendering it is the whole idea.
 *
 * **Orientation.** `a` is the student and `b` is the reference, exactly as in `compare.ts`
 * (`A_IS_STUDENT`) — the same pair, the same window, the same *fitted* reference on the far side,
 * so the edits price the student against a document produced by the same procedure rather than
 * against the editorial bake (S4 §2). `valueB` is therefore Grünfeld's value and `valueA` the
 * student's, and applying `valueB` to the student's own document is the direction of the
 * correction. Getting this backwards would produce a demonstration of the student's mistake,
 * played back at them as though it were the answer; `path.test.ts` pins it by measuring that the
 * comparison's distance *falls*.
 *
 * **Cost.** `diffMpm` grows as about n³·² and a window does not prune it (DESIGN risk R4,
 * `agents/espressivo-api-scout.md` §5): measured here, 454 ms over four bars and 1.6 s over eight.
 * It therefore runs in the evidence worker, **after** the plan has arrived — the demonstration is
 * shaped while the teacher is already speaking — and above {@link PATH_MAX_BARS} bars it is
 * skipped outright and said so in {@link PathResult.notes}. The documents are cut to the
 * demonstration's own range first, which is both what makes the ops in-range by construction and
 * what keeps the exponent working on the smallest n the demonstration can be made from.
 *
 * **There is no applier in espressivo.** `src/comparison/diff.ts:23-28` says so in as many words:
 * the ops carry concrete values and are machine-applicable in principle, but no writer ships until
 * a consumer asks. This is that consumer. The route is the object model —
 * `getMapOfKind(op.map)` → `getElementByID(op.site.xmlId)` → `update<X>At(index, patch)` — and
 * {@link PATCH_KEYS} is the one place an MPM attribute name becomes an `Add<X>Options` field.
 */
import {
    ARTICULATION_MAP,
    ASYNCHRONY_MAP,
    DYNAMICS_MAP,
    METRICAL_ACCENTUATION_MAP,
    MOVEMENT_MAP,
    MovementMap,
    Mpm,
    ORNAMENTATION_MAP,
    RUBATO_MAP,
    TEMPO_MAP,
    diffMpm,
    isMapKind,
    type AddAccentuationPatternOptions,
    type AddArticulationOptions,
    type AddAsynchronyOptions,
    type AddDynamicsOptions,
    type AddMovementOptions,
    type AddOrnamentOptions,
    type AddRubatoOptions,
    type AddTempoOptions,
    type Dated,
    type EditOp,
    type Element,
    type MapKind,
} from 'espressivo';
import { PPQ, tickToPos } from '../shared/constants';
import { DIMENSION_OF, JND_FLOOR } from './compare';
import { cutPairToRange, cutToRange } from './cut';
import { DIFF_TYPES, type DiffType, type Range } from './types';

/**
 * Twelve bars, in ticks — 4/4 at 720 ppq, the only metre this score has.
 *
 * Above it the demonstration is skipped rather than made to wait: at n³·² a twelve-bar diff is
 * already several seconds, and a take that long is not what mode `path` is for. The number is
 * DESIGN risk R4's, and it is a *policy*, not a limit of the code — every skip says so out loud.
 */
export const PATH_MAX_BARS = 12;
export const PATH_MAX_TICKS = PATH_MAX_BARS * 4 * PPQ;

/** `plan.edits ?? 3`: how many corrections the student hears in one demonstration. */
export const DEFAULT_PATH_EDITS = 3;

/**
 * The four dimensions this mode can actually correct — the ones whose numbers live on the
 * instruction itself.
 *
 * `ornament` spacing and `articulation` are priced on **defs**, which carry no `@date` and are
 * shared with the whole piece: the edit script filters its rows to instruction sites
 * (`src/comparison/diff.ts`), and {@link PATCH_KEYS} writes no def-site row, so an op of either
 * type either does not arrive or cannot be applied. Before this list existed the effect was
 * measurable and bad: on a take whose ornament spacing was doubled the teacher said *näher
 * zusammen* three times and the three corrections applied were **all `tempo`** — the monologue
 * and the demonstration about different things (final-pedagogy, finding 4).
 *
 * `<ornament @scale>` is the one def-borne type with an instruction-site number, and it is
 * excluded with the rest: risk R3 (the fitted `@scale` drifts through MIDI's folded unisons) puts
 * an artefact of the round trip in exactly the range a real halved arpeggio occupies, and a cost
 * floor cannot tell the two apart.
 *
 * The same four names are the plan validator's whitelist for `mode: 'path'`
 * (`src/plan/validate.ts`) and are named to the model in the prompt, so a plan asking for what
 * this cannot write is corrected before it arrives rather than silently swapped for something
 * else.
 */
export const PATH_TYPES: readonly DiffType[] = ['tempo', 'dynamics', 'rubato', 'accentuationPattern'];

/** The comparison's own dimension names, back to the seven the diff and the plan speak. */
const TYPE_OF_DIMENSION = new Map<string, DiffType>(
    DIFF_TYPES.map((type) => [DIMENSION_OF[type], type]),
);

/** Which element each map's instructions are, for the index fallback's sanity check. */
const ELEMENT_OF: Readonly<Record<string, string>> = {
    [TEMPO_MAP]: 'tempo',
    [DYNAMICS_MAP]: 'dynamics',
    [RUBATO_MAP]: 'rubato',
    [METRICAL_ACCENTUATION_MAP]: 'accentuationPattern',
    [ARTICULATION_MAP]: 'articulation',
    [ORNAMENTATION_MAP]: 'ornament',
    [ASYNCHRONY_MAP]: 'asynchrony',
};

/**
 * MPM attribute name → the `Add<X>Options` field that writes it, per map.
 *
 * Every instruction-site row espressivo's comparison registry prices, minus three kinds that are
 * deliberately not written:
 *
 * - **the booleans** — `@loop` on `<rubato>` and `<accentuationPattern>`, `@stickToMeasures`,
 *   `@subNoteDynamics`. The registry carries them as a `{0,1}` gain so that a difference is
 *   *reported*; they are structural switches, not expressive shaping, and the fitter copies them
 *   from the reference's own slot, so a difference here would be a bug rather than a lesson.
 * - **`<ornament>@note.order`** — a list of note ids, not a quantity. Its `deltaJnd` is 0 and
 *   copying Grünfeld's note ids into the student's ornament would say nothing anybody can hear.
 * - **every def-site row** — `<articulationDef>@relativeDuration`, `<temporalSpread>@intensity`
 *   and the rest. A def is shared: it carries no `@date`, the edit script does not visit it (its
 *   rows are filtered to instruction sites, `src/comparison/diff.ts:344`), and rewriting one for
 *   a demonstration of four bars would change how the whole piece is played.
 *
 * A priced attribute this table does not name is skipped and counted, never guessed at.
 */
const PATCH_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    [TEMPO_MAP]: {
        bpm: 'bpm',
        beatLength: 'beatLength',
        'transition.to': 'transitionTo',
        meanTempoAt: 'meanTempoAt',
    },
    [DYNAMICS_MAP]: {
        volume: 'volume',
        'transition.to': 'transitionTo',
        curvature: 'curvature',
        protraction: 'protraction',
    },
    [RUBATO_MAP]: {
        frameLength: 'frameLength',
        intensity: 'intensity',
        lateStart: 'lateStart',
        earlyEnd: 'earlyEnd',
    },
    [METRICAL_ACCENTUATION_MAP]: { scale: 'scale' },
    [ARTICULATION_MAP]: {
        relativeDuration: 'relativeDuration',
        relativeVelocity: 'relativeVelocity',
        absoluteDuration: 'absoluteDuration',
        absoluteDurationMs: 'absoluteDurationMs',
        absoluteDurationChange: 'absoluteDurationChange',
        absoluteDurationChangeMs: 'absoluteDurationChangeMs',
        absoluteDelay: 'absoluteDelay',
        absoluteDelayMs: 'absoluteDelayMs',
        absoluteVelocity: 'absoluteVelocity',
        absoluteVelocityChange: 'absoluteVelocityChange',
        detuneCents: 'detuneCents',
        detuneHz: 'detuneHz',
    },
    [ORNAMENTATION_MAP]: { scale: 'scale', repetitions: 'repetitions' },
    [ASYNCHRONY_MAP]: { 'milliseconds.offset': 'millisecondsOffset' },
};

/**
 * The four attributes whose option field takes a style-relative *name* as well as a number
 * (`<tempo bpm="fast">`). Everywhere else a non-numeric `valueB` is a value this writer has no
 * business copying, and is skipped.
 */
const STRING_VALUED: ReadonlySet<string> = new Set([
    `${TEMPO_MAP}@bpm`,
    `${TEMPO_MAP}@transition.to`,
    `${DYNAMICS_MAP}@volume`,
    `${DYNAMICS_MAP}@transition.to`,
]);

/**
 * One attribute of one applied edit, in the document's own units.
 *
 * Not exported: {@link PathEdit} names it, so a caller reading `edit.attributes[0].to` needs
 * nothing, and nobody yet holds one in a variable of its own.
 */
type PathEditAttribute = {
    readonly name: string;
    /** What the student wrote. `null` where they wrote nothing at all. */
    readonly from: number | string | null;
    /** Grünfeld's value — what was written in its place. */
    readonly to: number | string;
    readonly deltaJnd: number;
};

/** One correction the student hears. */
export type PathEdit = {
    readonly type: DiffType;
    readonly map: string;
    readonly xmlId: string;
    /** Ticks. `tickToPos` of it is {@link position} — espressivo's own bar numbers are never used. */
    readonly date: number;
    readonly position: string;
    /** JND·quarters, as the edit script priced it. This is the ranking key. */
    readonly cost: number;
    readonly attributes: readonly PathEditAttribute[];
};

export type PathInput = {
    /** The student's performance, whole, as `fitStudent` wrote it. Written into, never read back. */
    readonly studentMpmText: string;
    /**
     * The **fitted** reference — `Evidence.referenceFitText`, the comparison's own `b` side:
     * Grünfeld over this take's range, through the take's own path (`mpm/evidence.ts`). The
     * demonstration is then priced against exactly the document the criticism was, and an
     * identity take has nothing to correct. It covers the take's range, and the plan's range is
     * clamped inside the take's (`src/plan/validate.ts`), so the cut below always has a
     * prevailing value at both edges.
     */
    readonly referenceMpmText: string;
    /**
     * The **editorial** reference — `ctx.referenceMpmText`, Grünfeld's own document — for its
     * `<movement>` map alone, cut to {@link range} and spliced into the corrected student
     * document before it is written.
     *
     * Nothing else is taken from it: the corrections are still priced and applied against the
     * fitted reference above. The pedal is here because neither fitted document has one — the
     * fitter writes what it can measure and Web MIDI hands us no CC64 — so without the splice
     * `path` is the one demonstration with no pedal at all, and it sounds it: mean sounding note
     * length 1183 ms against `mode: 'reference'`'s 1310 ms, −10 % (final-pedagogy, finding 5).
     * Absent, the splice is skipped and said so in {@link PathResult.notes}.
     */
    readonly editorialReferenceMpmText?: string;
    /** The score as MSM text. Part of the metric: the window, the measures, the beat grid. */
    readonly scoreMsm: string;
    /** What the demonstration plays — `plan.range ?? take.range`. Both sides are cut to it. */
    readonly range: Range;
    /**
     * `TakeSnapshot.measuredTypes` — what this take actually measured, past the audibility gate
     * and written by the fitter.
     *
     * The hard gate, applied before {@link types}. Without it the audibility gate that decides
     * what the teacher may *say* had no bearing on what the student *heard*: on a take with
     * `measuredTypes = []`, where the teacher says nothing at all, `path` applied three
     * corrections — byte-for-byte the same three an identity take got (final-pedagogy,
     * finding 1). Empty means no demonstration, and that is the point.
     */
    readonly measured: readonly string[];
    /**
     * `plan.dimensions`' types. Empty or absent means every **measured** type — never every
     * type: an empty list is what a plan whose dimensions the server dropped for not being
     * measured looks like, and reading it as "correct whatever is costliest anywhere" would
     * widen exactly where `src/plan/validate.ts` narrowed.
     */
    readonly types?: readonly string[];
    /** `plan.edits ?? 3`. */
    readonly edits?: number;
};

export type PathResult = {
    /**
     * The student's document with the edits applied, or `null` when there was no demonstration
     * to make — the range was too long, or nothing survived the filters. {@link notes} says which.
     */
    readonly mpm: string | null;
    /** What was applied, costliest first. Empty exactly when {@link mpm} is `null`. */
    readonly edits: readonly PathEdit[];
    /** How many ops survived the type, range and writability filters — the pool `k` was taken from. */
    readonly considered: number;
    /** Everything worth a line in the debug log, including every skip and its reason. */
    readonly notes: readonly string[];
    /** What `diffMpm` cost on this range. Risk R4's number, measured on every take that uses it. */
    readonly diffMs: number;
};

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now());

const dateOf = (element: Element): number | null => {
    const raw = element.getAttributeValue('date');
    if (raw === null) return null;
    const date = Number(raw);
    return Number.isFinite(date) ? date : null;
};

/** A patch as `update<X>At` takes it: option field → value. */
type Patch = Record<string, number | string>;

/**
 * Turn one op into the patch that applies it, and the record of what that patch says.
 *
 * `valueB === null` means the reference has no such attribute at all. Removing the student's —
 * `patch: { x: undefined }`, which is what `patchAttribute` does with an explicit `undefined` —
 * is a different operation from correcting it, and one whose audible effect depends on what the
 * renderer defaults to. It is skipped instead.
 */
const patchOf = (op: EditOp): { patch: Patch; attributes: PathEditAttribute[]; unwritable: number } => {
    const keys = PATCH_KEYS[op.map] ?? {};
    const patch: Patch = {};
    const attributes: PathEditAttribute[] = [];
    let unwritable = 0;

    for (const attribute of op.attributes) {
        const key = keys[attribute.name];
        const to = attribute.valueB;
        if (key === undefined || to === null) {
            unwritable += 1;
            continue;
        }
        if (typeof to === 'string' && !STRING_VALUED.has(`${op.map}@${attribute.name}`)) {
            unwritable += 1;
            continue;
        }
        patch[key] = to;
        attributes.push({ name: attribute.name, from: attribute.valueA, to, deltaJnd: attribute.deltaJnd });
    }

    return { patch, attributes, unwritable };
};

/** An op that survived every filter, with everything needed to apply it and to describe it. */
type Candidate = {
    readonly op: EditOp;
    readonly type: DiffType;
    readonly date: number;
    readonly patch: Patch;
    readonly attributes: readonly PathEditAttribute[];
};

/**
 * Cost-descending, and total: two ops of equal cost are ordered by date, then by map, then by the
 * position the diff reported. A demonstration that changed between two runs of the same take
 * would not be a demonstration of anything (semantics 5), and `EditOp.cost` is a float — ties are
 * rare but not impossible, and `MOVE_MARGIN` exists precisely because floats differ by an ulp
 * between V8 versions.
 */
const byCost = (a: Candidate, b: Candidate): number =>
    b.op.cost - a.op.cost
    || a.date - b.date
    || (a.op.map < b.op.map ? -1 : a.op.map > b.op.map ? 1 : 0)
    || a.op.site.index - b.op.site.index;

/**
 * Give the corrected document Grünfeld's pedal, and say what was done either way.
 *
 * Read out of the **cut** editorial document one `<movement>` at a time and written in through
 * `addMovement` rather than by moving the element itself: the two documents are two DOMs, and
 * `getMovementOptionsOf` → `addMovement` is a value copy that cannot carry a foreign node across.
 * `cutToRange` with `dropMaps: []` is what keeps the map — its default drops `movementMap` — and
 * the cut's opening element is what makes a pedal pressed before the window still be down at its
 * start.
 *
 * The student's own pedal is never captured, so this is Grünfeld's, stated as such: it is the one
 * thing in a `path` demonstration that is not the student's own playing.
 *
 * @returns the line for {@link PathResult.notes}.
 */
const splicePedal = (dated: Dated, editorialReferenceMpmText: string | undefined, range: Range): string => {
    if (editorialReferenceMpmText === undefined) {
        return 'path: no pedal spliced — no editorial reference was passed; the demonstration plays dry';
    }
    if (dated.getMapOfKind(MOVEMENT_MAP) !== null) {
        return 'path: no pedal spliced — the student document already has a movement map';
    }

    let source;
    try {
        source = new Mpm(cutToRange(editorialReferenceMpmText, range, { dropMaps: [] }))
            .getPerformance(0)?.getGlobal()?.getDated()?.getMapOfKind(MOVEMENT_MAP) ?? null;
    } catch (e) {
        return `path: no pedal spliced — the editorial reference could not be cut (${e})`;
    }
    if (source === null || source.size() === 0) {
        return 'path: no pedal spliced — the editorial reference has no movement map over this range';
    }

    const movements: AddMovementOptions[] = [];
    for (let index = 0; index < source.size(); index++) {
        const movement = source.getMovementOptionsOf(index);
        if (movement !== null) movements.push(movement);
    }
    if (movements.length === 0) {
        return 'path: no pedal spliced — the movement map holds nothing this writer can read';
    }

    const target = MovementMap.createMovementMap();
    for (const movement of movements) target.addMovement(movement);
    if (dated.addMap(target) === null) {
        return 'path: no pedal spliced — the student document refused the movement map';
    }

    return `path: spliced Grünfeld's pedal — ${movements.length} <movement> element(s) from the `
        + 'editorial reference, cut to this range (the student\'s own pedal is never captured)';
};

/**
 * The student's own playing, with the k costliest edits applied.
 *
 * Pure, deterministic and structured-clone-safe in and out, because it runs in the evidence
 * worker: no logging callback crosses that boundary, so everything worth saying comes back in
 * {@link PathResult.notes} and the caller writes it to the log.
 */
export const pathPerformance = (input: PathInput): PathResult => {
    const { studentMpmText, referenceMpmText, editorialReferenceMpmText, scoreMsm, range, measured, types, edits } = input;
    const notes: string[] = [];
    const nothing = (reason: string, diffMs = 0): PathResult => {
        notes.push(reason);
        return { mpm: null, edits: [], considered: 0, notes, diffMs };
    };

    if (!Number.isFinite(range.from) || !Number.isFinite(range.to) || range.from >= range.to) {
        return nothing(`path: [${range.from}, ${range.to}) is not a range`);
    }

    // What may be corrected, decided before a millisecond of the cubic is spent: what the take
    // measured, ∩ what this writer can put on an instruction, ∩ what the plan asked for. An
    // empty plan list is "every measured type" (see `PathInput.types`), an empty *result* is no
    // demonstration — a student the evidence is silent about is not corrected.
    const writable = new Set<string>(PATH_TYPES);
    const measurable = measured.filter((type) => writable.has(type));
    const wanted = new Set<string>(
        types && types.length > 0
            ? types.filter((type) => measurable.includes(type))
            : measurable,
    );
    if (wanted.size === 0) {
        return nothing(
            'path: nothing to correct — measured ['
            + `${measured.join(' ') || 'nothing'}] ∩ writable [${PATH_TYPES.join(' ')}]`
            + `${types && types.length > 0 ? ` ∩ planned [${types.join(' ')}]` : ''} is empty`,
        );
    }
    const span = range.to - range.from;
    if (span > PATH_MAX_TICKS) {
        return nothing(
            `path: ${(span / (4 * PPQ)).toFixed(1)} bars is more than ${PATH_MAX_BARS} — the edit script `
            + 'grows as n^3.2 and is skipped above that (DESIGN R4)',
        );
    }

    // Cut to the demonstration's own range, both sides identically: it is what the comparison
    // does (`compare.ts`), what keeps `n` — and with it the cubic — as small as the demonstration
    // allows, and what makes the ops in-range by construction. The cut keeps one element before
    // the window and one after it so the prevailing value is right at both edges, which is why
    // the date filter below is still needed: those two are outside the range and must not move.
    const { refCut, stuCut } = cutPairToRange(referenceMpmText, studentMpmText, range);

    const startedAt = now();
    const { report } = diffMpm({
        a: stuCut,
        b: refCut,
        msm: scoreMsm,
        window: { start: range.from / PPQ, end: range.to / PPQ },
        // Stated rather than defaulted. `fragment`/`consolidate` price a group of instructions as
        // one edit; there is no single element to write them onto, and their counts are the one
        // thing in this report that has ever moved between V8 versions (`MOVE_MARGIN`).
        moves: false,
    });
    const diffMs = now() - startedAt;

    const candidates: Candidate[] = [];
    const seenScripts = new Set<string>();
    let unwritable = 0;
    let outOfRange = 0;
    let notSubstitutions = 0;
    let belowFloor = 0;

    for (const script of report.scripts) {
        // Every global script is reported once per evaluated scope, and this score's MSM has two
        // parts (`report.scopes.count === 2`), so each arrives twice — same ops, same ids. Taking
        // both would spend two of the k slots on one edit.
        const key = `${script.part}::${script.map}::${script.dimension}`;
        if (seenScripts.has(key)) continue;
        seenScripts.add(key);

        const type = TYPE_OF_DIMENSION.get(script.dimension);
        if (type === undefined || !wanted.has(type)) continue;

        for (const index of script.topByCost) {
            const op = script.ops[index];
            if (!op) continue;
            // An insertion writes an element the student never played and a deletion removes one
            // they did; both change what is *there*, which `update<X>At` cannot express and a
            // demonstration should not claim. A substitution is the whole vocabulary here.
            if (op.op !== 'substitute') {
                notSubstitutions += 1;
                continue;
            }

            // The same floor the audibility gate applies to a whole dimension (`compare.ts`),
            // applied here to one op: under 1 JND·quarter is a correction nobody can hear, and
            // playing it back as *"this is what I would change"* tells a student who played it
            // right that they played it wrong. It is what separates the direct-fit residue from
            // a real correction — an identity take's costliest op is 0.45, the smallest genuine
            // one measured is 1.00 (final-pedagogy, finding 1; DECISIONS 19:39:51Z (a)).
            if (!(op.cost >= JND_FLOOR)) {
                belowFloor += 1;
                continue;
            }

            const quarters = op.dateA ?? op.dateB;
            if (quarters === null) continue;
            const date = Math.round(quarters * PPQ);
            if (date < range.from || date > range.to) {
                outOfRange += 1;
                continue;
            }

            const { patch, attributes, unwritable: skippedHere } = patchOf(op);
            unwritable += skippedHere;
            if (attributes.length === 0) continue;

            candidates.push({ op, type, date, patch, attributes });
        }
    }

    candidates.sort(byCost);
    notes.push(
        `path: diffMpm ${Math.round(diffMs)} ms over ${tickToPos(range.from)}–${tickToPos(range.to)}, `
        + `correcting [${[...wanted].join(' ')}], `
        + `${candidates.length} applicable op(s) (${notSubstitutions} not substitutions, `
        + `${belowFloor} under ${JND_FLOOR} JND, `
        + `${outOfRange} out of range, ${unwritable} attribute(s) this writer does not write)`,
    );

    if (candidates.length === 0) {
        notes.push('path: nothing to correct — the student and Grünfeld align audibly on every priced attribute');
        return { mpm: null, edits: [], considered: 0, notes, diffMs };
    }

    const k = Math.max(1, Math.round(edits ?? DEFAULT_PATH_EDITS));
    const student = new Mpm(studentMpmText);
    if (student.isEmpty()) return nothing('path: the student document is not well formed', diffMs);
    const dated = student.getPerformance(0)?.getGlobal()?.getDated() ?? null;
    if (!dated) return nothing('path: the student document has no global performance to edit', diffMs);

    /**
     * Write one patch. The maps are reached by kind rather than by name so that the compiler
     * checks every option field against the map that owns it; the cast is what {@link PATCH_KEYS}
     * is for, and it is the only place in this module where a string becomes a field name.
     */
    const writeAt = (kind: MapKind, index: number, patch: Patch): boolean => {
        switch (kind) {
            case TEMPO_MAP:
                return dated.getMapOfKind(TEMPO_MAP)?.updateTempoAt(index, patch as Partial<AddTempoOptions>) ?? false;
            case DYNAMICS_MAP:
                return dated.getMapOfKind(DYNAMICS_MAP)?.updateDynamicsAt(index, patch as Partial<AddDynamicsOptions>) ?? false;
            case RUBATO_MAP:
                return dated.getMapOfKind(RUBATO_MAP)?.updateRubatoAt(index, patch as Partial<AddRubatoOptions>) ?? false;
            case METRICAL_ACCENTUATION_MAP:
                return dated.getMapOfKind(METRICAL_ACCENTUATION_MAP)
                    ?.updateAccentuationPatternAt(index, patch as Partial<AddAccentuationPatternOptions>) ?? false;
            case ARTICULATION_MAP:
                return dated.getMapOfKind(ARTICULATION_MAP)?.updateArticulationAt(index, patch as Partial<AddArticulationOptions>) ?? false;
            case ORNAMENTATION_MAP:
                return dated.getMapOfKind(ORNAMENTATION_MAP)?.updateOrnamentAt(index, patch as Partial<AddOrnamentOptions>) ?? false;
            case ASYNCHRONY_MAP:
                return dated.getMapOfKind(ASYNCHRONY_MAP)?.updateAsynchronyAt(index, patch as Partial<AddAsynchronyOptions>) ?? false;
            default:
                return false;
        }
    };

    const applied: PathEdit[] = [];
    for (const candidate of candidates) {
        if (applied.length >= k) break;
        const { op, type, date, patch, attributes } = candidate;

        const kind = op.map;
        if (!isMapKind(kind)) {
            notes.push(`path: skipped ${kind} — not a map this writer knows`);
            continue;
        }
        const map = dated.getMap(kind);
        if (!map) {
            notes.push(`path: skipped ${kind} — the student has no such map`);
            continue;
        }

        // The id is the join, as everywhere else in this rewrite: the fitter writes the student
        // into Grünfeld's own slots, so both documents carry the same `xml:id`s, and the id
        // resolves in the *whole* document while `site.index` was measured in the *cut* one.
        // The index is therefore only ever a fallback, and only where it names the same element
        // at the same date — anything else would silently correct the wrong instruction.
        let index = op.site.xmlId === null ? -1 : map.getElementIndexByID(op.site.xmlId);
        if (index < 0) {
            const element = map.getElement(op.site.index);
            if (element && element.getLocalName() === ELEMENT_OF[kind] && dateOf(element) === date) {
                index = op.site.index;
            }
        }
        if (index < 0) {
            notes.push(`path: skipped ${kind} at ${tickToPos(date)} — no element to correct (${op.site.xmlId ?? 'no id'})`);
            continue;
        }

        if (!writeAt(kind, index, patch)) {
            notes.push(`path: skipped ${kind} at ${tickToPos(date)} — the element refused the patch`);
            continue;
        }

        applied.push({
            type,
            map: kind,
            xmlId: op.site.xmlId ?? '',
            date,
            position: tickToPos(date),
            cost: op.cost,
            attributes,
        });
    }

    if (applied.length === 0) {
        notes.push('path: no op could be applied to the student document');
        return { mpm: null, edits: [], considered: candidates.length, notes, diffMs };
    }

    notes.push(splicePedal(dated, editorialReferenceMpmText, range));

    const text = student.writeMpm();
    if (text === null) return nothing('path: the corrected document could not be written');

    for (const edit of applied) {
        notes.push(
            `path: ${edit.position} ${edit.type} ${edit.attributes
                .map((a) => `${a.name} ${a.from ?? '—'}→${a.to}`)
                .join(', ')} (cost ${edit.cost.toFixed(2)})`,
        );
    }

    return { mpm: text, edits: applied, considered: candidates.length, notes, diffMs };
};
