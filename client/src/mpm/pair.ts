/**
 * Pairing: two MPM documents in, the diff's own `InstructionDiff[]` out.
 *
 * This is the finding the rewrite turns on, cashed in. Grünfeld's document prints deterministic
 * ids — `<tempo xml:id="tempo_720" date="720" bpm="76.15" transition.to="48.15">` — and the
 * fitter writes the student's playing into those same slots, so the join the old pipeline
 * replayed 494 transformer calls to *manufacture* is a `Map` lookup on `${type}::${xml:id}`.
 * What comes out is exactly what `diff.ts` has always consumed, in raw MPM units: bpm at the
 * instruction's own `@beatLength`, 0–127 velocity, dimensionless multipliers, ticks. Nothing is
 * normalised, because `THRESHOLDS`, `SEVERITY_THRESHOLDS` and the German cue table are
 * calibrated in those units and the server prompt quotes them.
 *
 * Values are read as **raw attributes**, not through the typed getters. `ArticulationDef`'s
 * `getRelativeDuration()` answers `1` for a def that states no such attribute, and a default is
 * not a measurement: an `@absoluteDuration` def (risk R6) has to stay *absent* on both sides so
 * that the attribute is skipped rather than compared against a fiction. Presence is the signal.
 *
 * The reference drives the iteration, as `collectDiffs` always did — `delta = student − ref`,
 * and an instruction the student never answered for is silently unpaired rather than invented.
 * `compare.ts` is what turns those silences into something the teacher can still say.
 */
import {
    ARTICULATION_MAP,
    ARTICULATION_STYLE,
    ASYNCHRONY_MAP,
    DYNAMICS_MAP,
    METRICAL_ACCENTUATION_MAP,
    ORNAMENTATION_MAP,
    ORNAMENTATION_STYLE,
    RUBATO_MAP,
    TEMPO_MAP,
    allChildElements,
    type Element,
    type Mpm,
} from 'espressivo';
import { ATTRS_TO_COMPARE, THRESHOLDS } from './diff';
import {
    DIFF_TYPES,
    type DiffType,
    type InstructionDiff,
    type OrnamentStyle,
    type OrnamentStyleLookup,
    type Range,
} from './types';

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** Where each of the diff's seven types lives in an MPM document. */
const SOURCES: Record<DiffType, { readonly map: string; readonly element: string }> = {
    tempo: { map: TEMPO_MAP, element: 'tempo' },
    dynamics: { map: DYNAMICS_MAP, element: 'dynamics' },
    rubato: { map: RUBATO_MAP, element: 'rubato' },
    articulation: { map: ARTICULATION_MAP, element: 'articulation' },
    accentuationPattern: { map: METRICAL_ACCENTUATION_MAP, element: 'accentuationPattern' },
    ornament: { map: ORNAMENTATION_MAP, element: 'ornament' },
    asynchrony: { map: ASYNCHRONY_MAP, element: 'asynchrony' },
};

/**
 * The attributes read off the `<ornamentDef>` rather than off the `<ornament>`.
 *
 * `frameLength` is where `diff.ts:119-130` already goes, and `intensity` has to follow it:
 * `addOrnamentV3` has no `intensity` on the instruction at all (it lives on the def's
 * `<temporalSpread>`), while Grünfeld's v2-era document spells it in both places with the same
 * number. Preferring the def and falling back to the element makes one quantity out of two
 * spellings, symmetrically on both sides.
 */
const ORNAMENT_DEF_ATTRS = ['frameLength', 'intensity'] as const;

/** `ATTRS_TO_COMPARE` plus the one attribute `collectDiffs` appends by hand, in its order. */
const attributesOf = (type: DiffType): readonly string[] =>
    type === 'ornament' ? [...ATTRS_TO_COMPARE[type], 'frameLength'] : ATTRS_TO_COMPARE[type] ?? [];

/** One instruction, as the diff needs to see it. */
export type InstructionReading = {
    readonly type: DiffType;
    readonly xmlId: string;
    readonly date: number;
    readonly nameRef?: string;
    /** Raw MPM units, only the attributes the document actually states. */
    readonly values: Readonly<Record<string, number>>;
};

