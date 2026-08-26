import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImmediateJudgementPayload } from '../../judgement';
import type { LessonPlan } from '../../lessonPlan';
import type { PipelineContext, ScheduledCue, StrategyControls, TakeSnapshot } from '../types';
import type { VocalChunk } from '../chunker';

// ── Seams ──
// Everything below the strategy is faked: the Java renderer, the teacher service,
// the MIDI assembly. What is under test is only which of them gets called, with
// which range, and in which order.

const exaggerate = vi.fn();
const performTeacherPlayback = vi.fn();
const requestVocalStream = vi.fn();
const scheduleVocalStream = vi.fn();
const buildJudgementMoodRenderPlan = vi.fn();
const isAgenticTeacher = vi.fn(() => false);

vi.mock('../../mpm', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../mpm')>()),
    exaggerate: (...args: unknown[]) => exaggerate(...args),
}));
vi.mock('../../api', () => ({
    performTeacherPlayback: (...args: unknown[]) => performTeacherPlayback(...args),
}));
vi.mock('../../featureFlags', () => ({
    isAgenticTeacher: () => isAgenticTeacher(),
}));
vi.mock('../judgementMood', () => ({
    buildJudgementMoodRenderPlan: (...args: unknown[]) => buildJudgementMoodRenderPlan(...args),
}));
vi.mock('../teacherVocalStream', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../teacherVocalStream')>()),
    requestVocalStream: (...args: unknown[]) => requestVocalStream(...args),
    scheduleVocalStream: (...args: unknown[]) => scheduleVocalStream(...args),
}));
vi.mock('../../pianosound/midiSequence', () => ({
    appendSustainTail: (midi: unknown) => midi,
    prepareMoodChordMidi: (midi: unknown) => midi,
    appendMidiWithOffset: (a: { id: string }, b: { id: string }) => ({ id: `${a.id}+${b.id}` }),
    delayMidi: (midi: { id: string }) => ({ id: `delayed(${midi.id})` }),
    millisecondsToMidiTicks: () => 0,
}));

const { exaggeratedStrategy } = await import('./exaggerated');
const { allDimensions } = await import('../../mpm');

// ── Fixtures ──

const TAKE_RANGE = { from: 720, to: 13680 };
const PLAN_RANGE = { from: 2880, to: 8640 };

const JUDGEMENT = {
    score: 61,
    verdict: 'mixed',
    rangeBeats: 18,
    eventCount: 4,
    dominantTypes: [{ type: 'tempo', penalty: 8, count: 2, worstSeverity: 'large' }],
    topIssues: [],
} as unknown as ImmediateJudgementPayload;

const chunk = (marker: string, duration: number): VocalChunk => ({
    marker,
    text: `${marker} text`,
    startSec: 0,
    endSec: duration,
    audioBuffer: { duration } as AudioBuffer,
});

const CHUNKS = [chunk('JUDGE', 2), chunk('m3.1', 1)];

const REFERENCE_MPM = { id: 'reference' };
const EXAGGERATED_MPM = { id: 'exaggerated-clone' };

const makeCtx = (withReduction: boolean): PipelineContext => ({
    mei: '<mei/>',
    scoreMsm: '<msm/>',
    scoreNotes: [],
    referenceMpmText: '<mpm/>',
    fittedReferenceMpmText: '<mpm/>',
    referenceMpm: REFERENCE_MPM,
    ...(withReduction ? { reductionMei: '<reduction/>', reductionNotes: [] } : {}),
} as unknown as PipelineContext);

const TAKE = {
    studentMpm: { id: 'student' },
    referenceMpmClone: EXAGGERATED_MPM,
    diffSummary: '4 deviations',
    structuredDiff: [],
    judgementSummary: JUDGEMENT,
    range: TAKE_RANGE,
} as unknown as TakeSnapshot;

type Played = { midi: { id: string }; cues: ScheduledCue[] };

const makeControls = () => {
    const played: Played[] = [];
    const spokenDirectly: string[] = [];
    const logs: string[] = [];

    const controls: StrategyControls = {
        log: (msg) => logs.push(msg),
        isCancelled: () => false,
        play: ((
            midi: unknown,
            _cb: undefined,
            setup: (api: { scheduleAudioCue: (cue: ScheduledCue) => void }) => void,
        ) => {
            const cues: ScheduledCue[] = [];
            setup({ scheduleAudioCue: (cue: ScheduledCue) => cues.push(cue) });
            played.push({ midi: midi as { id: string }, cues });
        }) as unknown as StrategyControls['play'],
        playAudioBuffer: async (buffer) => { spokenDirectly.push(String(buffer.duration)); },
        audioContext: {} as AudioContext,
        mode: 'realtime',
        takeStartedAt: Date.now(),
        onJudgement: () => {},
        aiAvailable: true,
    };

    return { controls, played, spokenDirectly, logs };
};

