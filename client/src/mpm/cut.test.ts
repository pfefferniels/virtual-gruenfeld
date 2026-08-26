import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Mpm, allChildElements, compareMpm, type Element } from 'espressivo';
import { describe, expect, it } from 'vitest';
import { PPQ, tickToPos } from '../shared/constants';
import { convert } from '../services/mpmRenderer';
import { DROPPED_MAPS, cutPairToRange, cutToRange } from './cut';
import type { Range } from './types';

const load = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const reference = load('../../public/performance.mpm');
const scoreMsm = convert(load('../../public/score.mei'));

/** A four-bar take: m5.1 to m9.1 on `tickToPos`'s reading of the grid. */
const TAKE: Range = { from: 11520, to: 23040 };
/** The whole piece — the reference's last date is 91 464 ticks. */
const WHOLE: Range = { from: 0, to: 92160 };

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

const mapsOf = (mpmText: string): Map<string, Element> => {
    const dated = new Mpm(mpmText).getPerformance(0)!.getGlobal()!.getDated()!;
    const maps = new Map<string, Element>();
    for (const [name, map] of dated.getAllMaps()) maps.set(name, map.getXml()!);
    return maps;
};

const elementsOf = (mpmText: string, mapName: string, elementName?: string): Element[] => {
    const map = mapsOf(mpmText).get(mapName);
    return map ? allChildElements(map, elementName) : [];
};

const idsOf = (elements: readonly Element[]): (string | null)[] =>
    elements.map((element) => element.getAttributeValue('id', XML_NS));

const datesOf = (elements: readonly Element[]): number[] =>
    elements.map((element) => Number(element.getAttributeValue('date')));

const cut = cutToRange(reference, TAKE);

