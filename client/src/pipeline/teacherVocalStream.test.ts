import { describe, it, expect, vi } from 'vitest';
import type { VocalChunk } from './chunker';
import type { ScheduledCue } from './types';

const fetchTeacherStream = vi.fn(async () => ({
    rawText: '', anchors: [], cleanedText: '', audioBase64: '',
    alignment: { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] },
    model: '', plan: null, stats: { llmMs: 0, ttsMs: 0, totalMs: 0 },
})) as unknown as ReturnType<typeof vi.fn> & {
    mock: { calls: [Record<string, unknown> & { measuredTypes?: readonly string[] }][] };
};

vi.mock('../services/api', () => ({
    fetchTeacherStream: (...args: unknown[]) => fetchTeacherStream(...args),
}));
vi.mock('../session', () => ({ getSessionId: () => 'test-session' }));
vi.mock('./chunker', () => ({ chunkVocalStream: async () => [] }));

const { layoutCues, requestVocalStream, scheduleTalkOnly, talkOnlyDurationSec } =
    await import('./teacherVocalStream');

const layout = (items: { ideal: number; duration: number; gapAfter?: number }[]) =>
    layoutCues(items.map((i) => ({ ...i, gapAfter: i.gapAfter ?? 0.25 })));

describe('layoutCues (PAVA)', () => {
    it('returns empty for no items', () => {
        expect(layoutCues([])).toEqual([]);
    });

    it('returns ideal position for a single item', () => {
        expect(layout([{ ideal: 3.0, duration: 1.0 }])).toEqual([3.0]);
    });

    it('preserves ideal positions when no overlap', () => {
        const result = layout([
            { ideal: 1.0, duration: 1.0 },
            { ideal: 5.0, duration: 1.0 },
        ]);
        expect(result[0]).toBeCloseTo(1.0);
        expect(result[1]).toBeCloseTo(5.0);
    });

    it('resolves overlap by distributing drift evenly', () => {
        // Two cues want the same spot, each 2s long
        const result = layout([
            { ideal: 3.0, duration: 2.0 },
            { ideal: 3.5, duration: 1.0 },
        ]);
        // Should not overlap: result[0] + 2.0 + 0.25 <= result[1]
        expect(result[0] + 2.0 + 0.25).toBeLessThanOrEqual(result[1] + 1e-9);
        // Drift should be distributed (not all on the second cue)
        const drift0 = Math.abs(result[0] - 3.0);
        const drift1 = Math.abs(result[1] - 3.5);
        expect(drift0).toBeGreaterThan(0);
        expect(drift1).toBeGreaterThan(0);
    });

    it('allows anticipation (cue placed before its ideal)', () => {
        // First cue is long and second cue is close — first cue must shift earlier
        const result = layout([
            { ideal: 5.0, duration: 3.0 },
            { ideal: 5.5, duration: 1.0 },
        ]);
        expect(result[0]).toBeLessThan(5.0);
    });

    it('respects per-item gapAfter', () => {
        const result = layoutCues([
            { ideal: 1.0, duration: 1.0, gapAfter: 2.0 },
            { ideal: 2.0, duration: 1.0, gapAfter: 0 },
        ]);
        // Must satisfy: result[0] + 1.0 + 2.0 <= result[1]
        expect(result[0] + 1.0 + 2.0).toBeLessThanOrEqual(result[1] + 1e-9);
    });

    it('handles three overlapping cues', () => {
        const result = layout([
            { ideal: 1.0, duration: 2.0 },
            { ideal: 2.0, duration: 2.0 },
            { ideal: 3.0, duration: 2.0 },
        ]);
        // No overlaps
        for (let i = 0; i < result.length - 1; i++) {
            expect(result[i] + 2.0 + 0.25).toBeLessThanOrEqual(result[i + 1] + 1e-9);
        }
        // First cue should anticipate (shift earlier)
        expect(result[0]).toBeLessThan(1.0);
    });

    it('only adjusts overlapping group, leaves others at ideal', () => {
        const result = layout([
            { ideal: 0.0, duration: 1.0 },
            // Big gap
            { ideal: 10.0, duration: 2.0 },
            { ideal: 10.5, duration: 1.0 },
            // Big gap
            { ideal: 20.0, duration: 1.0 },
        ]);
        // First and last should be at ideal
        expect(result[0]).toBeCloseTo(0.0);
        expect(result[3]).toBeCloseTo(20.0);
        // Middle pair: no overlap
        expect(result[1] + 2.0 + 0.25).toBeLessThanOrEqual(result[2] + 1e-9);
    });

    it('minimizes squared drift (L2 optimal)', () => {
        // Verify PAVA produces a better L2 solution than naive push-right
        const items = [
            { ideal: 3.0, duration: 2.0, gapAfter: 0.25 },
            { ideal: 3.5, duration: 1.0, gapAfter: 0.25 },
        ];
        const pavaResult = layoutCues(items);

        // Naive push-right: first at ideal, second pushed
        const naiveResult = [3.0, 3.0 + 2.0 + 0.25];

        const pavaL2 = pavaResult.reduce((sum, pos, i) => sum + (pos - items[i].ideal) ** 2, 0);
        const naiveL2 = naiveResult.reduce((sum, pos, i) => sum + (pos - items[i].ideal) ** 2, 0);

        expect(pavaL2).toBeLessThan(naiveL2);
    });
});

