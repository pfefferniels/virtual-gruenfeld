/**
 * The main thread's half of the evidence worker: one promise per job.
 *
 * Also the thinnest thing that can be called a module — a lazily created worker, a map of pending
 * jobs, and a fallback. The fallback is the point: a browser without module workers, a build that
 * could not spawn one, or a worker that died mid-take must not cost the student their feedback.
 * `evidenceForTake` and `pathPerformance` are the same pure functions the worker calls, so
 * falling back changes where the milliseconds are spent and nothing else.
 *
 * What the fallback is *not* for is an input the job cannot answer for. That failure is
 * deterministic: the worker computed it, reported it, and running the same input again on this
 * thread would only reach the same throw — later, on the thread the worker exists to keep free,
 * and logged as though the worker were at fault. The two are told apart by
 * {@link EvidenceComputationError} and only the second kind falls back.
 */
import { evidenceForTake, type Evidence, type EvidenceInput } from '../mpm/evidence';
import { pathPerformance, type PathInput, type PathResult } from '../mpm/path';
import type { WorkerJob, WorkerOutcome, WorkerRequest, WorkerResponse } from './evidence.worker';

/**
 * The worker worked; the job did not. The pure function threw on this input, and the worker sent
 * that back as `{ok: false}` rather than dying — so this says nothing about the worker, and the
 * caller gets the error instead of a second, slower helping of it.
 */
class EvidenceComputationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'EvidenceComputationError';
    }
}

/**
 * How long a job may stay in the worker before we stop waiting for it.
 *
 * The `error` event covers a worker that *crashed*; nothing covers one that is merely wedged, and
 * the take awaits these promises — so without a clock a take hangs forever, silently, after
 * `controls.stop()` has already run. Two budgets, because the two jobs are two orders of
 * magnitude apart: the evidence is ~90 ms and generous at five seconds, while `diffMpm` grows as
 * n³·² and was measured at 0.5 s over four bars and 1.6 s over eight (`mpm/path.ts`). One clock
 * for both would either strangle the demonstration or leave a wedged take hanging for half a
 * minute.
 */
const TIMEOUT_MS: Record<WorkerJob['kind'], number> = { evidence: 5000, path: 20000 };

type Pending = {
    resolve: (outcome: WorkerOutcome) => void;
    reject: (error: Error) => void;
};

const pending = new Map<number, Pending>();
let worker: Worker | null = null;
let started = false;
let warnedNoWorker = false;
let sequence = 0;

/**
 * The worker, or `null` if this environment cannot give us one. Created once, on first take, and
 * says so — whether the evidence runs off the main thread is the one thing about this module
 * worth seeing in the debug log.
 */
const ensureWorker = (log: (msg: string) => void): Worker | null => {
    if (started) return worker;
    started = true;

    if (typeof Worker === 'undefined') return null;

    try {
        const spawned = new Worker(new URL('./evidence.worker.ts', import.meta.url), { type: 'module' });
        spawned.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
            const response = event.data;
            const waiting = pending.get(response.id);
            if (!waiting) return;
            pending.delete(response.id);
            if (response.ok) waiting.resolve(response.outcome);
            else waiting.reject(new EvidenceComputationError(response.error));
        });
        spawned.addEventListener('error', (event: ErrorEvent) => {
            // A worker that failed is a worker we stop using: every job from here on runs on the
            // main thread rather than hanging on a channel nobody is listening to.
            const reason = new Error(`evidence worker failed: ${event.message}`);
            for (const [, waiting] of pending) waiting.reject(reason);
            pending.clear();
            worker = null;
        });
        worker = spawned;
        log('EVIDENCE: worker ready — takes are fitted off the main thread');
    } catch (error) {
        log(`EVIDENCE: worker could not be started (${String(error)})`);
        worker = null;
    }

    return worker;
};

/** For tests and for a reload: drop the worker so the next job makes a new one. */
export const forgetEvidenceWorker = (): void => {
    worker?.terminate();
    worker = null;
    started = false;
    warnedNoWorker = false;
    pending.clear();
};

/** The same job, run here. What the worker would have called, called directly. */
const runHere = (job: WorkerJob): WorkerOutcome =>
    job.kind === 'evidence'
        ? { kind: 'evidence', evidence: evidenceForTake(job.input) }
        : { kind: 'path', path: pathPerformance(job.input) };

/**
 * One job. In the worker if there is one, on this thread if there is not; the `log` line says
 * which, because it is the difference between a page that stays responsive and one that does not.
 */
const runJob = async (job: WorkerJob, log: (msg: string) => void): Promise<WorkerOutcome> => {
    const active = ensureWorker(log);
    if (!active) {
        // Once per session. `started` is deliberately not reset when the worker fails, so without
        // this every job from then on would repeat the same line.
        if (!warnedNoWorker) {
            warnedNoWorker = true;
            log('EVIDENCE: no worker available -> running on the main thread');
        }
        return runHere(job);
    }

    const id = ++sequence;
    const request: WorkerRequest = { id, job };
    const timeout = TIMEOUT_MS[job.kind];

    try {
        return await new Promise<WorkerOutcome>((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`evidence worker did not answer within ${timeout} ms`));
            }, timeout);

            const settle: Pending = {
                resolve: (outcome) => { clearTimeout(timer); resolve(outcome); },
                reject: (error) => { clearTimeout(timer); reject(error); },
            };
            pending.set(id, settle);

            try {
                active.postMessage(request);
            } catch (error) {
                // Nothing will ever answer this id — a structured-clone failure on the way out
                // never reaches the worker — so the entry goes with it.
                pending.delete(id);
                settle.reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    } catch (error) {
        if (error instanceof EvidenceComputationError) throw error;
        log(`EVIDENCE: worker failed (${String(error)}) -> running on the main thread`);
        return runHere(job);
    }
};

/** One take's evidence: fit, cut, compare, pair, diff. */
export const runEvidence = async (input: EvidenceInput, log: (msg: string) => void): Promise<Evidence> => {
    const outcome = await runJob({ kind: 'evidence', input }, log);
    // Unreachable by construction — the worker answers the job it was given — and stated anyway,
    // because the alternative is a type assertion that would go quiet if a third job were added.
    if (outcome.kind !== 'evidence') throw new Error('evidence worker answered the wrong job');
    return outcome.evidence;
};

/**
 * `mode: 'path'` — the student's own playing with the k costliest edits applied. Asked for after
 * the plan has arrived, which is why it is a second round trip rather than part of the take.
 */
export const runPath = async (input: PathInput, log: (msg: string) => void): Promise<PathResult> => {
    const outcome = await runJob({ kind: 'path', input }, log);
    if (outcome.kind !== 'path') throw new Error('evidence worker answered the wrong job');
    return outcome.path;
};
