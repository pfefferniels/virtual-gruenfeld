import { describe, it, expect } from 'vitest';
import { layoutCues } from './teacherVocalStream';

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