describe('what a cut keeps', () => {
    it('names the take by its position, so the range under test is the readable one', () => {
        expect([tickToPos(TAKE.from), tickToPos(TAKE.to)]).toEqual(['m5.1', 'm9.1']);
        expect(TAKE.to - TAKE.from).toBe(4 * 4 * PPQ);
    });

    /**
     * The tempo map spelled out: one opening instruction before the window (10 440), the
     * eight inside it, and one closing instruction after it (23 760). Grünfeld's ids, in
     * Grünfeld's order, unchanged — this is the scaffold the student is fitted into.
     */
    it('keeps every in-range instruction verbatim, plus the one before and the one after', () => {
        expect(idsOf(elementsOf(cut, 'tempoMap', 'tempo'))).toEqual([
            'tempo_10440',
            'tempo_12240',
            'tempo_13680',
            'tempo_14400',
            'tempo_16560',
            'tempo_18360',
            'tempo_19440',
            'tempo_20880',
            'tempo_22320',
            'tempo_23760',
        ]);
    });

    it('copies the kept instructions attribute for attribute', () => {
        const before = elementsOf(reference, 'dynamicsMap', 'dynamics').find(
            (element) => element.getAttributeValue('id', XML_NS) === 'dynamics_12240',
        )!;
        const after = elementsOf(cut, 'dynamicsMap', 'dynamics').find(
            (element) => element.getAttributeValue('id', XML_NS) === 'dynamics_12240',
        )!;
        expect(after.toXML()).toBe(before.toXML());
    });

    it.each([
        ['tempoMap', 'tempo', 10],
        ['dynamicsMap', 'dynamics', 11],
        ['rubatoMap', 'rubato', 10],
        ['metricalAccentuationMap', 'accentuationPattern', 9],
        ['articulationMap', 'articulation', 11],
        ['ornamentationMap', 'ornament', 13],
    ])('drops everything else from %s: %s × %i survives', (mapName, elementName, count) => {
        expect(elementsOf(cut, mapName, elementName)).toHaveLength(count);
    });

    it('opens on the value that was prevailing and closes on the next one, in every map', () => {
        for (const [mapName, elementName] of [
            ['tempoMap', 'tempo'],
            ['dynamicsMap', 'dynamics'],
            ['rubatoMap', 'rubato'],
            ['metricalAccentuationMap', 'accentuationPattern'],
            ['articulationMap', 'articulation'],
            ['ornamentationMap', 'ornament'],
        ] as const) {
            const whole = datesOf(elementsOf(reference, mapName, elementName));
            const kept = datesOf(elementsOf(cut, mapName, elementName));

            const before = whole.filter((date) => date < TAKE.from);
            const after = whole.filter((date) => date >= TAKE.to);
            const inside = whole.filter((date) => date >= TAKE.from && date < TAKE.to);

            expect(kept).toEqual([
                ...(before.length ? [Math.max(...before)] : []),
                ...inside,
                ...(after.length ? [Math.min(...after)] : []),
            ]);
            // …and it really is a cut, not a copy.
            expect(kept.length).toBeLessThan(whole.length);
        }
    });

    /**
     * A `<style>` switch sits in the map beside the instructions it governs and is dated 0.
     * It is a group of its own, so the "keep the prevailing one" rule reaches it: lose it and
     * every `@name.ref` in the cut would dangle.
     */
    it('keeps the style switch at date 0 that binds the map to its definitions', () => {
        for (const mapName of ['ornamentationMap', 'metricalAccentuationMap']) {
            const styles = elementsOf(cut, mapName, 'style');
            expect(styles).toHaveLength(1);
            expect(datesOf(styles)).toEqual([0]);
            expect(styles[0].getAttributeValue('name.ref')).toBe('performance_style');
        }
    });

    it('never prunes the definitions those references resolve into', () => {
        const header = allChildElements(
            new Mpm(cut).getPerformance(0)!.getGlobal()!.getXml()!,
            'header',
        )[0];
        const defs = (collection: string, def: string) =>
            allChildElements(allChildElements(allChildElements(header, collection)[0], 'styleDef')[0], def);

        expect(defs('ornamentationStyles', 'ornamentDef')).toHaveLength(77);
        expect(defs('metricalAccentuationStyles', 'accentuationPatternDef')).toHaveLength(42);
        expect(defs('articulationStyles', 'articulationDef')).toHaveLength(26);
    });

    it('keeps the document a document: metadata, performance name, tick grid', () => {
        const mpm = new Mpm(cut);
        expect(mpm.getMetadata()?.getAuthorByIndex(0)?.getName()).toBe('Niels Pfeffer');
        expect(mpm.getPerformance(0)?.getName()).toBe('unknown');
        expect(mpm.getPerformance(0)?.getPulsesPerQuarter()).toBe(PPQ);
    });

    it('cuts a range that reaches past the last instruction without inventing one', () => {
        const tail = cutToRange(reference, { from: 88560, to: 92160 });
        const dates = datesOf(elementsOf(tail, 'tempoMap', 'tempo'));
        expect(Math.max(...dates)).toBe(91440);
        expect(dates.every((date) => date <= 91440)).toBe(true);
    });
});

describe('the movement map', () => {
    it('is dropped: 200 pedal instructions nothing on the student side can answer', () => {
        expect(DROPPED_MAPS).toEqual(['movementMap']);
        expect(mapsOf(reference).has('movementMap')).toBe(true);
        expect(mapsOf(cut).has('movementMap')).toBe(false);
    });

    it('is kept when a caller asks for it — the counter-performance still needs the pedal', () => {
        const withPedal = cutToRange(reference, TAKE, { dropMaps: [] });
        expect(elementsOf(withPedal, 'movementMap', 'movement')).toHaveLength(26);
    });
});

/**
 * The guarantee that makes the cut safe to compare against: over its own window, a cut
 * document is indistinguishable from the whole one. Anything the cut lost — a prevailing
 * value, a transition's end — would show up here as a non-zero dimension.
 */
describe('window equivalence', () => {
    const window = { start: TAKE.from / PPQ, end: TAKE.to / PPQ };
    const distances = (a: string, b: string) => {
        const { report } = compareMpm({ a, b, msm: scoreMsm, window });
        return Object.entries(report.dimensions)
            .filter(([, dimension]) => dimension.distance !== 0)
            .map(([name, dimension]) => [name, dimension.distance] as const);
    };

    it('compares to the whole performance as 0 in every dimension', () => {
        expect(distances(cut, cutToRange(reference, WHOLE))).toEqual([]);
    });

    it('differs from the uncut document in the pedal alone — the one thing it drops', () => {
        const differing = distances(cut, reference);
        expect(differing.map(([name]) => name)).toEqual(['pedal']);
        expect(differing[0][1]).toBeGreaterThan(0);
    });

    it('is 0 against itself', () => {
        expect(distances(cut, cut)).toEqual([]);
    });
});

