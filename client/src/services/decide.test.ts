import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    deviationsFrom,
    requestDecision,
    type DecisionRequest,
    type DecisionResponse,
    type DecisionVerdict,
    type Deviation,
} from './decide';

afterEach(() => vi.unstubAllGlobals());

/** One event in the shape `mpm/diff.ts` writes. */
const event = (over: Record<string, unknown> = {}) => ({
    id: 'tempo_12240_0',
    date: 12240,
    position: 'm5.2',
    type: 'tempo',
    severity: 'large',
    primaryAttr: 'bpm',
    magnitude: 22.9,
    cueText: 'bewegter',
    direction: 'more',
    refValue: 57.4,
    studentValue: 80.3,
    ...over,
});

describe('deviationsFrom', () => {
    it('keeps only what the decision reads, under the names the server expects', () => {
        expect(deviationsFrom([event()])).toEqual<Deviation[]>([{
            at: 'm5.2',
            dimension: 'tempo',
            attribute: 'bpm',
            severity: 'large',
            direction: 'more',
            cue: 'bewegter',
            gruenfeld: 57.4,
            student: 80.3,
        }]);
    });

    it('drops the dimensions a short window cannot identify', () => {
        const mixed = [event(), event({ type: 'rubato' }), event({ type: 'articulation' }), event({ type: 'dynamics' })];
        expect(deviationsFrom(mixed).map((d) => d.dimension)).toEqual(['tempo', 'dynamics']);
    });

    it('caps the payload, because state size drives the latency tail', () => {
        const many = Array.from({ length: 20 }, () => event());
        expect(deviationsFrom(many)).toHaveLength(8);
    });

    it('survives an event missing the fields it wants, rather than sending undefined', () => {
        const [only] = deviationsFrom([{ type: 'tempo' }]);
        expect(only).toEqual<Deviation>({
            at: '', dimension: 'tempo', attribute: '', severity: '', direction: '', cue: '',
            gruenfeld: 0, student: 0,
        });
    });
});

describe('requestDecision', () => {
    const request: DecisionRequest = {
        range: { from: 11520, to: 17280 },
        position: 'bar 7',
        barsMeasured: '5–7',
        handsOffKeys: true,
        measuredTypes: ['tempo'],
        alreadyCorrectedThisLesson: [],
        deviations: deviationsFrom([event()]),
    };

    const respond = (body: unknown, ok = true) => {
        const fetchMock = vi.fn(async () => ({
            ok,
            status: ok ? 200 : 500,
            statusText: ok ? 'OK' : 'Server Error',
            json: async () => body,
            text: async () => JSON.stringify(body),
        }) as unknown as Response);
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    };

    it('posts the window to /decide and hands back the verdict', async () => {
        const verdict: DecisionVerdict = {
            interrupt: 0.71, dimension: 'tempo', severity: 3.1, exaggeration: 1.4, mode: 'reference', latencyMs: 588,
        };
        const fetchMock = respond({ verdict, plan: { mode: 'reference' } });

        const answer = await requestDecision<{ mode: string }>('https://teacher.example', request);
        expect(answer.verdict).toEqual(verdict);
        expect(answer.plan).toEqual({ mode: 'reference' });

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://teacher.example/decide');
        expect(JSON.parse(String(init.body))).toEqual(request);
    });

    it('does not double the slash when the server url carries one', async () => {
        const fetchMock = respond({ verdict: null, plan: null, skipped: 'abandoned' });
        await requestDecision('https://teacher.example/', request);
        expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://teacher.example/decide');
    });

    it('reports a missing verdict as a skip rather than an error, so the lesson goes on', async () => {
        respond({ verdict: null, plan: null, skipped: 'abandoned' });
        const answer: DecisionResponse<unknown> = await requestDecision('https://teacher.example', request);
        expect(answer.verdict).toBeNull();
        expect(answer.skipped).toBe('abandoned');
    });

    it('throws when the server itself fails', async () => {
        respond({ error: 'boom' }, false);
        await expect(requestDecision('https://teacher.example', request)).rejects.toThrow(/500/);
    });
});
