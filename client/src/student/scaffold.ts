/**
 * Grünfeld's instruction slots, read out of `performance.mpm`.
 *
 * This is the finding the whole rewrite turns on. The reference document already prints
 * deterministic ids — `<tempo xml:id="tempo_720" date="720" endDate="2160" bpm="76.15"
 * beatLength="0.25" transition.to="48.15">` — so the join key the old pipeline replayed 494
 * transformer calls to *manufacture* is simply there to be read. Written into those same
 * slots, the student's performance pairs with the reference by a `Map` lookup, and fitting
 * stops being a search for *where* an instruction belongs and becomes an interpolation of
 * *what value* belongs in a slot whose date, span and `@name.ref` are already decided.
 *
 * What a slot carries is exactly what the fitter may not invent: the date and `xml:id` (the
 * join), the span (what stretch of playing the value is measured over), and the fields the
 * fitter copies rather than fits — `@beatLength`, `@name.ref`, a rubato's frame and window,
 * an articulation's `@noteid`.
 *
 * The selection rule is `cut.ts`'s, deliberately: per map and per element name, the last slot
 * **before** the window, every slot inside it, and the first slot at or after it. The opening
 * slot is what keeps a prevailing value at the window start (without it the renderer's
 * defaults poison the first sample); the closing slot is what gives the last in-range
 * transition somewhere to arrive. Cut the student and the reference to the same range
 * afterwards and the two documents hold the same elements, in the same order, under the same
 * ids.
 */
import {
    ARTICULATION_MAP,
    ARTICULATION_STYLE,
    DYNAMICS_MAP,
    METRICAL_ACCENTUATION_MAP,
    METRICAL_ACCENTUATION_STYLE,
    ORNAMENTATION_MAP,
    ORNAMENTATION_STYLE,
    RUBATO_MAP,
    TEMPO_MAP,
    mapOfKind,
    styleOfKind,
    type AccentuationTuple,
    type Element,
    type GenericMap,
    type Header,
    type Mpm,
} from 'espressivo';
import type { Range } from '../mpm/types';

/** One of Grünfeld's instructions, as the fitter has to see it. */
export type Slot = {
    /** The reference's `xml:id` — the join key, written unchanged onto the student's element. */
    readonly xmlId: string;
    /** Where the element sits in the reference map, for reading its values back. */
    readonly mapIndex: number;
    /** `@date`, ticks. */
    readonly date: number;
    /** Where the slot's span ends: `@endDate`, else the next slot's date, else the window's end. */
    readonly endDate: number;
    /** `@beatLength` — copied, never fitted (tempo). */
    readonly beatLength?: number;
    /** `@name.ref` — copied, never fitted (accentuation, articulation, ornament). */
    readonly nameRef?: string;
    /** `@frameLength` — copied, never fitted (rubato). */
    readonly frameLength?: number;
    /** `@loop`, `@lateStart`, `@earlyEnd` — the rubato window, copied. */
    readonly loop?: boolean;
    readonly lateStart?: number;
    readonly earlyEnd?: number;
    /** `@noteid`, without the `#` — which notes an articulation governs. */
    readonly noteIds?: readonly string[];
};

/** What `<articulationDef>` the slot names, and which attribute that def actually states. */
export type DefSlot = Slot & {
    readonly defName: string;
    /**
     * `relativeDuration` is fitted; `absoluteDuration` is **skipped with a note**, never
     * coerced into a ratio (risk R6 — the reference has 24 of the first and 1 of the second).
     */
    readonly defStates: readonly ('relativeDuration' | 'relativeVelocity' | 'absoluteDuration')[];
};

/**
 * An `<ornament>` and the `<ornamentDef>` it names.
 *
 * The def's frame and intensity are the student's to fit; its `<dynamicsGradient>` **shape** is
 * not. Shape and `@scale` multiply, so the split between them is a convention rather than a
 * measurement — mpm-desk has a human pick the shape from a crescendo/decrescendo pair, which is
 * why Grünfeld's defs carry four different ones. Copying it and fitting only the scale is what
 * makes the two sides' `@scale` the same quantity.
 */
