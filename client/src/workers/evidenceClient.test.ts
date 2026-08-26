/**
 * The shell, not the worker.
 *
 * `runEvidence` has exactly one decision in it — worker or main thread — and the branch that
 * matters most is the one no browser normally takes: a page that cannot spawn a module worker
 * must still give the student their feedback. Vitest is such a page (no `Worker` in the Node
 * environment), which makes this the natural place to assert it.
 *
 * The worker itself is never run here, by design: it has no logic to test. What it calls,
 * `mpm/evidence.ts`, is tested directly.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Evidence, EvidenceInput } from '../mpm/evidence';

const evidenceForTake = vi.fn(
    (input: EvidenceInput): Evidence => ({ studentMpmText: `fitted:${input.range.from}` } as Evidence),
);

vi.mock('../mpm/evidence', () => ({
    evidenceForTake: (input: EvidenceInput) => evidenceForTake(input),
}));

const { forgetEvidenceWorker, runEvidence } = await import('./evidenceClient');

const INPUT: EvidenceInput = {
    notes: [],
    range: { from: 720, to: 1440 },
    scoreMsm: '<msm/>',
    referenceMpmText: '<mpm/>',
    fittedReferenceMpmText: '<mpm/>',
};

describe('runEvidence', () => {
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
});