describe('cutting is a function of the range, not of the document it is given', () => {
    it('is idempotent: cutting a cut to the same range changes nothing', () => {
        expect(cutToRange(cut, TAKE)).toBe(cut);
    });

    it('is deterministic', () => {
        expect(cutToRange(reference, TAKE)).toBe(cut);
    });

    it('cuts both sides of a take with one call', () => {
        const student = cutToRange(reference, WHOLE); // any second document will do here
        const { refCut, stuCut } = cutPairToRange(reference, student, TAKE);
        expect(refCut).toBe(cut);
        expect(stuCut).toBe(cutToRange(student, TAKE));
    });

    it.each([
        [{ from: 23040, to: 11520 }],
        [{ from: 11520, to: 11520 }],
        [{ from: Number.NaN, to: 11520 }],
        [{ from: 0, to: Number.POSITIVE_INFINITY }],
    ])('refuses %o', (range) => {
        expect(() => cutToRange(reference, range)).toThrow(/not a range/);
    });

    it('refuses a document that is not MPM — an error page is not an empty performance', () => {
        expect(() => cutToRange('<html><body>404</body></html>', TAKE)).toThrow(/no performance/);
        expect(() => cutToRange('not xml at all', TAKE)).toThrow();
    });
});

/**
 * The reference declares no `<part>`, but the student's MPM may one day, and `compareMpm`
 * returns null for `sharedCurves` if the two documents' part scopes disagree. The cut must
 * therefore leave the part structure exactly as it found it and cut each part's maps on
 * their own.
 */
describe('part structure', () => {
    const parted = `<?xml version="1.0" encoding="UTF-8"?>
<mpm>
  <performance name="student" pulsesPerQuarter="720">
    <global>
      <dated>
        <tempoMap>
          <tempo xml:id="tempo_0" date="0" bpm="60" beatLength="0.25"/>
          <tempo xml:id="tempo_720" date="720" bpm="70" beatLength="0.25"/>
          <tempo xml:id="tempo_2880" date="2880" bpm="80" beatLength="0.25"/>
          <tempo xml:id="tempo_5760" date="5760" bpm="90" beatLength="0.25"/>
          <tempo xml:id="tempo_8640" date="8640" bpm="100" beatLength="0.25"/>
        </tempoMap>
      </dated>
    </global>
    <part name="right" number="1" midi.channel="0" midi.port="0">
      <header>
        <articulationStyles>
          <styleDef name="s"><articulationDef name="legato" relativeDuration="1.1"/></styleDef>
        </articulationStyles>
      </header>
      <dated>
        <articulationMap>
          <style name.ref="s" date="0"/>
          <articulation xml:id="a0" date="0" name.ref="legato"/>
          <articulation xml:id="a2880" date="2880" name.ref="legato"/>
          <articulation xml:id="a5760" date="5760" name.ref="legato"/>
          <articulation xml:id="a8640" date="8640" name.ref="legato"/>
        </articulationMap>
      </dated>
    </part>
  </performance>
</mpm>`;

    const partCut = cutToRange(parted, { from: 2880, to: 5760 });
    const performance = new Mpm(partCut).getPerformance(0)!;

    it('leaves the part where it was, with its attributes and its own header', () => {
        const part = performance.getPart(1)!;
        const xml = part.getXml()!;
        expect(xml.getAttributeValue('name')).toBe('right');
        expect(xml.getAttributeValue('midi.channel')).toBe('0');
        expect(
            allChildElements(allChildElements(allChildElements(xml, 'header')[0], 'articulationStyles')[0], 'styleDef'),
        ).toHaveLength(1);
    });

    it('cuts the global maps and the part maps by the same rule', () => {
        const global = allChildElements(
            allChildElements(performance.getGlobal()!.getDated()!.getXml()!, 'tempoMap')[0],
            'tempo',
        );
        expect(idsOf(global)).toEqual(['tempo_720', 'tempo_2880', 'tempo_5760']);

        const local = allChildElements(
            allChildElements(performance.getPart(1)!.getDated()!.getXml()!, 'articulationMap')[0],
            'articulation',
        );
        expect(idsOf(local)).toEqual(['a0', 'a2880', 'a5760']);
    });
});
