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
