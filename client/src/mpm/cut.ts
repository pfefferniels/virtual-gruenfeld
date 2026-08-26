/**
 * Cut an MPM document down to one take's range.
 *
 * `compareMpm` is priced per instruction and `diffMpm` grows as n³·², so neither should ever
 * see the whole piece for a four-bar take. Cutting is not filtering, though: an MPM
 * instruction *prevails* until the next one of its kind, so a naive "keep what is inside the
 * window" would hand the renderer its own defaults at the window start and stretch the last
 * in-range transition to the end of time. What this module guarantees instead, per map and
 * per element name:
 *
 *   1. every element with `from <= @date < to` survives **verbatim** — same `xml:id`,
 *      same attributes, same order;
 *   2. the **opening** element — the last one before `from` — survives, so the window opens
 *      on the value that was actually prevailing (`<style>` switches at date 0 included);
 *   3. the **closing** element — the first one at or after `to` — survives, so the last
 *      in-range ramp ends where it really ends instead of running to the document's end;
 *   4. everything the window cannot see is gone;
 *   5. `<metadata>`, `<performance>` (name, ppq), the `<part>` structure and every
 *      `<header>` style definition are untouched — defs are never pruned, because
 *      `compareMpm` dereferences `@name.ref` into `<articulationDef>`/`<ornamentDef>` and
 *      prices `<style>@defaultArticulation`;
 *   6. the movement map is **dropped whole** (see {@link DROPPED_MAPS}).
 *
 * Measured consequence of 1–5 on `performance.mpm`: with the movement map dropped on both
 * sides, `compareMpm(cut, whole, msm, window)` is 0 in every dimension — the cut is
 * indistinguishable from the full document over its own window. `cut.test.ts` asserts it.
 *
 * Text in, text out (the design's rule for every document boundary), and idempotent:
 * cutting a cut to the same range changes nothing.
 */
import { Mpm, allChildElements, parentElement, type Element } from 'espressivo';
import type { Range } from './types';

/**
 * Maps removed from every cut document.
 *
 * `movementMap` is Grünfeld's pedal: 200 elements, ~37 of them in a six-bar cut, which
 * `diffMpm` alone would price at ~1.7 s — and there is nothing to compare them *to*, since
 * Web MIDI gives us no CC64 from the student. The counter-performance keeps the pedal
 * regardless: it is built on the **uncut** reference.
 */
export const DROPPED_MAPS: readonly string[] = ['movementMap'];

export type CutOptions = {
    /** Map element names to remove entirely. Defaults to {@link DROPPED_MAPS}. */
    readonly dropMaps?: readonly string[];
};

/** An element's `@date` in ticks, or null where there is none to read. */
const dateOf = (element: Element): number | null => {
    const raw = element.getAttributeValue('date');
    if (raw === null) return null;
    const date = Number(raw);
    return Number.isFinite(date) ? date : null;
};

/**
 * Apply rules 1–4 to one map. Elements are grouped by name so that a `<style>` switch keeps
 * its own opening element independently of the `<ornament>`s it governs; an element with no
 * readable `@date` cannot be placed on the timeline and is therefore always kept.
 */
const cutMap = (map: Element, { from, to }: Range): void => {
    const groups = new Map<string, Element[]>();
    for (const child of allChildElements(map)) {
        if (dateOf(child) === null) continue;
        const name = child.getLocalName();
        const group = groups.get(name);
        if (group) group.push(child);
        else groups.set(name, [child]);
    }

    for (const group of groups.values()) {
        let opening = -Infinity;
        let closing = Infinity;
        for (const element of group) {
            const date = dateOf(element) as number;
            if (date < from && date > opening) opening = date;
            if (date >= to && date < closing) closing = date;
        }

        for (const element of group) {
            const date = dateOf(element) as number;
            const keep = (date >= from && date < to) || date === opening || date === closing;
            if (!keep) parentElement(element)?.removeChild(element);
        }
    }
};

/**
 * The take's range as MPM text: everything the window can see, and nothing else.
 *
 * `[from, to)` in ticks — the same half-open convention the renderer cuts MSM with.
 */
export const cutToRange = (mpmText: string, range: Range, options: CutOptions = {}): string => {
    const { from, to } = range;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
        throw new Error(`MPM cut: [${from}, ${to}) is not a range`);
    }

    const dropMaps = new Set(options.dropMaps ?? DROPPED_MAPS);
    const mpm = new Mpm(mpmText);
    if (mpm.isEmpty()) throw new Error('MPM cut: not a well-formed document');

    // A document with no performance is not an MPM that lost its instructions — it is a
    // fetch that returned an error page. Fail on it rather than hand back a valid-looking cut.
    if (mpm.size() === 0) throw new Error('MPM cut: no performance to cut');

    const root = mpm.getRootElement();
    if (!root) throw new Error('MPM cut: document has no root');

    // Walked rather than queried: XPath over a document this size costs seconds where the
    // walk costs milliseconds (the lesson `services/mpmRenderer.ts` learnt on performed MSM).
    for (const performance of allChildElements(root, 'performance')) {
        const scopes = [
            ...allChildElements(performance, 'global'),
            ...allChildElements(performance, 'part'),
        ];
        for (const scope of scopes) {
            for (const dated of allChildElements(scope, 'dated')) {
                for (const map of allChildElements(dated)) {
                    if (dropMaps.has(map.getLocalName())) dated.removeChild(map);
                    else cutMap(map, range);
                }
            }
        }
    }

    const text = mpm.writeMpm();
    if (text === null) throw new Error('MPM cut: document could not be written');
    return text;
};

/**
 * Both sides of one take's comparison, cut identically — step 3 of the take's data flow.
 * The two documents must be cut with the same rule or the window would open on different
 * values on either side.
 */
export const cutPairToRange = (
    referenceMpmText: string,
    studentMpmText: string,
    range: Range,
    options: CutOptions = {},
): { refCut: string; stuCut: string } => ({
    refCut: cutToRange(referenceMpmText, range, options),
    stuCut: cutToRange(studentMpmText, range, options),
});
