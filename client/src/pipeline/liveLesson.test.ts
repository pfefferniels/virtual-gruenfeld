/**
 * The loop with everything around it faked: a scripted tracker, scripted evidence, a decision
 * that answers immediately, and a piano that records what it was asked to play. What is under
 * test is the choreography — when a window is scored, when a verdict is asked for, when he plays.
 */
import { describe, expect, it, vi } from 'vitest';
import type { StudentNote } from '../matcher';
import type { Position, Tracker } from '../tracker';
import { LIVE_POLICY } from './standingVerdict';
import {
    createLiveLesson,
    tickToBar,
    type Decision,
    type DeliberationRequest,
    type Heard,
    type LiveLesson,
    type LiveLessonDeps,
    type WindowEvidence,
    type WindowPolicy,
} from './liveLesson';

type Plan = { mode: string };

const BAR = 2880;

const at = (tick: number, confidence = 1): Position => ({ tick, section: 'A1', pass: 1, confidence });

/** One note, placed so `nowMs` can be made to sit any distance after it. */
const played = (onsetSec: number): StudentNote[] => [
    { id: 'n', pitch: 60, onset: onsetSec, duration: 0.5, velocity: 64 },
];

const evidence = (types: readonly string[]): WindowEvidence => ({
    measuredTypes: types,
    structuredDiff: types.map((type) => ({ type, position: 'm5.2', severity: 'large' })),
});

const harness = (over: Partial<LiveLessonDeps<Plan>> = {}) => {
    const positions: (Position | null)[] = [];
    const tracker: Tracker = {
        advance: () => positions.shift() ?? null,
        reset: () => undefined,
    };
    const requests: DeliberationRequest[] = [];
    const playedFragments: { plan: Plan; fragment: { from: number; to: number } }[] = [];

    const deps: LiveLessonDeps<Plan> = {
        tracker,
        score: async () => evidence(['tempo']),
        deliberate: async (request) => {
            requests.push(request);
            return {
                verdict: { interrupt: 0.6, dimension: 'tempo', severity: 2.8, exaggeration: 1.4 },
                plan: { mode: 'exaggerated' },
            } satisfies Decision<Plan>;
        },
        play: (plan, fragment) => { playedFragments.push({ plan, fragment }); },
        ...over,
    };

    return { deps, positions, requests, playedFragments };
};

/** Hands off the keys for longer than the policy requires, so only the verdict is under test. */
const quiet = (onsetSec: number) => onsetSec * 1000 + LIVE_POLICY.silenceMs + 1;

describe('tracking', () => {
    it('says nothing while it has not found the student', async () => {
        const { deps, positions } = harness();
        positions.push(null);
        const lesson = createLiveLesson(deps);
        const heard: Heard = await lesson.heard(played(0), 0);
        expect(heard).toEqual({ position: null, asked: false, played: null });
    });

    it('will not ask about a window it is not confident it has located', async () => {
        const { deps, positions, requests } = harness();
        positions.push(at(6 * BAR, 0.2));
        const lesson = createLiveLesson(deps);
        await lesson.heard(played(0), quiet(0));
        expect(requests).toHaveLength(0);
    });
});

describe('when a window is scored', () => {
    it('waits for a bar to settle before judging it', async () => {
        const { deps, positions, requests } = harness();
        // One bar played, but the settle margin puts the window's end back before bar 1 closes.
        positions.push(at(BAR));
        const lesson = createLiveLesson(deps);
        await lesson.heard(played(0), quiet(0));
        expect(requests).toHaveLength(0);
    });

    it('asks over the bars behind the playhead, once a dimension has persisted', async () => {
        const { deps, positions, requests } = harness();
        positions.push(at(4 * BAR), at(6 * BAR));
        const lesson = createLiveLesson(deps);
        await lesson.heard(played(0), quiet(0));
        await lesson.heard(played(0), quiet(0) + 100);

        expect(requests).toHaveLength(1);
        expect(requests[0].window.to).toBeLessThan(6 * BAR);
        expect(requests[0].window.to - requests[0].window.from).toBe(2 * BAR);
    });

    it('scores a window once, however often it is asked', async () => {
        const score = vi.fn(async () => evidence(['tempo']));
        const { deps, positions } = harness({ score });
        // The playhead creeps forward but stays inside the same settled window.
        positions.push(at(4 * BAR), at(4 * BAR + 200), at(4 * BAR + 400));
        const lesson = createLiveLesson(deps);
        await lesson.heard(played(0), quiet(0));
        await lesson.heard(played(0), quiet(0) + 100);
        await lesson.heard(played(0), quiet(0) + 200);
        expect(score).toHaveBeenCalledTimes(1);
    });

    it('holds a dimension back until it has survived consecutive windows', async () => {
        const { deps, positions, requests } = harness({
            score: vi.fn()
                .mockResolvedValueOnce(evidence(['tempo']))
                .mockResolvedValueOnce(evidence(['dynamics']))
                .mockResolvedValue(evidence(['dynamics'])),
        });
        positions.push(at(4 * BAR), at(6 * BAR), at(8 * BAR));
        const lesson = createLiveLesson(deps);
        await lesson.heard(played(0), quiet(0));
        expect(requests).toHaveLength(0);

        await lesson.heard(played(0), quiet(0) + 100);
        expect(requests).toHaveLength(0);

        await lesson.heard(played(0), quiet(0) + 200);
        expect(requests).toHaveLength(1);
        expect(requests[0].measuredTypes).toEqual(['dynamics']);
    });

    it('says nothing when the fit could not answer for the window', async () => {
        const { deps, positions, requests } = harness({ score: async () => null });
        positions.push(at(4 * BAR));
        const lesson = createLiveLesson(deps);
        const heard = await lesson.heard(played(0), quiet(0));
        expect(requests).toHaveLength(0);
        expect(heard.played).toBeNull();
    });
});

