/**
 * The main thread's half of the evidence worker: one promise per take.
 *
 * Also the thinnest thing that can be called a module — a lazily created worker, a map of
 * pending takes, and a fallback. The fallback is the point: a browser without module workers,
 * a build that could not spawn one, or a worker that died mid-take must not cost the student
 * their feedback. `evidenceForTake` is the same pure function the worker calls, so falling
 * back changes where the 90 ms are spent and nothing else.
 */
import { evidenceForTake, type Evidence, type EvidenceInput } from '../mpm/evidence';
import type { EvidenceRequest, EvidenceResponse } from './evidence.worker';

type Pending = {
    resolve: (evidence: Evidence) => void;
    reject: (error: Error) => void;
};

const pending = new Map<number, Pending>();
let worker: Worker | null = null;
let started = false;
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
            else waiting.reject(new Error(response.error));
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
        log('EVIDENCE: no worker available -> running on the main thread');
        return evidenceForTake(input);
    }

    const id = ++sequence;
    const request: EvidenceRequest = { id, input };

    try {
        return await new Promise<Evidence>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            active.postMessage(request);
        });
    } catch (error) {
        log(`EVIDENCE: worker failed (${String(error)}) -> running on the main thread`);
        return evidenceForTake(input);
    }
};
