/**
 * The shell, not the worker.
 *
 * `runEvidence` has one decision in it — worker or main thread — and every branch of it is one
 * no browser normally takes: a page that cannot spawn a module worker, a worker that dies
 * mid-take, one that never answers, and one that answers with a failure. Only the first is
 * native to vitest (there is no `Worker` in Node); the rest are stubbed here rather than left
 * to a browser nobody runs the suite in, because a fallback that has never executed is not a
 * fallback.
 *
 * `runPath` is the second job on the same channel (S7): it is asked for after the plan has
 * arrived, gets its own, longer clock, and answers with the corrected document. Its branches are
 * the same ones, so what is tested here is that the two jobs stay told apart.
 *
 * The worker itself is never run here, by design: it has no logic to test. What it calls,
 * `mpm/evidence.ts` and `mpm/path.ts`, is tested directly.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Evidence, EvidenceInput } from '../mpm/evidence';
import type { PathInput, PathResult } from '../mpm/path';
import type { WorkerRequest, WorkerResponse } from './evidence.worker';

const evidenceForTake = vi.fn(
    (input: EvidenceInput): Evidence => ({ studentMpmText: `fitted:${input.range.from}` } as Evidence),
);
const pathPerformance = vi.fn(
    (input: PathInput): PathResult =>
        ({ mpm: `corrected:${input.range.from}`, edits: [], considered: 0, notes: [], diffMs: 0 }),
);

vi.mock('../mpm/evidence', () => ({
    evidenceForTake: (input: EvidenceInput) => evidenceForTake(input),
}));
vi.mock('../mpm/path', () => ({
    pathPerformance: (input: PathInput) => pathPerformance(input),
}));

const { forgetEvidenceWorker, runEvidence, runPath } = await import('./evidenceClient');

const INPUT: EvidenceInput = {
    notes: [],
    range: { from: 720, to: 1440 },
    scoreMsm: '<msm/>',
    referenceMpmText: '<mpm/>',
    fittedReferenceMpmText: '<mpm/>',
};

const PATH_INPUT: PathInput = {
    studentMpmText: '<mpm student="1"/>',
    referenceMpmText: '<mpm/>',
    scoreMsm: '<msm/>',
    range: { from: 720, to: 1440 },
};

// ── a stub for the one object this module talks to ───────────────────────────────────────

/**
 * How the stubbed worker behaves — one per branch. `refuses-construction` is the only one that
 * happens before there is a worker at all: a build that emitted no worker chunk.
 */
type Behaviour =
    | 'answers'
    | 'reports-failure'
    | 'crashes'
    | 'wedges'
    | 'refuses-the-message'
    | 'refuses-construction';

let behaviour: Behaviour = 'answers';
let posted: WorkerRequest[] = [];

class StubWorker {
    private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

    constructor(url: URL, options?: { type?: string }) {
        if (behaviour === 'refuses-construction') throw new Error('module workers are off');
        void url;
        void options;
    }

    addEventListener(type: string, handler: (event: unknown) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
    }

    postMessage(request: WorkerRequest): void {
        if (behaviour === 'refuses-the-message') {
            throw new Error('DataCloneError: could not be cloned');
        }
        posted.push(request);
        if (behaviour === 'wedges') return;
        queueMicrotask(() => {
            if (behaviour === 'crashes') return this.dispatch('error', { message: 'worker died' });
            const outcome: Extract<WorkerResponse, { ok: true }>['outcome'] =
                request.job.kind === 'evidence'
                    ? { kind: 'evidence', evidence: { studentMpmText: 'from the worker' } as Evidence }
                    : {
                        kind: 'path',
                        path: { mpm: 'from the worker', edits: [], considered: 0, notes: [], diffMs: 42 },
                    };
            const response: WorkerResponse = behaviour === 'answers'
                ? { id: request.id, ok: true, outcome }
                : { id: request.id, ok: false, error: 'Error: scaffold: [11520, 11520) is not a range' };
            this.dispatch('message', { data: response });
        });
    }

    terminate(): void {}

    private dispatch(type: string, event: unknown): void {
        for (const handler of this.listeners.get(type) ?? []) handler(event);
    }
}

const withWorker = (how: Behaviour): void => {
    behaviour = how;
    posted = [];
    (globalThis as { Worker?: unknown }).Worker = StubWorker;
    forgetEvidenceWorker();
};

afterEach(() => {
    forgetEvidenceWorker();
    delete (globalThis as { Worker?: unknown }).Worker;
    behaviour = 'answers';
    vi.clearAllMocks();
    vi.useRealTimers();
});

// ── no worker at all ─────────────────────────────────────────────────────────────────────

describe('runEvidence', () => {
    it('runs the path demonstration on this thread too when there is no worker', async () => {
        forgetEvidenceWorker();

        const path = await runPath(PATH_INPUT, () => {});

        expect(path.mpm).toBe('corrected:720');
        expect(pathPerformance).toHaveBeenCalledWith(PATH_INPUT);
    });

    it('runs the take on this thread when there is no worker to run it in', async () => {
        forgetEvidenceWorker();
        const logs: string[] = [];

        const evidence = await runEvidence(INPUT, (msg) => logs.push(msg));

        expect(evidence.studentMpmText).toBe('fitted:720');
        expect(evidenceForTake).toHaveBeenCalledWith(INPUT);
        // Said out loud, because it is the difference between a page that stays responsive
        // during the fit and one that does not.
        expect(logs.some((line) => line.includes('main thread'))).toBe(true);
    });

    it('says it once, however many takes follow', async () => {
        forgetEvidenceWorker();
        const logs: string[] = [];
        const log = (msg: string) => logs.push(msg);

        await runEvidence(INPUT, log);
        await runEvidence(INPUT, log);
        await runEvidence(INPUT, log);

        expect(logs.filter((line) => line.includes('no worker available'))).toHaveLength(1);
        expect(evidenceForTake).toHaveBeenCalledTimes(3);
    });
});

