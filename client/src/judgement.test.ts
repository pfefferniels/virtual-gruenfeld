import { describe, expect, it } from 'vitest';
import { fallbackImmediateJudgement, summarizeImmediateJudgement } from './judgement';
import type { StructuredDiffEvent } from './mpm';

describe('summarizeImmediateJudgement', () => {
    it('returns an excellent verdict when there are no diff events', () => {
        const payload = summarizeImmediateJudgement([], { from: 0, to: 2880 });

        expect(payload.verdict).toBe('excellent');
        expect(payload.score).toBe(100);
        expect(payload.dominantTypes).toEqual([]);
    });

    it('weights short difficult passages more critically and surfaces dominant types', () => {
        const events: StructuredDiffEvent[] = [
            {
                id: 'a',
                date: 720,
                position: 'm1.2',
                type: 'dynamics',
                severity: 'large',
                primaryAttr: 'volume',
                magnitude: 24,
                cueText: 'leiser',
                direction: 'less',
                refValue: 60,
                studentValue: 84,
            },
            {
                id: 'b',
                date: 1440,
                position: 'm1.3',
                type: 'dynamics',
                severity: 'mod',
                primaryAttr: 'transition.to',
                magnitude: 12,
                cueText: 'weniger Crescendo',
                direction: 'less',
                refValue: 70,
                studentValue: 82,
            },
            {
                id: 'c',
                date: 2160,
                position: 'm1.4',
                type: 'tempo',
                severity: 'mod',
                primaryAttr: 'bpm',
                magnitude: 18,
                cueText: 'ruhiger',
                direction: 'less',
                refValue: 84,
                studentValue: 102,
            },
        ];

        const payload = summarizeImmediateJudgement(events, { from: 0, to: 2880 });

        expect(['mixed', 'needs_work']).toContain(payload.verdict);
        expect(payload.score).toBeLessThan(74);
        expect(payload.dominantTypes[0].type).toBe('dynamics');
        expect(payload.topIssues[0].type).toBe('dynamics');
    });

    it('carries the comparison’s two numbers when the take has them, rounded to 3 dp', () => {
        // The comparison hands back raw doubles — `8.094988085871684`,
        // `0.00006341968960112274` — and the wire carried every digit. The model is told to read
        // both as magnitudes, so three decimals is all of it that means anything.
        const payload = summarizeImmediateJudgement([], { from: 0, to: 2880 }, {
            distanceJnd: 3.4218,
            subThresholdFraction: 0.91,
        });

        expect(payload.distanceJnd).toBe(3.422);
        expect(payload.subThresholdFraction).toBe(0.91);
        // Additive, and only additive: the score, the verdict and the √(rangeBeats/4)
        // normalisation are what they were (semantics 24).
        expect(payload.score).toBe(100);
        expect(payload.verdict).toBe('excellent');
    });

    it('rounds a long double down to three decimals, and never to −0 or NaN', () => {
        const payload = summarizeImmediateJudgement([], { from: 0, to: 2880 }, {
            distanceJnd: 8.094988085871684,
            subThresholdFraction: 0.00006341968960112274,
        });

        expect(payload.distanceJnd).toBe(8.095);
        expect(payload.subThresholdFraction).toBe(0);
        expect(Object.is(payload.subThresholdFraction, -0)).toBe(false);
        expect(summarizeImmediateJudgement([], { from: 0, to: 2880 }, {
            distanceJnd: Number.NaN,
        }).distanceJnd).toBe(0);
    });

    it('produces the payload it always did when there is no comparison behind the take', () => {
        const withNumbers = summarizeImmediateJudgement([], { from: 0, to: 2880 }, {});
        const without = summarizeImmediateJudgement([], { from: 0, to: 2880 });

        expect(Object.keys(withNumbers)).toEqual(Object.keys(without));
        expect('distanceJnd' in without).toBe(false);
        expect('subThresholdFraction' in without).toBe(false);
    });
});

describe('fallbackImmediateJudgement', () => {
    it('stays encouraging without inventing details', () => {
        const text = fallbackImmediateJudgement({
            score: 76,
            verdict: 'good',
            rangeBeats: 8,
            eventCount: 2,
            dominantTypes: [
                { type: 'dynamics', penalty: 3.5, count: 2, worstSeverity: 'mod' },
            ],
            topIssues: [],
        });

        expect(text).toBe('Schon gut, an der Dynamik noch.');
    });
});
