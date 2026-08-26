/**
 * The main thread's half of the evidence worker: one promise per take.
 *
 * Also the thinnest thing that can be called a module — a lazily created worker, a map of
 * pending takes, and a fallback. The fallback is the point: a browser without module workers,
 * a build that could not spawn one, or a worker that died mid-take must not cost the student
 * their feedback. `evidenceForTake` is the same pure function the worker calls, so falling
 * back changes where the 90 ms are spent and nothing else.
 *
 * What the fallback is *not* for is an input the fit cannot answer for. That failure is
 * deterministic: the worker computed it, reported it, and running the same input again on this
 * thread would only reach the same throw — 150–350 ms later, on the thread the worker exists to
 * keep free, and logged as though the worker were at fault. The two are told apart by
 * {@link EvidenceComputationError} and only the second kind falls back.
 */
import { evidenceForTake, type Evidence, type EvidenceInput } from '../mpm/evidence';
import type { EvidenceRequest, EvidenceResponse } from './evidence.worker';

/**
 * The worker worked; the take did not. `evidenceForTake` threw on this input, and the worker
 * sent that back as `{ok: false}` rather than dying — so this says nothing about the worker,
 * and the caller gets the error instead of a second, slower helping of it.
 */
class EvidenceComputationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'EvidenceComputationError';
    }
}

/**
 * How long a take may stay in the worker before we stop waiting for it.
 *
 * The `error` event covers a worker that *crashed*; nothing covers one that is merely wedged,
 * and `runTake` awaits this promise — so without a clock the take hangs forever, silently,
 * after `controls.stop()` has already run. Generous next to the 90 ms a take costs (S4 §7):
 * this is the number at which a missing answer stops being slowness and becomes a failure.
 */
const WORKER_TIMEOUT_MS = 5000;

type Pending = {
    resolve: (evidence: Evidence) => void;
    reject: (error: Error) => void;
};

const pending = new Map<number, Pending>();
let worker: Worker | null = null;
let started = false;
let warnedNoWorker = false;
let sequence = 0;

/**
 * The worker, or `null` if this environment cannot give us one. Created once, on first take,
 * and says so — whether the evidence runs off the main thread is the one thing about this
 * module worth seeing in the debug log.
 */
const ensureWorker = (log: (msg: string) => void): Worker | null => {
    if (started) return worker;
    started = true;

    if (typeof Worker === 'undefined') return null;

    try {
        const spawned = new Worker(new URL('./evidence.worker.ts', import.meta.url), { type: 'module' });
        spawned.addEventListener('message', (event: MessageEvent<EvidenceResponse>) => {
            const response = event.data;
            const waiting = pending.get(response.id);
            if (!waiting) return;
            pending.delete(response.id);
            if (response.ok) waiting.resolve(response.evidence);
            else waiting.reject(new EvidenceComputationError(response.error));
        });
        spawned.addEventListener('error', (event: ErrorEvent) => {
            // A worker that failed is a worker we stop using: every take from here on runs on
            // the main thread rather than hanging on a channel nobody is listening to.
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

/** For tests and for a reload: drop the worker so the next take makes a new one. */
export const forgetEvidenceWorker = (): void => {
    worker?.terminate();
    worker = null;
    started = false;
    warnedNoWorker = false;
    pending.clear();
};

/**
 * One take's evidence. In the worker if there is one, in this thread if there is not; the
 * `log` line says which, because it is the difference between a page that stays responsive
 * and one that does not.
 */
export const runEvidence = async (
    input: EvidenceInput,
    log: (msg: string) => void,
): Promise<Evidence> => {
    const active = ensureWorker(log);
    if (!active) {
        // Once per session. `started` is deliberately not reset when the worker fails, so
        // without this every take from then on would repeat the same line.
        if (!warnedNoWorker) {
            warnedNoWorker = true;
            log('EVIDENCE: no worker available -> running on the main thread');
        }
        return evidenceForTake(input);
    }

    const id = ++sequence;
    const request: EvidenceRequest = { id, input };

    try {
        return await new Promise<Evidence>((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`evidence worker did not answer within ${WORKER_TIMEOUT_MS} ms`));
            }, WORKER_TIMEOUT_MS);

            const settle: Pending = {
                resolve: (evidence) => { clearTimeout(timer); resolve(evidence); },
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
        return evidenceForTake(input);
    }
};