const renderedAs = (id: string) => ({ midi: { id }, timingMap: [] });

/** What the strategy asked the renderer to perform, ignoring the mood chord. */
const demoCall = () => performTeacherPlayback.mock.calls.find((call) => call[0] === '<mei/>');

beforeEach(() => {
    performTeacherPlayback.mockImplementation((mei: string) =>
        renderedAs(mei === '<mei/>' ? 'demo' : 'mood'));
    requestVocalStream.mockResolvedValue({ chunks: CHUNKS, plan: null });
    buildJudgementMoodRenderPlan.mockReturnValue(null);
    isAgenticTeacher.mockReturnValue(false);
});

afterEach(() => {
    vi.clearAllMocks();
});

// ── The legacy path ──

describe('fixed pedagogy (flag off)', () => {
    it('exaggerates the whole take across every dimension before asking the teacher', async () => {
        const { controls } = makeControls();
        await exaggeratedStrategy(makeCtx(false), TAKE, controls);

        expect(exaggerate).toHaveBeenCalledTimes(1);
        const [ref, student, range, dimensions] = exaggerate.mock.calls[0];
        expect(ref).toBe(EXAGGERATED_MPM);
        expect(student).toBe(TAKE.studentMpm);
        expect(range).toBe(TAKE_RANGE);
        expect(dimensions).toEqual(allDimensions());

        // The demo is shaped before the model is asked, so the render overlaps the call.
        expect(exaggerate.mock.invocationCallOrder[0])
            .toBeLessThan(requestVocalStream.mock.invocationCallOrder[0]);
    });

    it('does not ask the server for a plan', async () => {
        const { controls } = makeControls();
        await exaggeratedStrategy(makeCtx(false), TAKE, controls);

        expect(requestVocalStream.mock.calls[0][8]).toBe(false);
    });

    it('performs the exaggerated clone over the take range and schedules positional cues', async () => {
        const { controls, played } = makeControls();
        await exaggeratedStrategy(makeCtx(false), TAKE, controls);

        expect(demoCall()?.slice(2)).toEqual([EXAGGERATED_MPM, TAKE_RANGE]);
        expect(played).toHaveLength(1);
        expect(played[0].midi.id).toBe('delayed(demo)');
        expect(scheduleVocalStream).toHaveBeenCalledTimes(1);
    });
});

// ── The three agentic demos ──

