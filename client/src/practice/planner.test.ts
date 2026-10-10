import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DIMENSIONS, END, interestOf, makePlan, rangeLabel, type Pass } from './planner';

const load = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const interest = interestOf(load('../../public/performance.mpm'));
const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);
const planned = new Map<number, Pass[]>();
const passesOf = (seed: number): Pass[] => {
    if (!planned.has(seed)) planned.set(seed, makePlan(seed, interest).flatMap((e) => e.passes));
    return planned.get(seed)!;
};

describe('where the roll is most extreme', () => {
    it('rates every bar of the piece, repeat written out', () => {
        expect(interest).toHaveLength(32);
        expect(interest.every((x) => Number.isFinite(x) && x > 0)).toBe(true);
    });
});

describe('a practice session', () => {
    it('is the same session for the same seed', () => {
        expect(makePlan(1905, interest)).toEqual(makePlan(1905, interest));
        expect(makePlan(1905, interest)).not.toEqual(makePlan(1906, interest));
    });

    it('runs to about sixty passes', () => {
        const mean = SEEDS.reduce((sum, seed) => sum + passesOf(seed).length, 0) / SEEDS.length;
        expect(mean).toBeGreaterThan(50);
        expect(mean).toBeLessThan(70);
    });

    it('works through the whole piece and ends with all of it', () => {
        for (const seed of SEEDS.slice(0, 10)) {
            const plan = makePlan(seed, interest);
            const last = plan[plan.length - 1];
            expect(last.kind).toBe('whole');
            expect([last.from, last.to]).toEqual([0, END]);
            for (const pass of plan.flatMap((e) => e.passes)) {
                expect(pass.range[0]).toBeGreaterThanOrEqual(0);
                expect(pass.range[1]).toBeLessThanOrEqual(END);
                expect(pass.range[1]).toBeGreaterThan(pass.range[0]);
            }
        }
    });

    it('checks the harmony on the reduction, sped up, with arpeggios and exaggeration', () => {
        const reductions = SEEDS.flatMap(passesOf).filter((p) => p.source === 'red');
        expect(reductions.length).toBeGreaterThan(SEEDS.length);
        for (const pass of reductions) {
            expect(pass.speed).toBeGreaterThanOrEqual(1.8);
            expect(pass.speed).toBeLessThanOrEqual(5);
            expect(pass.timeScale).toBeCloseTo(1 / pass.speed!, 9);
            expect(Object.keys(pass.factors).length).toBeGreaterThanOrEqual(2);
        }
        expect(reductions.some((p) => (p.factors.ornamentSpread ?? 1) > 1)).toBe(true);
    });

    it('never plays plainly as on the roll, and never below it', () => {
        for (const pass of SEEDS.flatMap(passesOf)) {
            const factors = Object.values(pass.factors);
            expect(Math.max(...factors)).toBeGreaterThan(1.5);
            expect(Math.min(...factors)).toBeGreaterThanOrEqual(1);
        }
    });

    it('never plays the same bars the same way twice', () => {
        for (const seed of SEEDS.slice(0, 20)) {
            const passes = passesOf(seed);
            const key = (p: Pass) => JSON.stringify([p.source, p.hand, p.scope, p.timeScale, p.vel, p.voice, DIMENSIONS.map((d) => p.factors[d] ?? 1)]);
            passes.forEach((p, i) => passes.slice(i + 1).forEach((q) => {
                const overlap = p.range[0] < q.range[1] && q.range[0] < p.range[1];
                if (overlap) expect(key(p)).not.toBe(key(q));
            }));
        }
    });

    it('drives the leading dimensions to extremes', () => {
        const passes = SEEDS.flatMap(passesOf);
        expect(passes.some((p) => (p.factors.rubato ?? 1) > 6)).toBe(true);
        expect(passes.some((p) => (p.factors.tempo ?? 1) > 2.5)).toBe(true);
    });
});

describe('bars in words', () => {
    it('counts the upbeat with the phrase it leads into', () => {
        expect(rangeLabel(0, END)).toBe('Whole piece');
        expect(rangeLabel(0, 4 * 2880)).toBe('Bars 1–4');
        expect(rangeLabel(4 * 2880, 6 * 2880)).toBe('Bars 5–6');
        expect(rangeLabel(8 * 2880, 9 * 2880)).toBe('Bar 1 (repeat)');
        expect(rangeLabel(6 * 2880, 10 * 2880)).toBe('Bars 7–8 → 1–2 (repeat)');
    });
});
