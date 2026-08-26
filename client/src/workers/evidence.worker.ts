/**
 * The evidence, off the main thread.
 *
 * Deliberately the thinnest thing that can be called a module: receive an {@link EvidenceInput},
 * call {@link evidenceForTake}, post the result back. Every decision, every number and every
 * test lives in `mpm/evidence.ts` and below it — a worker cannot be unit-tested without a
 * harness that proves nothing about the fitting, and logic that only runs here would be logic
 * nothing checks.
 *
 * The take is ~90 ms of parsing, rendering and integrating (S4 §7). On the main thread that is
 * 90 ms in which the page cannot repaint, right after the student lifts their hands; here it is
 * 90 ms in which the page is idle and the piano can still ring.
 *
 * `globalThis` is narrowed by hand rather than by `/// <reference lib="webworker" />`: the
 * client's `tsconfig` compiles this file in the same program as the React app, and pulling the
 * worker lib in would redeclare half of `DOM`.
 */
import { evidenceForTake, type Evidence, type EvidenceInput } from '../mpm/evidence';

/** What comes back: the evidence, or the failure, tagged with the request it answers. */
export type EvidenceRequest = { readonly id: number; readonly input: EvidenceInput };
export type EvidenceResponse =
    | { readonly id: number; readonly ok: true; readonly evidence: Evidence }
    | { readonly id: number; readonly ok: false; readonly error: string };

const worker = globalThis as unknown as {
    addEventListener(type: 'message', handler: (event: MessageEvent<EvidenceRequest>) => void): void;
    postMessage(message: EvidenceResponse): void;
};

worker.addEventListener('message', (event) => {
    const { id, input } = event.data;
    try {
        worker.postMessage({ id, ok: true, evidence: evidenceForTake(input) });
    } catch (error) {
        worker.postMessage({ id, ok: false, error: String(error) });
    }
});