describe('agentic pedagogy (flag on)', () => {
    const plan = (overrides: Partial<LessonPlan> = {}): LessonPlan => ({
        mode: 'exaggerated',
        range: null,
        dimensions: [],
        ...overrides,
    });

    const withPlan = (lessonPlan: LessonPlan | null, chunks: VocalChunk[] = CHUNKS) => {
        isAgenticTeacher.mockReturnValue(true);
        requestVocalStream.mockResolvedValue({ chunks, plan: lessonPlan });
    };

    it('asks the server for a plan and waits for it before shaping anything', async () => {
        withPlan(plan({ range: PLAN_RANGE, dimensions: [{ type: 'tempo', strength: 0.35 }] }));
        const { controls } = makeControls();
        await exaggeratedStrategy(makeCtx(false), TAKE, controls);

        expect(requestVocalStream.mock.calls[0][8]).toBe(true);
        expect(exaggerate.mock.invocationCallOrder[0])
            .toBeGreaterThan(requestVocalStream.mock.invocationCallOrder[0]);
    });

    describe('mode: exaggerated', () => {
        it('shapes only the planned dimensions, over the planned passage', async () => {
            withPlan(plan({ range: PLAN_RANGE, dimensions: [{ type: 'tempo', strength: 0.35 }] }));
            const { controls } = makeControls();
            await exaggeratedStrategy(makeCtx(false), TAKE, controls);

            expect(exaggerate).toHaveBeenCalledTimes(1);
            const [, , range, dimensions] = exaggerate.mock.calls[0];
            expect(range).toBe(PLAN_RANGE);
            expect(dimensions).toEqual([{ type: 'tempo', strength: 0.35 }]);
            expect(demoCall()?.slice(2)).toEqual([EXAGGERATED_MPM, PLAN_RANGE]);
        });

        it('falls back to every dimension when the plan named none', async () => {
            withPlan(plan());
            const { controls } = makeControls();
            await exaggeratedStrategy(makeCtx(false), TAKE, controls);

            expect(exaggerate.mock.calls[0][3]).toEqual(allDimensions());
            expect(exaggerate.mock.calls[0][2]).toBe(TAKE_RANGE);
        });

        it('demonstrates as before when the server sent no plan at all', async () => {
            withPlan(null);
            const { controls, played, logs } = makeControls();
            await exaggeratedStrategy(makeCtx(false), TAKE, controls);

            expect(exaggerate.mock.calls[0][3]).toEqual(allDimensions());
            expect(played[0].midi.id).toBe('delayed(demo)');
            expect(logs.some((line) => line.includes('PLAN: none returned'))).toBe(true);
        });
    });

    describe('mode: reference', () => {
        it('performs Grünfeld untouched over the planned passage', async () => {
            withPlan(plan({ mode: 'reference', range: PLAN_RANGE }));
            const { controls, played } = makeControls();
            await exaggeratedStrategy(makeCtx(false), TAKE, controls);

            expect(exaggerate).not.toHaveBeenCalled();
            expect(demoCall()?.slice(2)).toEqual([REFERENCE_MPM, PLAN_RANGE]);
            expect(played[0].midi.id).toBe('delayed(demo)');
        });

        it('still schedules the positional cues against the reference timing', async () => {
            withPlan(plan({ mode: 'reference', range: PLAN_RANGE }));
            const { controls } = makeControls();
            await exaggeratedStrategy(makeCtx(false), TAKE, controls);

            expect(scheduleVocalStream).toHaveBeenCalledTimes(1);
            expect(scheduleVocalStream.mock.calls[0][0]).toBe(CHUNKS);
        });
    });

    describe('mode: none', () => {
        it('renders no demonstration at all', async () => {
            withPlan(plan({ mode: 'none' }));
            const { controls } = makeControls();
            await exaggeratedStrategy(makeCtx(false), TAKE, controls);

            expect(exaggerate).not.toHaveBeenCalled();
            expect(demoCall()).toBeUndefined();
            expect(scheduleVocalStream).not.toHaveBeenCalled();
        });

        it('speaks the monologue over the mood chord when there is one', async () => {
            withPlan(plan({ mode: 'none' }));
            buildJudgementMoodRenderPlan.mockReturnValue({
                mpm: { id: 'mood-mpm' }, range: TAKE_RANGE, chordDate: 720, noteCount: 4,
                renderFrom: 720, renderTo: 1440,
            });
            const { controls, played } = makeControls();
            await exaggeratedStrategy(makeCtx(true), TAKE, controls);

            expect(played).toHaveLength(1);
            expect(played[0].midi.id).toBe('mood');
            // Every segment is spoken, in order, without overlapping.
            expect(played[0].cues.map((cue) => cue.atSec)).toEqual([0, 2.25]);
        });

        it('holds the chord for the whole monologue, not just the judgement', async () => {
            withPlan(plan({ mode: 'none' }));
            buildJudgementMoodRenderPlan.mockReturnValue({
                mpm: { id: 'mood-mpm' }, range: TAKE_RANGE, chordDate: 720, noteCount: 4,
                renderFrom: 720, renderTo: 1440,
            });
            const { controls } = makeControls();
            await exaggeratedStrategy(makeCtx(true), TAKE, controls);

            // 2s JUDGE + 0.25 gap + 1s cue + 0.25 gap = 3.5s, not the 2s JUDGE alone.
            expect(buildJudgementMoodRenderPlan.mock.calls[0][4]).toEqual({ minimumPedalHoldMs: 3500 });
        });

        it('speaks unaccompanied when there is no harmonic reduction to lean on', async () => {
            withPlan(plan({ mode: 'none' }));
            const { controls, played, spokenDirectly } = makeControls();
            await exaggeratedStrategy(makeCtx(false), TAKE, controls);

            expect(played).toHaveLength(0);
            expect(spokenDirectly).toEqual(['2', '1']);
        });

        it('does nothing rather than crash when the teacher said nothing either', async () => {
            withPlan(plan({ mode: 'none' }), []);
            const { controls, played, spokenDirectly, logs } = makeControls();
            await exaggeratedStrategy(makeCtx(false), TAKE, controls);

            expect(played).toHaveLength(0);
            expect(spokenDirectly).toEqual([]);
            expect(logs.some((line) => line.includes('nothing to say and nothing to play'))).toBe(true);
        });
    });

    it('anchors the mood chord on the planned passage, not the whole take', async () => {
        withPlan(plan({ range: PLAN_RANGE }));
        buildJudgementMoodRenderPlan.mockReturnValue({
            mpm: { id: 'mood-mpm' }, range: PLAN_RANGE, chordDate: 2880, noteCount: 3,
            renderFrom: 2880, renderTo: 3600,
        });
        const { controls, played } = makeControls();
        await exaggeratedStrategy(makeCtx(true), TAKE, controls);

        expect(buildJudgementMoodRenderPlan.mock.calls[0][3]).toBe(PLAN_RANGE.from);
        expect(played[0].midi.id).toBe('mood+demo');
    });
});