describe('talk-only scheduling (demo mode "none")', () => {
    const chunk = (marker: string, duration: number): VocalChunk => ({
        marker,
        text: `${marker} text`,
        startSec: 0,
        endSec: duration,
        audioBuffer: { duration } as AudioBuffer,
    });

    const schedule = (chunks: VocalChunk[]) => {
        const cues: ScheduledCue[] = [];
        scheduleTalkOnly(chunks, (cue) => cues.push(cue), () => {});
        return cues;
    };

    it('plays the segments back to back, in the order the teacher said them', () => {
        const cues = schedule([chunk('JUDGE', 2), chunk('m3.1', 1), chunk('m4.2', 0.5)]);
        expect(cues.map((cue) => cue.atSec)).toEqual([0, 2.25, 3.5]);
    });

    it('keeps the positional markers instead of dropping them with their anchor', () => {
        const cues = schedule([chunk('JUDGE', 1), chunk('m3.1', 1)]);
        expect(cues).toHaveLength(2);
    });

    it('reports how long the teacher will be talking, so the chord can hold', () => {
        expect(talkOnlyDurationSec([chunk('JUDGE', 2), chunk('m3.1', 1)])).toBeCloseTo(3.5, 9);
        expect(talkOnlyDurationSec([])).toBe(0);
    });

    it('schedules nothing when there is nothing to say', () => {
        expect(schedule([])).toEqual([]);
    });
});

// ── The POST body ──
//
// `measuredTypes` was the one line of S7's contract addition that no test touched, and it was
// the one that was wrong: it used to be spread in conditionally, so the field vanished from the
// wire *exactly* when the take measured nothing — the case it exists to describe. The server
// then falls back to the events' own types, and a take that measured nothing has no events, so
// the plan gate opens on all seven instead of closing on all seven (final-contracts, finding 1).

describe('requestVocalStream — what reaches the server', () => {
    const JUDGEMENT = {
        score: 61,
        verdict: 'mixed' as const,
        rangeBeats: 18,
        eventCount: 0,
        dominantTypes: [],
        topIssues: [],
    };

    const RANGE = { from: 720, to: 13680 };

    const call = async (measuredTypes?: readonly string[]) => {
        fetchTeacherStream.mockClear();
        await requestVocalStream(
            JUDGEMENT,
            'no deviations',
            [],
            RANGE,
            undefined,
            'balanced',
            {} as AudioContext,
            () => {},
            false,
            ...(measuredTypes === undefined ? [] : [measuredTypes] as const),
        );
        return fetchTeacherStream.mock.calls[0][0];
    };

    it('sends measuredTypes when the take measured something', async () => {
        const body = await call(['tempo', 'ornament']);
        expect(body.measuredTypes).toEqual(['tempo', 'ornament']);
    });

    it('sends measuredTypes as an empty array when the take measured nothing', async () => {
        const body = await call([]);
        expect('measuredTypes' in body).toBe(true);
        expect(body.measuredTypes).toEqual([]);
    });

    it('sends the key even when the caller omits the argument', async () => {
        const body = await call();
        expect('measuredTypes' in body).toBe(true);
        expect(body.measuredTypes).toEqual([]);
    });
});