/** Every instruction of one document, by `${type}::${xml:id}` and by `${type}::${date}`. */
export type InstructionIndex = {
    readonly byId: ReadonlyMap<string, InstructionReading>;
    readonly byDate: ReadonlyMap<string, InstructionReading>;
    readonly all: readonly InstructionReading[];
};

const numberAttribute = (element: Element, name: string): number | undefined => {
    const raw = element.getAttributeValue(name);
    if (raw === null || raw.trim() === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
};

/**
 * Every def of one style collection, by name, as its raw XML element.
 *
 * All `<styleDef>`s of the collection are folded into one lookup: both documents use a single
 * `performance_style`, and a name that appeared in two would be a document that cannot say
 * which def an `@name.ref` means. First wins, which is the document order the renderer would
 * resolve in with no `<style>` switch in force.
 */
const defsOf = (mpm: Mpm, collection: string): Map<string, Element> => {
    const header = mpm.getPerformance(0)?.getGlobal()?.getHeader() ?? null;
    const found = new Map<string, Element>();
    for (const style of header?.getAllStyleDefs(collection)?.values() ?? []) {
        for (const [name, def] of style.getAllDefs()) {
            const xml = def.getXmlOrNull();
            if (xml && !found.has(name)) found.set(name, xml);
        }
    }
    return found;
};

/**
 * Read one document's instructions.
 *
 * Deliberately a plain attribute walk over the maps the object model locates: the values that
 * reach the teacher are the document's own strings turned into numbers, with nothing defaulted
 * and nothing derived.
 */
export const readInstructions = (mpm: Mpm): InstructionIndex => {
    const dated = mpm.getPerformance(0)?.getGlobal()?.getDated() ?? null;
    const articulationDefs = defsOf(mpm, ARTICULATION_STYLE);
    const ornamentDefs = defsOf(mpm, ORNAMENTATION_STYLE);

    const byId = new Map<string, InstructionReading>();
    const byDate = new Map<string, InstructionReading>();
    const all: InstructionReading[] = [];

    for (const type of DIFF_TYPES) {
        const { map: mapName, element: elementName } = SOURCES[type];
        const map = dated?.getMap(mapName) ?? null;
        if (!map) continue;

        for (let index = 0; index < map.size(); index++) {
            const element = map.getElement(index);
            if (!element || element.getLocalName() !== elementName) continue;

            const date = numberAttribute(element, 'date');
            if (date === undefined) continue;
            const nameRef = element.getAttributeValue('name.ref') ?? undefined;

            const values: Record<string, number> = {};
            for (const attribute of attributesOf(type)) {
                const value = numberAttribute(element, attribute);
                if (value !== undefined) values[attribute] = value;
            }

            if (type === 'articulation' && nameRef !== undefined) {
                const def = articulationDefs.get(nameRef);
                // `absoluteDuration` is not a multiplier and is never coerced into one (R6):
                // a def stating only that contributes no attribute at all.
                if (def) {
                    for (const attribute of ATTRS_TO_COMPARE.articulation) {
                        const value = numberAttribute(def, attribute);
                        if (value !== undefined) values[attribute] = value;
                    }
                }
            }

            if (type === 'ornament' && nameRef !== undefined) {
                const def = ornamentDefs.get(nameRef);
                const spread = def ? allChildElements(def, 'temporalSpread')[0] : undefined;
                if (spread) {
                    for (const attribute of ORNAMENT_DEF_ATTRS) {
                        const value = numberAttribute(spread, attribute);
                        if (value !== undefined) values[attribute] = value;
                    }
                }
            }

            const reading: InstructionReading = {
                type,
                xmlId: element.getAttributeValue('id', XML_NS) ?? '',
                date,
                ...(nameRef === undefined ? {} : { nameRef }),
                values,
            };
            all.push(reading);
            if (reading.xmlId !== '') byId.set(`${type}::${reading.xmlId}`, reading);
            // First wins: MPM lets the last element at a date prevail, but the id is the join
            // and this key is only ever the fallback for a document that lost one.
            const dateKey = `${type}::${date}`;
            if (!byDate.has(dateKey)) byDate.set(dateKey, reading);
        }
    }

    return { byId, byDate, all };
};

/**
 * The style tags the ASCII table prints in the ornament section (`arpeggio`, `dyn-gradient`).
 *
 * Read off the *reference*, which is the document `diff.ts:236-262` has always asked — the tag
 * describes what kind of figure Grünfeld wrote there, not how the student played it.
 */
export const ornamentStylesOf = (mpm: Mpm): OrnamentStyleLookup => {
    const styles = new Map<string, OrnamentStyle>();
    for (const [name, def] of defsOf(mpm, ORNAMENTATION_STYLE)) {
        styles.set(name, {
            temporalSpread: allChildElements(def, 'temporalSpread').length > 0,
            dynamicsGradient: allChildElements(def, 'dynamicsGradient').length > 0,
        });
    }
    return (nameRef: string) => styles.get(nameRef) ?? null;
};

/** Not exported: `pairInstructions` names it, and every caller passes an object literal. */
type PairOptions = {
    /**
     * Types the audibility gate silenced. A suppressed type produces no events at all, before
     * the top-3 selection rather than after it, so the ASCII summary loses the section too.
     */
    readonly suppressed?: ReadonlySet<string>;
    /** Extra diffs for slots the fitter could not write — `compare.ts` reads them off the profiles. */
    readonly fallback?: readonly InstructionDiff[];
};

/**
 * `[range.from, range.to]`, inclusive at both ends — `helpers.ts:5-8`'s rule, kept so that the
 * new path selects exactly the instructions the old one did.
 */
const inRange = (date: number, range: Range): boolean => date >= range.from && date <= range.to;

/**
 * Pair the student's instructions against the reference's and price every attribute the diff
 * compares.
 *
 * The body is `collectDiffs` (`diff.ts:95-137`) with espressivo's reader in front of it: same
 * `delta = student − ref`, same `hasSignificant` floor, same `magnitude = Σ|delta|` over every
 * compared attribute, same silent skip for an unpaired instruction.
 */
export const pairInstructions = (
    reference: Mpm,
    student: Mpm,
    range: Range,
    options: PairOptions = {},
): InstructionDiff[] => {
    const { suppressed, fallback = [] } = options;
    const referenceSide = readInstructions(reference);
    const studentSide = readInstructions(student);
    const peaks: InstructionDiff[] = [];

    for (const instruction of referenceSide.all) {
        if (!inRange(instruction.date, range)) continue;
        if (suppressed?.has(instruction.type)) continue;

        const corresp =
            studentSide.byId.get(`${instruction.type}::${instruction.xmlId}`) ??
            studentSide.byDate.get(`${instruction.type}::${instruction.date}`);
        if (!corresp) continue;

        const diffs: Record<string, { ref: number; student: number; delta: number }> = {};
        let magnitude = 0;
        let hasSignificant = false;

        for (const attr of attributesOf(instruction.type)) {
            const refVal = instruction.values[attr];
            const studentVal = corresp.values[attr];
            if (typeof refVal !== 'number' || typeof studentVal !== 'number') continue;
            const delta = studentVal - refVal;
            if (Math.abs(delta) >= (THRESHOLDS[attr] ?? 0)) hasSignificant = true;
            diffs[attr] = { ref: refVal, student: studentVal, delta };
            magnitude += Math.abs(delta);
        }

        if (!hasSignificant || Object.keys(diffs).length === 0) continue;
        peaks.push({
            date: instruction.date,
            type: instruction.type,
            ...(instruction.nameRef === undefined ? {} : { nameRef: instruction.nameRef }),
            diffs,
            magnitude,
        });
    }

    // A fallback is an instruction the student never wrote, priced off the resolved curve — but
    // it is still an instruction, and the same floor decides whether it is playing or
    // measurement. This is the one place `THRESHOLDS` is applied, on both kinds.
    for (const extra of fallback) {
        if (!inRange(extra.date, range)) continue;
        if (suppressed?.has(extra.type)) continue;
        const clears = Object.entries(extra.diffs).some(
            ([attr, { delta }]) => Math.abs(delta) >= (THRESHOLDS[attr] ?? 0),
        );
        if (clears) peaks.push(extra);
    }

    return peaks;
};