// ── the worker answers ───────────────────────────────────────────────────────────────────

describe('with a worker', () => {
    it('hands the take over and keeps this thread out of it', async () => {
        withWorker('answers');
        const logs: string[] = [];

        const evidence = await runEvidence(INPUT, (msg) => logs.push(msg));

        expect(evidence.studentMpmText).toBe('from the worker');
        expect(evidenceForTake).not.toHaveBeenCalled();
        expect(logs.some((line) => line.includes('worker ready'))).toBe(true);
        // Everything on the request survives the boundary the worker is on the far side of.
        expect(() => structuredClone(posted[0])).not.toThrow();
        expect(structuredClone(posted[0]).job).toEqual({ kind: 'evidence', input: INPUT });
    });

    it('runs the path demonstration as its own job on the same worker', async () => {
        withWorker('answers');
        const logs: string[] = [];

        const path = await runPath(PATH_INPUT, (msg) => logs.push(msg));

        expect(path.mpm).toBe('from the worker');
        expect(path.diffMs).toBe(42);
        expect(pathPerformance).not.toHaveBeenCalled();
        expect(structuredClone(posted[0]).job).toEqual({ kind: 'path', input: PATH_INPUT });
    });

    it('gives the edit script a clock of its own, an order of magnitude wider', async () => {
        withWorker('wedges');
        vi.useFakeTimers();
        const logs: string[] = [];

        const pending = runPath(PATH_INPUT, (msg) => logs.push(msg));
        // `diffMpm` was measured at 1.6 s over eight bars: the evidence's five-second clock
        // would strangle it on a take the demonstration is meant to serve.
        await vi.advanceTimersByTimeAsync(5000);
        expect(pathPerformance).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(15000);
        await expect(pending).resolves.toMatchObject({ mpm: 'corrected:720' });
        expect(logs.some((line) => line.includes('did not answer within 20000'))).toBe(true);
    });
});

// ── the three ways it can fail, and the one that is not a failure of the worker ──────────

describe('when the worker cannot be had', () => {
    it('falls back for every take after a constructor that threw, and says so once', async () => {
        withWorker('refuses-construction');
        const logs: string[] = [];
        const log = (msg: string) => logs.push(msg);

        const first = await runEvidence(INPUT, log);
        const second = await runEvidence(INPUT, log);

        expect(first.studentMpmText).toBe('fitted:720');
        expect(second.studentMpmText).toBe('fitted:720');
        expect(evidenceForTake).toHaveBeenCalledTimes(2);
        expect(logs.filter((line) => line.includes('could not be started'))).toHaveLength(1);
        expect(logs.filter((line) => line.includes('no worker available'))).toHaveLength(1);
    });

    it('finishes the take on this thread when the worker dies under it', async () => {
        withWorker('crashes');
        const logs: string[] = [];

        const evidence = await runEvidence(INPUT, (msg) => logs.push(msg));

        expect(evidence.studentMpmText).toBe('fitted:720');
        expect(logs.some((line) => line.includes('worker failed'))).toBe(true);

        // The dead worker is not used again: the next take goes straight to this thread.
        const later: string[] = [];
        await runEvidence(INPUT, (msg) => later.push(msg));
        expect(evidenceForTake).toHaveBeenCalledTimes(2);
        expect(later.some((line) => line.includes('no worker available'))).toBe(true);
    });

    it('finishes the take on this thread when the worker refuses the message', async () => {
        withWorker('refuses-the-message');
        const logs: string[] = [];

        const evidence = await runEvidence(INPUT, (msg) => logs.push(msg));

        expect(evidence.studentMpmText).toBe('fitted:720');
        expect(logs.some((line) => line.includes('DataCloneError'))).toBe(true);
    });

    it('does not wait forever on a worker that neither answers nor dies', async () => {
        withWorker('wedges');
        vi.useFakeTimers();
        const logs: string[] = [];

        const pending = runEvidence(INPUT, (msg) => logs.push(msg));
        await vi.advanceTimersByTimeAsync(5000);

        // `runTake` awaits this: without the clock the take hangs after `controls.stop()`,
        // with no feedback and no line in the log to explain it.
        await expect(pending).resolves.toEqual({ studentMpmText: 'fitted:720' });
        expect(logs.some((line) => line.includes('did not answer within'))).toBe(true);
    });
});

describe('when the take is what failed', () => {
    it('reports the error instead of paying for it twice', async () => {
        withWorker('reports-failure');
        const logs: string[] = [];

        // `{ok: false}` means the worker computed and the *input* threw — re-running it here
        // would reach the same throw, 150–350 ms later, on the thread the worker keeps free.
        await expect(runEvidence(INPUT, (msg) => logs.push(msg)))
            .rejects.toThrow('is not a range');
        expect(evidenceForTake).not.toHaveBeenCalled();
        expect(logs.some((line) => line.includes('worker failed'))).toBe(false);
    });

    it('keeps the worker for the next take', async () => {
        withWorker('reports-failure');
        const logs: string[] = [];
        const log = (msg: string) => logs.push(msg);

        await expect(runEvidence(INPUT, log)).rejects.toThrow();
        behaviour = 'answers';
        const evidence = await runEvidence(INPUT, log);

        expect(evidence.studentMpmText).toBe('from the worker');
        expect(evidenceForTake).not.toHaveBeenCalled();
    });
});
