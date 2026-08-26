/**
 * What the take runner does *around* the evidence.
 *
 * Two of its three decisions are only visible here, because both are about takes that never
 * reach the fit: one the matcher could not localise (a single chord, or nothing it recognised),
 * and one that has been superseded by the next take while its own evidence was still being
 * computed. The evidence itself is `mpm/evidence.test.ts`; below it, everything is a seam.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { Evidence } from '../mpm/evidence';
import { PPQ } from '../shared/constants';
import type { PipelineContext, TakeRunnerControls, TakeSnapshot } from './types';

const runEvidence = vi.fn();

vi.mock('../workers/evidenceClient', () => ({
    runEvidence: (...args: unknown[]) => runEvidence(...args),
}));

const { runTake } = await import('./takeRunner');

const CTX = {
    mei: '<mei/>',
    scoreMsm: '<msm/>',
    scoreNotes: [],
    referenceMpmText: '<reference/>',
    fittedReferenceMpmText: '<fitted/>',
    referenceMpm: { id: 'reference' },
} as unknown as PipelineContext;

const EVIDENCE = {
    studentMpmText: '<student/>',
    structuredDiff: [],
    diffSummary: 'nothing to report',
    measuredTypes: ['tempo'],
    filled: ['tempo'],
    suppressed: [],
    skipped: [],
    disagreements: [],
    levels: { student: { bpm: [], volume: [] } },
    aggregateJnd: 1.2,
    subThresholdFraction: 0.4,
    timings: { fitMs: 10, evidenceMs: 10 },
} as unknown as Evidence;

const makeControls = (over: Partial<TakeRunnerControls> = {}) => {
    const logs: string[] = [];
    const diffs: string[] = [];
    const judgements: unknown[] = [];

    const controls: TakeRunnerControls = {
        log: (msg) => logs.push(msg),
        stop: () => {},
        play: (() => {}) as unknown as TakeRunnerControls['play'],
        playAudioBuffer: async () => {},
        audioContext: {} as AudioContext,
        mode: 'realtime',
        isCancelled: () => false,
        onDiff: (text) => diffs.push(text),
        onJudgement: (value) => judgements.push(value),
        aiAvailable: true,
        ...over,
    };

    return { controls, logs, diffs, judgements };
};

const strategy = vi.fn(async () => {});

beforeEach(() => {
    vi.clearAllMocks();
    runEvidence.mockResolvedValue(EVIDENCE);
});

// ── takes with no window in them ─────────────────────────────────────────────────────────

describe('a take too short to measure', () => {
    // Both shapes come out of the matcher itself: all matched notes on one date collapses the
    // range to a point (`matcher.ts:701`), and a take it recognises nothing in is `{0, 0}`
    // (`matcher.ts:705`). `readScaffold` throws on either.
    it.each([
        ['one chord and a stop', { from: 11520, to: 11520 }],
        ['nothing the matcher recognised', { from: 0, to: 0 }],
    ])('says so and stops, on %s', async (_name, range) => {
        const { controls, logs, diffs, judgements } = makeControls();

        await expect(runTake(CTX, [], range, strategy, controls)).resolves.toBeUndefined();

        expect(logs).toContain('TAKE: too little playing to measure');
        expect(runEvidence).not.toHaveBeenCalled();
        expect(strategy).not.toHaveBeenCalled();
        // Nothing is said to the student and nothing already on screen is cleared.
        expect(diffs).toEqual([]);
        expect(judgements).toEqual([]);
    });

    it('measures a take exactly one quarter note long', async () => {
        const { controls } = makeControls();

        await runTake(CTX, [], { from: 11520, to: 11520 + PPQ }, strategy, controls);

        expect(runEvidence).toHaveBeenCalledTimes(1);
        expect(strategy).toHaveBeenCalledTimes(1);
    });
});

// ── the take that was overtaken ──────────────────────────────────────────────────────────

describe('a take superseded while it was being evidenced', () => {
    it('leaves the current take’s feedback alone', async () => {
        // The callback that runs a take is not awaited (`midi.ts:94`), so take #2 can start
        // while take #1 is still in the worker. Whichever resolves last would otherwise win.
        let cancelled = false;
        const { controls, diffs, judgements } = makeControls({ isCancelled: () => cancelled });
        runEvidence.mockImplementation(async () => {
            cancelled = true;
            return EVIDENCE;
        });

        await runTake(CTX, [], { from: 720, to: 13680 }, strategy, controls);

        expect(runEvidence).toHaveBeenCalledTimes(1);
        expect(diffs).toEqual([]);
        expect(judgements).toEqual([]);
        expect(strategy).not.toHaveBeenCalled();
    });

    it('shows the take’s feedback when it is still the current one', async () => {
        const { controls, diffs, judgements } = makeControls();

        await runTake(CTX, [], { from: 720, to: 13680 }, strategy, controls);

        expect(diffs).toEqual(['nothing to report']);
        expect(judgements).toEqual(['']);
        expect(strategy).toHaveBeenCalledTimes(1);
        // The snapshot the strategy receives is the evidence's own: the student's levels (the
        // counter-performance's fixed point), what was measured, and the diff — no MPM object.
        const [, take] = strategy.mock.calls[0] as unknown as [unknown, TakeSnapshot];
        expect(take.range).toEqual({ from: 720, to: 13680 });
        expect(take.diffSummary).toBe('nothing to report');
        expect(take.measuredTypes).toEqual(['tempo']);
        expect(take.levels).toEqual(EVIDENCE.levels);
    });
});

// ── the evidence itself failing ──────────────────────────────────────────────────────────

describe('a take the fit could not answer for', () => {
    it('loses the take, not the session', async () => {
        const { controls, logs } = makeControls();
        runEvidence.mockRejectedValue(new Error('scaffold: no performance in the reference document'));

        await expect(runTake(CTX, [], { from: 720, to: 13680 }, strategy, controls)).resolves
            .toBeUndefined();

        expect(logs.some((line) => line.startsWith('EVIDENCE error:'))).toBe(true);
        expect(strategy).not.toHaveBeenCalled();
    });
});
