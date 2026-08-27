/**
 * The evidence, off the main thread.
 *
 * Deliberately the thinnest thing that can be called a module: receive a job, call the pure
 * function that does it, post the result back. Every decision, every number and every test lives
 * in `mpm/evidence.ts`, `mpm/path.ts` and below them — a worker cannot be unit-tested without a
 * harness that proves nothing about the fitting, and logic that only runs here would be logic
 * nothing checks.
 *
 * Two jobs, and they arrive at different moments in one take. `evidence` is the take itself —
 * ~90 ms of parsing, rendering and integrating (S4 §7); on the main thread that is 90 ms in which
 * the page cannot repaint, right after the student lifts their hands. `path` is DESIGN §3.5's
 * demonstration and comes *after* the plan has returned, because only then is it known whether
 * the teacher asked for it: it is half a second of `diffMpm` and up (risk R4), spent while the
 * teacher is already speaking.
 *
 * Neither job takes a logging callback — a function does not survive `postMessage` — so what
 * either of them wants said comes back as data and the main thread writes it to the log.
 *
 * `globalThis` is narrowed by hand rather than by `/// <reference lib="webworker" />`: the
 * client's `tsconfig` compiles this file in the same program as the React app, and pulling the
 * worker lib in would redeclare half of `DOM`.
 */
import { evidenceForTake, type Evidence, type EvidenceInput } from '../mpm/evidence';
import { pathPerformance, type PathInput, type PathResult } from '../mpm/path';

/** What the worker is asked to do. Tagged, because the two jobs share nothing but the channel. */
export type WorkerJob =
    | { readonly kind: 'evidence'; readonly input: EvidenceInput }
    | { readonly kind: 'path'; readonly input: PathInput };

export type WorkerRequest = { readonly id: number; readonly job: WorkerJob };

export type WorkerOutcome =
    | { readonly kind: 'evidence'; readonly evidence: Evidence }
    | { readonly kind: 'path'; readonly path: PathResult };

/** What comes back: the outcome, or the failure, tagged with the request it answers. */
export type WorkerResponse =
    | { readonly id: number; readonly ok: true; readonly outcome: WorkerOutcome }
    | { readonly id: number; readonly ok: false; readonly error: string };

const worker = globalThis as unknown as {
    addEventListener(type: 'message', handler: (event: MessageEvent<WorkerRequest>) => void): void;
    postMessage(message: WorkerResponse): void;
};

const run = (job: WorkerJob): WorkerOutcome =>
    job.kind === 'evidence'
        ? { kind: 'evidence', evidence: evidenceForTake(job.input) }
        : { kind: 'path', path: pathPerformance(job.input) };

worker.addEventListener('message', (event) => {
    const { id, job } = event.data;
    try {
        worker.postMessage({ id, ok: true, outcome: run(job) });
    } catch (error) {
        worker.postMessage({ id, ok: false, error: String(error) });
    }
});