export type OrnSlot = Slot & {
    readonly defName: string;
    readonly gradient: { readonly from: number; readonly to: number } | null;
};

/** An `<accentuationPattern>` and the shape of the pattern it names — the shape is Grünfeld's. */
export type AccSlot = Slot & { readonly defName: string };

/**
 * One `accentuationPatternDef`, as plain data.
 *
 * The pattern's *shape* is the reference's and is copied verbatim into the student document,
 * so that `@name.ref` resolves on both sides and `@scale` — the one attribute the diff
 * compares for this type — is the only thing the student's playing decides (semantics 15).
 * Carried as numbers rather than as the `Element` so that a `Scaffold` stays structured-clone
 * safe, which is what lets the evidence worker hold one.
 */
export type AccentuationPattern = {
    readonly name: string;
    readonly length: number;
    readonly accentuations: readonly AccentuationTuple[];
};

/** A `<style>` switch the student document has to reproduce for its `@name.ref`s to resolve. */
export type StyleSwitch = { readonly map: string; readonly date: number; readonly nameRef: string };

export type Scaffold = {
    readonly range: Range;
    readonly tempo: readonly Slot[];
    readonly dynamics: readonly Slot[];
    readonly rubato: readonly Slot[];
    readonly accentuation: readonly AccSlot[];
    readonly articulation: readonly DefSlot[];
    readonly ornament: readonly OrnSlot[];
    /** The `accentuationPatternDef`s the in-range slots name, by def name. */
    readonly patterns: ReadonlyMap<string, AccentuationPattern>;
    /** The `styleDef` name each collection uses in the reference, so the student can match it. */
    readonly styleNames: {
        readonly articulation: string | null;
        readonly ornamentation: string | null;
        readonly metricalAccentuation: string | null;
    };
    readonly styleSwitches: readonly StyleSwitch[];
};

const numberAttribute = (element: Element, name: string): number | undefined => {
    const raw = element.getAttributeValue(name);
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
};

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

const idOf = (element: Element): string => element.getAttributeValue('id', XML_NS) ?? '';