describe('taking the keyboard', () => {
    /** Two windows, because a dimension must persist before anything is asked at all. */
    const twice = async (lesson: LiveLesson, nowMs: number) => {
        await lesson.heard(played(0), nowMs);
        return lesson.heard(played(0), nowMs + 100);
    };

    it('plays a fragment of one bar, not the window it judged', async () => {
        const { deps, positions, playedFragments } = harness();
        positions.push(at(4 * BAR), at(6 * BAR));
        const lesson = createLiveLesson(deps);
        await twice(lesson, quiet(0));

        expect(playedFragments).toHaveLength(1);
        const { fragment } = playedFragments[0];
        expect(fragment.to - fragment.from).toBe(BAR);
    });

    it('waits for the hands to leave the keys', async () => {
        const { deps, positions, playedFragments } = harness();
        positions.push(at(4 * BAR), at(6 * BAR));
        const lesson = createLiveLesson(deps);
        // Still playing: the note is 200 ms ago, well inside the silence the policy waits for.
        await lesson.heard(played(0), 200);
        await lesson.heard(played(0), 300);
        expect(playedFragments).toHaveLength(0);
    });

    it('stays silent when Jev declines', async () => {
        const { deps, positions, playedFragments } = harness({
            deliberate: async () => ({
                verdict: { interrupt: 0.2, dimension: 'tempo', severity: 1.1, exaggeration: 0.4 },
                plan: { mode: 'exaggerated' },
            }),
        });
        positions.push(at(4 * BAR), at(6 * BAR));
        const lesson = createLiveLesson(deps);
        await twice(lesson, quiet(0));
        expect(playedFragments).toHaveLength(0);
    });

    it('goes on in silence when no verdict came back at all', async () => {
        const { deps, positions, playedFragments } = harness({
            deliberate: async () => ({ verdict: null, plan: null }),
        });
        positions.push(at(4 * BAR), at(6 * BAR));
        const lesson = createLiveLesson(deps);
        await twice(lesson, quiet(0));
        expect(playedFragments).toHaveLength(0);
    });

    it('remembers the point it made, so the next window knows', async () => {
        const { deps, positions, requests } = harness();
        positions.push(at(4 * BAR), at(6 * BAR), at(20 * BAR), at(22 * BAR));
        const lesson = createLiveLesson(deps);
        await twice(lesson, quiet(0));
        expect(lesson.corrections()).toEqual([{ bar: 5, dimension: 'tempo', times: 1 }]);

        const later = quiet(0) + LIVE_POLICY.refractoryMs + 1000;
        await lesson.heard(played(0), later);
        await lesson.heard(played(0), later + 100);
        // Every later deliberation is told what he has already said, which is what stops him
        // saying it again.
        expect(requests[requests.length - 1].alreadyCorrectedThisLesson)
            .toContainEqual({ bar: 5, dimension: 'tempo', times: 1 });
    });
});

describe('the window policy', () => {
    it('can be widened, which moves when a verdict becomes possible', async () => {
        const wide: Partial<WindowPolicy> = { windowBars: 4 };
        const { deps, positions, requests } = harness();
        positions.push(at(8 * BAR), at(10 * BAR));
        const lesson = createLiveLesson(deps, { window: wide });
        await lesson.heard(played(0), quiet(0));
        await lesson.heard(played(0), quiet(0) + 100);
        expect(requests[0].window.to - requests[0].window.from).toBe(4 * BAR);
    });
});

describe('tickToBar', () => {
    it('counts bars from one', () => {
        expect(tickToBar(0)).toBe(1);
        expect(tickToBar(BAR)).toBe(2);
        expect(tickToBar(BAR * 4 + 10)).toBe(5);
    });
});
