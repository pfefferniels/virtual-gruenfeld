import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { allChildElements, compareMpm } from 'espressivo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { convert } from '../services/mpmRenderer';
import {
    REFERENCE_MPM_URL,
    forgetReferenceMpm,
    loadReferenceMpm,
    parseReferenceMpm,
} from './reference';

const path = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const load = (relative: string): string => readFileSync(path(relative), 'utf8');

const SERVED = '../../public/performance.mpm';
const COMMITTED = '../../../assets/all/performance.mpm';

const referenceMpm = load(SERVED);

afterEach(() => {
    forgetReferenceMpm();
    vi.unstubAllGlobals();
});

/**
 * DESIGN §5 test 12. The client fetches its reference and the server's corpus reads its
 * evidence; both must be the same performance, so the two files are one file in two places.
 * Regenerate the copy with `cp assets/all/performance.mpm client/public/performance.mpm`.
 */
describe('provenance', () => {
    it('client/public/performance.mpm is byte-identical to assets/all/performance.mpm', () => {
        const served = readFileSync(path(SERVED));
        const committed = readFileSync(path(COMMITTED));
        expect(served.length).toBe(committed.length);
        expect(served.equals(committed)).toBe(true);
    });
});

describe('loadReferenceMpm', () => {
    const respond = (body: string, init: { ok?: boolean; status?: number } = {}) => {
        const fetchMock = vi.fn(async () =>
            ({
                ok: init.ok ?? true,
                status: init.status ?? 200,
                statusText: init.ok === false ? 'Not Found' : 'OK',
                text: async () => body,
            }) as unknown as Response,
        );
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    };

    it('fetches the document served next to score.mei', async () => {
        const fetchMock = respond(referenceMpm);
        await expect(loadReferenceMpm()).resolves.toBe(referenceMpm);
        expect(fetchMock).toHaveBeenCalledWith(REFERENCE_MPM_URL);
        expect(REFERENCE_MPM_URL).toBe('performance.mpm');
    });

    it('fetches once per session — 150 kB that never changes', async () => {
        const fetchMock = respond(referenceMpm);
        const [first, second] = await Promise.all([loadReferenceMpm(), loadReferenceMpm()]);
        expect(first).toBe(second);
        await loadReferenceMpm();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reports an HTTP failure and does not memoize it, so a boot may retry', async () => {
        respond('gone', { ok: false, status: 404 });
        await expect(loadReferenceMpm()).rejects.toThrow(/404/);

        const retry = respond(referenceMpm);
        await expect(loadReferenceMpm()).resolves.toBe(referenceMpm);
        expect(retry).toHaveBeenCalledTimes(1);
    });

    it('refuses an empty body', async () => {
        respond('   \n');
        await expect(loadReferenceMpm()).rejects.toThrow(/empty document/);
    });

    it('is the only MPM the app fetches', async () => {
        // The comparison side used to be a second committed document, `reference.fitted.mpm`.
        // It is now fitted per take from this one (`mpm/evidence.ts`), so a boot makes exactly
        // one MPM request — and nothing can serve a stale fit in place of a fresh one.
        const fetchMock = vi.fn(async (url: string) =>
            ({ ok: true, status: 200, statusText: 'OK', text: async () => `<mpm>${url}</mpm>` }) as unknown as Response,
        );
        vi.stubGlobal('fetch', fetchMock);

        await expect(loadReferenceMpm()).resolves.toContain(REFERENCE_MPM_URL);
        await loadReferenceMpm();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([REFERENCE_MPM_URL]);
    });
});

describe('parseReferenceMpm', () => {
    it('reads one performance on the 720 grid', () => {
        const performance = parseReferenceMpm(referenceMpm).getPerformance(0);
        expect(performance?.getPulsesPerQuarter()).toBe(720);
        expect(performance?.getGlobal()?.getDated()).toBeTruthy();
    });

    it('rejects a document that is not MPM', () => {
        expect(() => parseReferenceMpm('<html><body>404</body></html>')).toThrow();
    });

    it('rejects a foreign tick grid, because every date in this project assumes 720', () => {
        const wrongPpq = referenceMpm.replace('pulsesPerQuarter="720"', 'pulsesPerQuarter="480"');
        expect(() => parseReferenceMpm(wrongPpq)).toThrow(/720/);
    });
});

/**
 * The point of loading `performance.mpm` instead of rebuilding it: the scaffold the student's
 * performance is fitted into — Grünfeld's own dates and `${type}_${date}` ids — is printed in
 * the document. If these counts move, the reference was rebaked and the pairing key changed.
 */
describe('the scaffold the document prints', () => {
    const dated = parseReferenceMpm(referenceMpm).getPerformance(0)!.getGlobal()!.getDated()!;
    const elementsOf = (mapName: string, elementName: string) =>
        allChildElements(dated.getMap(mapName)!.getXml()!, elementName);

    it.each([
        ['tempoMap', 'tempo', 60],
        ['dynamicsMap', 'dynamics', 61],
        ['rubatoMap', 'rubato', 56],
        ['metricalAccentuationMap', 'accentuationPattern', 51],
        ['articulationMap', 'articulation', 47],
        ['ornamentationMap', 'ornament', 100],
        ['movementMap', 'movement', 200],
    ])('%s carries %s × %i', (mapName, elementName, count) => {
        expect(elementsOf(mapName, elementName)).toHaveLength(count);
    });

    it('has no asynchrony map: the dimension is a contract, never a measurement', () => {
        expect(dated.getMap('asynchronyMap')).toBeNull();
    });

    it('names tempo, dynamics and rubato by `${type}_${date}` — the join key, already written', () => {
        for (const [mapName, elementName] of [
            ['tempoMap', 'tempo'],
            ['dynamicsMap', 'dynamics'],
            ['rubatoMap', 'rubato'],
        ] as const) {
            for (const element of elementsOf(mapName, elementName)) {
                const date = element.getAttributeValue('date');
                expect(element.getAttributeValue('id', 'http://www.w3.org/XML/1998/namespace'))
                    .toBe(`${elementName}_${date}`);
            }
        }
    });

    it('keeps the corpus links a rebake would lose', () => {
        const tempo = allChildElements(dated.getMap('tempoMap')!.getXml()!, 'tempo')[0];
        expect(tempo.getAttributeValue('endDate')).toBeTruthy();
        expect(tempo.getAttributeValue('corresp')).toBeTruthy();
    });
});

/**
 * DESIGN §5 test 1, the half of it this slice can state: comparing the reference with itself
 * is zero in every dimension. Everything downstream — the audibility gate, the direction
 * cross-check, the fallback curve — is read off a report whose zero must be a real zero.
 */
describe('identity', () => {
    it('compareMpm(reference, reference) is 0 everywhere', () => {
        const msm = convert(load('../../public/score.mei'));
        const { report } = compareMpm({ a: referenceMpm, b: referenceMpm, msm });

        expect(report.aggregate.distance).toBe(0);
        expect(report.aggregate.mean).toBe(0);
        for (const [dimension, comparison] of Object.entries(report.dimensions)) {
            expect([dimension, comparison.distance]).toEqual([dimension, 0]);
            expect(['compared', 'both-neutral']).toContain(comparison.state);
        }
        expect(report.comparability.suspectPair).toBe(false);
    });
});
