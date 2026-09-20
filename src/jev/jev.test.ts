import { describe, expect, it } from 'vitest';
import { planFrom } from './decide';
import { isLiveDimension } from './state';
import { QUESTIONS } from './questions';
import { STRENGTH_MAX, STRENGTH_MIN } from '../plan/types';
import type { Verdict } from './client';

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
    interrupt: 0.6,
    dimension: 'tempo',
    severity: 2.8,
    exaggeration: 1.4,
    mode: 'exaggerated',
    confidence: { dimension: 0.9, severity: 0.7 },
    latencyMs: 380,
    inputTokens: 1020,
    ...over,
});

const context = { range: { from: 11520, to: 17280 }, measuredTypes: ['tempo'] };

describe('the questions', () => {
    it('asks about interrupting as a yes/no, and the rest as choices and scores', () => {
        expect(QUESTIONS.interrupt.type).toBe('noul');
        expect(QUESTIONS.dimension.type).toBe('choice');
        expect(QUESTIONS.mode.type).toBe('choice');
        expect(QUESTIONS.severity.type).toBe('score');
        expect(QUESTIONS.exaggeration.type).toBe('score');
    });

    it('keeps every score inside the 2–10 levels the primitive allows', () => {
        expect(QUESTIONS.severity.criteria.length).toBeGreaterThanOrEqual(2);
        expect(QUESTIONS.severity.criteria.length).toBeLessThanOrEqual(10);
        expect(QUESTIONS.exaggeration.criteria.length).toBeGreaterThanOrEqual(2);
        expect(QUESTIONS.exaggeration.criteria.length).toBeLessThanOrEqual(10);
    });

    it('offers only the dimensions a short window can identify, plus none', () => {
        expect(Object.keys(QUESTIONS.dimension.criteria).sort()).toEqual(['dynamics', 'none', 'tempo']);
    });

    it('offers exactly the demo modes the plan can execute', () => {
        expect(Object.keys(QUESTIONS.mode.criteria).sort()).toEqual(['exaggerated', 'none', 'path', 'reference']);
    });
});

describe('isLiveDimension', () => {
    it('admits what the window can identify and refuses the rest', () => {
        expect(isLiveDimension('tempo')).toBe(true);
        expect(isLiveDimension('dynamics')).toBe(true);
        expect(isLiveDimension('rubato')).toBe(false);
        expect(isLiveDimension('none')).toBe(false);
        expect(isLiveDimension(undefined)).toBe(false);
    });
});

describe('a verdict turned into a plan', () => {
    it('carries the dimension Jev named', () => {
        const { plan } = planFrom(verdict(), context);
        expect(plan.mode).toBe('exaggerated');
        expect(plan.dimensions.map((d) => d.type)).toEqual(['tempo']);
    });

    it('plays a fragment, not the window it judged', () => {
        const { plan } = planFrom(verdict(), context);
        // The window is two bars; what he plays is the bar that carried the point.
        expect(plan.range).toEqual({ from: 14400, to: 17280 });
    });

    it('plays the whole of a window already shorter than a bar', () => {
        const { plan } = planFrom(verdict(), { ...context, range: { from: 14400, to: 15840 } });
        expect(plan.range).toBeNull();
    });

    it('plays nothing when there is nothing to demonstrate', () => {
        const { plan } = planFrom(verdict({ dimension: 'none' }), { ...context, measuredTypes: [] });
        expect(plan.mode).toBe('none');
        expect(plan.dimensions).toEqual([]);
    });

    it('refuses a dimension the window cannot identify, whatever Jev answers', () => {
        const { plan } = planFrom(verdict({ dimension: 'rubato' }), { ...context, measuredTypes: ['rubato'] });
        expect(plan.mode).toBe('none');
        expect(plan.dimensions).toEqual([]);
    });

    it('maps the exaggeration score onto the plan’s own strength range', () => {
        const straight = planFrom(verdict({ exaggeration: 0 }), context).plan;
        const hardest = planFrom(verdict({ exaggeration: 3 }), context).plan;
        expect(straight.dimensions[0].strength).toBeCloseTo(STRENGTH_MIN, 5);
        expect(hardest.dimensions[0].strength).toBeCloseTo(STRENGTH_MAX, 5);
    });

    it('clamps a score outside its own levels rather than trusting it', () => {
        const beyond = planFrom(verdict({ exaggeration: 99 }), context).plan;
        expect(beyond.dimensions[0].strength).toBeLessThanOrEqual(STRENGTH_MAX);
        expect(beyond.dimensions[0].strength).toBeGreaterThanOrEqual(STRENGTH_MIN);
    });

    it('drops a dimension the evidence never measured, and says so', () => {
        const { plan, warnings } = planFrom(verdict({ dimension: 'dynamics' }), { ...context, measuredTypes: ['tempo'] });
        expect(plan.dimensions).toEqual([]);
        expect(warnings.join(' ')).toMatch(/dynamics/);
    });
});