/** `noteid="#a #b"` → `['a', 'b']`. */
const noteIdsOf = (element: Element): readonly string[] | undefined => {
    const raw = element.getAttributeValue('noteid');
    if (raw === null) return undefined;
    const ids = raw
        .split(/\s+/)
        .map((token) => token.replace(/^#/, ''))
        .filter((token) => token.length > 0);
    return ids.length > 0 ? ids : undefined;
};

/** Every child of `map` with this local name, with the map index each sits at. */
const indexed = (map: GenericMap | null, name: string): { element: Element; mapIndex: number }[] => {
    if (!map) return [];
    const found: { element: Element; mapIndex: number }[] = [];
    for (let mapIndex = 0; mapIndex < map.size(); mapIndex++) {
        const element = map.getElement(mapIndex);
        if (element && element.getLocalName() === name) found.push({ element, mapIndex });
    }
    return found;
};

/**
 * `cut.ts`'s rule, applied to a list of dated elements: the opening one, the in-range ones,
 * and the closing one. Elements are already in date order — `GenericMap` sorts on parse.
 */
const selectSlots = <T extends { date: number }>(all: readonly T[], { from, to }: Range): T[] => {
    const inside = all.filter((slot) => slot.date >= from && slot.date < to);
    const opening = all.filter((slot) => slot.date < from).slice(-1);
    const closing = all.filter((slot) => slot.date >= to).slice(0, 1);
    return [...opening, ...inside, ...closing];
};

/**
 * Where a slot's span ends. `@endDate` where the reference states it (it does, on every
 * `<tempo>` and `<dynamics>`), else the next element of the same kind, else the window's end
 * — because an instruction prevails until the next one, and the last one prevails to the end
 * of what was played.
 */
const endDatesOf = (dates: readonly number[], stated: readonly (number | undefined)[], to: number): number[] =>
    dates.map((date, i) => stated[i] ?? dates[i + 1] ?? Math.max(to, date));

const readStyleSwitch = (map: GenericMap | null, mapName: string, from: number): StyleSwitch | null => {
    const styles = indexed(map, 'style')
        .map(({ element }) => ({
            date: numberAttribute(element, 'date') ?? 0,
            nameRef: element.getAttributeValue('name.ref'),
        }))
        .filter((style): style is { date: number; nameRef: string } => style.nameRef !== null);
    // The switch in force when the window opens: the last one at or before it, or — where the
    // window opens before any switch — the first one, which `cut.ts` keeps as the opener too.
    const prevailing = styles.filter((style) => style.date <= from).slice(-1)[0] ?? styles[0];
    return prevailing ? { map: mapName, date: prevailing.date, nameRef: prevailing.nameRef } : null;
};

const styleNameIn = (header: Header | null, collection: string): string | null => {
    const defs = header?.getAllStyleDefs(collection);
    const first = defs ? [...defs.keys()][0] : undefined;
    return first ?? null;
};

/**
 * Read Grünfeld's slots for one take.
 *
 * `mpm` is the parsed reference (`parseReferenceMpm`); nothing here mutates it, and the
 * result holds no DOM node.
 */
export const readScaffold = (mpm: Mpm, range: Range): Scaffold => {
    const { from, to } = range;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
        throw new Error(`scaffold: [${from}, ${to}) is not a range`);
    }

    const performance = mpm.getPerformance(0);
    if (!performance) throw new Error('scaffold: no performance in the reference document');
    const global = performance.getGlobal();
    const dated = global?.getDated() ?? null;
    const header = global?.getHeader() ?? null;
    if (!dated) throw new Error('scaffold: the reference performance has no <dated>');

    const tempoMap = mapOfKind(dated.getMap(TEMPO_MAP), 'tempoMap');
    const dynamicsMap = mapOfKind(dated.getMap(DYNAMICS_MAP), 'dynamicsMap');
    const rubatoMap = mapOfKind(dated.getMap(RUBATO_MAP), 'rubatoMap');
    const accentuationMap = mapOfKind(dated.getMap(METRICAL_ACCENTUATION_MAP), 'metricalAccentuationMap');
    const articulationMap = mapOfKind(dated.getMap(ARTICULATION_MAP), 'articulationMap');
    const ornamentMap = mapOfKind(dated.getMap(ORNAMENTATION_MAP), 'ornamentationMap');

    /** The shared shape of every row: id, index, date, and the stated `@endDate` if there is one. */
    const rowsOf = (map: GenericMap | null, name: string) =>
        indexed(map, name).map(({ element, mapIndex }) => ({
            element,
            mapIndex,
            xmlId: idOf(element),
            date: numberAttribute(element, 'date') ?? 0,
            stated: numberAttribute(element, 'endDate'),
        }));

    const withSpans = <T extends { date: number; stated: number | undefined }>(rows: readonly T[]) => {
        const ends = endDatesOf(
            rows.map((row) => row.date),
            rows.map((row) => row.stated),
            to,
        );
        return rows.map((row, i) => ({ ...row, endDate: ends[i] }));
    };

    const tempo: Slot[] = selectSlots(withSpans(rowsOf(tempoMap, 'tempo')), range).map((row) => ({
        xmlId: row.xmlId,
        mapIndex: row.mapIndex,
        date: row.date,
        endDate: row.endDate,
        beatLength: numberAttribute(row.element, 'beatLength') ?? 0.25,
    }));

    const dynamics: Slot[] = selectSlots(withSpans(rowsOf(dynamicsMap, 'dynamics')), range).map((row) => ({
        xmlId: row.xmlId,
        mapIndex: row.mapIndex,
        date: row.date,
        endDate: row.endDate,
    }));

    const rubato: Slot[] = selectSlots(withSpans(rowsOf(rubatoMap, 'rubato')), range).map((row) => {
        const frameLength = numberAttribute(row.element, 'frameLength');
        return {
            xmlId: row.xmlId,
            mapIndex: row.mapIndex,
            date: row.date,
            // A rubato's own span is its frame, unless another rubato interrupts it sooner.
            endDate:
                frameLength === undefined ? row.endDate : Math.min(row.endDate, row.date + frameLength),
            frameLength,
            loop: row.element.getAttributeValue('loop') === 'true',
            lateStart: numberAttribute(row.element, 'lateStart'),
            earlyEnd: numberAttribute(row.element, 'earlyEnd'),
        };
    });

    const accentuation: AccSlot[] = selectSlots(withSpans(rowsOf(accentuationMap, 'accentuationPattern')), range)
        .map((row) => {
            const defName = row.element.getAttributeValue('name.ref') ?? '';
            return {
                xmlId: row.xmlId,
                mapIndex: row.mapIndex,
                date: row.date,
                endDate: row.endDate,
                nameRef: defName,
                defName,
            };
        })
        .filter((slot) => slot.defName.length > 0);

    const articulationStyleName = styleNameIn(header, ARTICULATION_STYLE);
    const articulationStyle = styleOfKind(
        articulationStyleName === null ? null : header?.getStyleDef(ARTICULATION_STYLE, articulationStyleName) ?? null,
        'articulation',
    );

    const articulation: DefSlot[] = selectSlots(withSpans(rowsOf(articulationMap, 'articulation')), range)
        .map((row) => {
            const defName = row.element.getAttributeValue('name.ref') ?? '';
            const def = articulationStyle?.getDef(defName) ?? null;
            const xml = def?.getXmlOrNull() ?? null;
            const states = (['relativeDuration', 'relativeVelocity', 'absoluteDuration'] as const).filter(
                (attribute) => xml?.getAttributeValue(attribute) !== null && xml !== null,
            );
            return {
                xmlId: row.xmlId,
                mapIndex: row.mapIndex,
                date: row.date,
                endDate: row.endDate,
                nameRef: defName,
                defName,
                defStates: states,
                noteIds: noteIdsOf(row.element),
            };
        })
        .filter((slot) => slot.defName.length > 0);

    const ornamentStyleName = styleNameIn(header, ORNAMENTATION_STYLE);
    const ornamentStyle = styleOfKind(
        ornamentStyleName === null ? null : header?.getStyleDef(ORNAMENTATION_STYLE, ornamentStyleName) ?? null,
        'ornamentation',
    );

    const ornament: OrnSlot[] = selectSlots(withSpans(rowsOf(ornamentMap, 'ornament')), range)
        .map((row) => {
            const defName = row.element.getAttributeValue('name.ref') ?? '';
            const gradient = ornamentStyle?.getDef(defName)?.getDynamicsGradient() ?? null;
            return {
                xmlId: row.xmlId,
                mapIndex: row.mapIndex,
                date: row.date,
                endDate: row.endDate,
                nameRef: defName,
                defName,
                gradient: gradient
                    ? { from: gradient.transitionFrom, to: gradient.transitionTo }
                    : null,
            };
        })
        .filter((slot) => slot.defName.length > 0);

    const accentuationStyleName = styleNameIn(header, METRICAL_ACCENTUATION_STYLE);
    const accentuationStyle = styleOfKind(
        accentuationStyleName === null
            ? null
            : header?.getStyleDef(METRICAL_ACCENTUATION_STYLE, accentuationStyleName) ?? null,
        'metricalAccentuation',
    );

    const patterns = new Map<string, AccentuationPattern>();
    for (const slot of accentuation) {
        if (patterns.has(slot.defName)) continue;
        const def = accentuationStyle?.getDef(slot.defName);
        if (!def) continue;
        patterns.set(slot.defName, {
            name: slot.defName,
            length: def.getLength(),
            accentuations: def.getAllAccentuations().map(({ key }) => key),
        });
    }

    const styleSwitches = [
        readStyleSwitch(ornamentMap, ORNAMENTATION_MAP, from),
        readStyleSwitch(accentuationMap, METRICAL_ACCENTUATION_MAP, from),
        readStyleSwitch(articulationMap, ARTICULATION_MAP, from),
    ].filter((style): style is StyleSwitch => style !== null);

    return {
        range,
        tempo,
        dynamics,
        rubato,
        accentuation,
        articulation,
        ornament,
        patterns,
        styleNames: {
            articulation: articulationStyleName,
            ornamentation: ornamentStyleName,
            metricalAccentuation: accentuationStyleName,
        },
        styleSwitches,
    };
};
