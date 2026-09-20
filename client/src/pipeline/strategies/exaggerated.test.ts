import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PipelineContext, StrategyControls, TakeSnapshot } from '../types';

// ── Seams ──
// Everything below the strategy is faked: the counter-performance, the renderer, the MIDI
// assembly. What is under test is only which of them gets called, with which range, and with
// which document.

const counterPerformance = vi.fn();
const perform = vi.fn();

vi.mock('../../mpm', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../mpm')>()),
    counterPerformance: (...args: unknown[]) => counterPerformance(...args),
}));
vi.mock('../../services/mpmRenderer', () => ({
    perform: (...args: unknown[]) => perform(...args),
}));
vi.mock('../../pianosound/midiSequence', () => ({
    appendSustainTail: (midi: { id: string }) => ({ id: `sustained(${midi.id})` }),
}));

const { exaggeratedStrategy } = await import('./exaggerated');
const { allDimensions } = await import('../../mpm');

// ── Fixtures ──

const TAKE_RANGE = { from: 720, to: 13680 };

/** `ctx.referenceMpmText` — the editorial document the splice is copied from. */
const REFERENCE_MPM = '<mpm id="reference"/>';
/** What the mocked `counterPerformance` hands back. */
const COUNTER_MPM = '<mpm id="counter"/>';

const CTX = {
    mei: '<mei/>',
    scoreMsm: '<msm/>',
    scoreNotes: [],
    referenceMpmText: REFERENCE_MPM,
} as unknown as PipelineContext;

/** What the counter-performance pushes Grünfeld away from: one paired slot, per attribute. */
const PEAKS = [{
    date: 1440,
    type: 'tempo',
    diffs: { bpm: { ref: 60, student: 72, delta: 12 } },
    magnitude: 12,
}];

const TAKE = {
    peaks: PEAKS,
    measuredTypes: ['tempo', 'dynamics'],
    range: TAKE_RANGE,
} as unknown as TakeSnapshot;

const makeControls = (isCancelled = () => false) => {
    const played: Array<{ id: string }> = [];
    const logs: string[] = [];

    const controls: StrategyControls = {
        log: (msg) => logs.push(msg),
        isCancelled,
        play: ((midi: { id: string }) => { played.push(midi); }) as unknown as StrategyControls['play'],
        takeStartedAt: Date.now(),
    };

    return { controls, played, logs };
};

beforeEach(() => {
    counterPerformance.mockReturnValue(COUNTER_MPM);
    perform.mockReturnValue({ id: 'demo' });
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('the exaggerated demonstration', () => {
    it('exaggerates the whole take across every dimension', async () => {
        const { controls } = makeControls();
        await exaggeratedStrategy(CTX, TAKE, controls);

        expect(counterPerformance).toHaveBeenCalledTimes(1);
        const [call] = counterPerformance.mock.calls[0];
        expect(call.referenceMpmText).toBe(REFERENCE_MPM);
        expect(call.range).toBe(TAKE_RANGE);
        expect(call.dimensions).toEqual(allDimensions());
        // The pivot is this student's own deviation, slot by slot, and the gate is what the
        // take measured.
        expect(call.peaks).toBe(TAKE.peaks);
        expect(call.measured).toBe(TAKE.measuredTypes);
    });

    it('performs the splice over the take range and plays it with a sustain tail', async () => {
        const { controls, played } = makeControls();
        await exaggeratedStrategy(CTX, TAKE, controls);

        expect(perform).toHaveBeenCalledWith('<mei/>', COUNTER_MPM, TAKE_RANGE);
        expect(played).toEqual([{ id: 'sustained(demo)' }]);
    });

    it('plays nothing when the render produced nothing', async () => {
        perform.mockReturnValue(undefined);
        const { controls, played } = makeControls();
        await exaggeratedStrategy(CTX, TAKE, controls);

        expect(played).toEqual([]);
    });

    it('plays nothing once the take has been superseded', async () => {
        const { controls, played } = makeControls(() => true);
        await exaggeratedStrategy(CTX, TAKE, controls);

        expect(played).toEqual([]);
    });
});
