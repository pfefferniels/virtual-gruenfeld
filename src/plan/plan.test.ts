import { describe, expect, it } from 'vitest';

import { LESSON_PLAN_SCHEMA } from './schema';
import { describePlan, parseAgenticResponse, validatePlan } from './validate';
import { DEFAULT_PLAN, STRENGTH_MAX, STRENGTH_MIN } from './types';

/** m1.2–m5.4 — the range the committed diff fixtures cover. */
const TAKE = { from: 720, to: 13680 };
const DIFF_TYPES = ['tempo', 'dynamics', 'rubato'];

const validate = (demo: unknown, context = { takeRange: TAKE, diffTypes: DIFF_TYPES }) =>
    validatePlan(demo, context);

const demo = (overrides: Record<string, unknown> = {}) => ({
    mode: 'exaggerated',
    range: null,
    dimensions: [],
    ...overrides,
});

describe('plan mode', () => {
    it('keeps each of the three modes', () => {
        for (const mode of ['exaggerated', 'reference', 'none'] as const) {
            const { plan, warnings } = validate(demo({ mode }));
            expect(plan.mode).toBe(mode);
            expect(warnings).toEqual([]);
        }
    });

    it('falls back to exaggerated for a mode that is not one of the three', () => {
        const { plan, warnings } = validate(demo({ mode: 'caricature' }));
        expect(plan.mode).toBe('exaggerated');
        expect(warnings[0]).toContain('not a demo mode');
    });

    it('falls back to the whole exaggerated take when there is no demo at all', () => {
        for (const missing of [null, undefined, 'exaggerated', 42]) {
            const { plan, warnings } = validate(missing);
            expect(plan).toEqual(DEFAULT_PLAN);
            expect(warnings[0]).toContain('falling back');
        }
    });

    it('carries no dimensions for reference and none, whatever the model asked for', () => {
        for (const mode of ['reference', 'none'] as const) {
            const { plan } = validate(demo({ mode, dimensions: [{ type: 'tempo', strength: 0.3 }] }));
            expect(plan.dimensions).toEqual([]);
        }
    });
});

describe('plan range', () => {
    it('resolves measure.beat positions to ticks', () => {
        const { plan, warnings } = validate(demo({ range: { from: 'm2.1', to: 'm4.1' } }));
        expect(plan.range).toEqual({ from: 2880, to: 8640 });
        expect(warnings).toEqual([]);
    });

    it('clamps a range that reaches past the end of the take', () => {
        const { plan, warnings } = validate(demo({ range: { from: 'm4.1', to: 'm12.1' } }));
        expect(plan.range).toEqual({ from: 8640, to: TAKE.to });
        expect(warnings[0]).toContain('clamped');
    });

    it('clamps a range that starts before the take', () => {
        const { plan, warnings } = validate(demo({ range: { from: 'm1.1', to: 'm3.1' } }));
        expect(plan.range).toEqual({ from: TAKE.from, to: 5760 });
        expect(warnings[0]).toContain('clamped');
    });

    it('falls back to the full take when the range misses it entirely', () => {
        const { plan, warnings } = validate(demo({ range: { from: 'm20.1', to: 'm24.1' } }));
        expect(plan.range).toBeNull();
        expect(warnings.join(' ')).toContain('shorter than one beat');
    });

    it('falls back to the full take for positions it cannot read', () => {
        for (const range of [{ from: 'bar 3', to: 'm4.1' }, { from: 'm3.9', to: 'm4.1' }, { from: 3, to: 5 }]) {
            const { plan, warnings } = validate(demo({ range }));
            expect(plan.range).toBeNull();
            expect(warnings[0]).toContain('unparseable');
        }
    });

    it('reports the whole take as no range at all', () => {
        const { plan } = validate(demo({ range: { from: 'm1.2', to: 'm5.4' } }));
        expect(plan.range).toBeNull();
    });

    it('rejects a demo shorter than one beat', () => {
        const { plan, warnings } = validate(demo({ range: { from: 'm3.1', to: 'm3.1' } }));
        expect(plan.range).toBeNull();
        expect(warnings[0]).toContain('shorter than one beat');
    });

    it('accepts a reversed range by ordering it', () => {
        const { plan } = validate(demo({ range: { from: 'm4.1', to: 'm2.1' } }));
        expect(plan.range).toEqual({ from: 2880, to: 8640 });
    });

    it('leaves the range unbounded when the request carried no take range', () => {
        const { plan, warnings } = validatePlan(demo({ range: { from: 'm20.1', to: 'm24.1' } }), {});
        expect(plan.range).toEqual({ from: 54720, to: 66240 });
        expect(warnings).toEqual([]);
    });
});

describe('plan dimensions', () => {
    it('keeps a dimension the diff measured', () => {
        const { plan, warnings } = validate(demo({ dimensions: [{ type: 'tempo', strength: 0.3 }] }));
        expect(plan.dimensions).toEqual([{ type: 'tempo', strength: 0.3 }]);
        expect(warnings).toEqual([]);
    });

    it('clamps strength into the safe band', () => {
        const { plan, warnings } = validate(demo({
            dimensions: [
                { type: 'tempo', strength: 9 },
                { type: 'dynamics', strength: -4 },
            ],
        }));
        expect(plan.dimensions).toEqual([
            { type: 'tempo', strength: STRENGTH_MAX },
            { type: 'dynamics', strength: STRENGTH_MIN },
        ]);
        expect(warnings).toHaveLength(2);
        expect(warnings[0]).toContain('clamped to 0.5');
        expect(warnings[1]).toContain('clamped to 0.05');
    });

    it('drops a type the diff never measured', () => {
        const { plan, warnings } = validate(demo({
            dimensions: [{ type: 'tempo', strength: 0.2 }, { type: 'ornament', strength: 0.4 }],
        }));
        expect(plan.dimensions).toEqual([{ type: 'tempo', strength: 0.2 }]);
        expect(warnings[0]).toContain('the diff measured no such deviation');
    });

    it('drops a type that is not an MPM instruction type', () => {
        const { plan, warnings } = validate(demo({ dimensions: [{ type: 'phrasing', strength: 0.2 }] }));
        expect(plan.dimensions).toEqual([]);
        expect(warnings[0]).toContain('unknown type');
    });

    it('drops duplicates and unusable strengths', () => {
        const { plan, warnings } = validate(demo({
            dimensions: [
                { type: 'tempo', strength: 0.2 },
                { type: 'tempo', strength: 0.4 },
                { type: 'dynamics', strength: 'stark' },
                { type: 'rubato', strength: Number.NaN },
                'tempo',
            ],
        }));
        expect(plan.dimensions).toEqual([{ type: 'tempo', strength: 0.2 }]);
        expect(warnings.join(' ')).toContain('duplicate tempo');
        expect(warnings.join(' ')).toContain('is not a number');
    });

    it('treats a missing dimension list as "shape everything by default"', () => {
        for (const dimensions of [null, undefined, []]) {
            expect(validate(demo({ dimensions })).plan.dimensions).toEqual([]);
        }
    });

    it('filters nothing when the request carried no structured diff', () => {
        const { plan } = validatePlan(demo({ dimensions: [{ type: 'ornament', strength: 0.3 }] }), {
            takeRange: TAKE,
        });
        expect(plan.dimensions).toEqual([{ type: 'ornament', strength: 0.3 }]);
    });
});

describe('agentic response parsing', () => {
    const MONOLOGUE = '«JUDGE» Zu hastig, aber warm «m2.2» [softly] ruhiger atmen';

    it('reads the monologue verbatim, markers and all', () => {
        const parsed = parseAgenticResponse(JSON.stringify({
            monologue: MONOLOGUE,
            demo: { mode: 'none', range: null, dimensions: null },
        }));
        expect(parsed?.monologue).toBe(MONOLOGUE);
        expect(parsed?.demo).toMatchObject({ mode: 'none' });
    });

    it('returns null for anything that is not a lesson-plan object', () => {
        for (const raw of ['', 'not json', '[]', '"text"', '{"demo":{}}', '{"monologue":5}']) {
            expect(parseAgenticResponse(raw)).toBeNull();
        }
    });

    it('accepts a monologue with no demo attached', () => {
        const parsed = parseAgenticResponse(JSON.stringify({ monologue: MONOLOGUE }));
        expect(parsed?.demo).toBeNull();
        expect(validatePlan(parsed?.demo).plan).toEqual(DEFAULT_PLAN);
    });
});

describe('plan description', () => {
    it('names mode, range and dimensions', () => {
        expect(describePlan({
            mode: 'exaggerated',
            range: { from: 2880, to: 8640 },
            dimensions: [{ type: 'tempo', strength: 0.3 }],
        })).toBe('exaggerated | m2.1–m4.1 | tempo@0.3');
    });

    it('says so when nothing was narrowed', () => {
        expect(describePlan(DEFAULT_PLAN)).toBe('exaggerated | full take | all@default');
    });
});

describe('structured-output schema', () => {
    /** OpenAI strict mode: every object closed, every property required. */
    const assertStrict = (node: Record<string, unknown>, path: string): void => {
        const type = node.type;
        const types = Array.isArray(type) ? type : [type];

        if (types.includes('object')) {
            expect(node.additionalProperties, `${path}.additionalProperties`).toBe(false);
            const properties = (node.properties ?? {}) as Record<string, Record<string, unknown>>;
            expect(new Set(node.required as string[]), `${path}.required`)
                .toEqual(new Set(Object.keys(properties)));
            for (const [key, child] of Object.entries(properties)) assertStrict(child, `${path}.${key}`);
        }
        if (types.includes('array')) {
            assertStrict(node.items as Record<string, unknown>, `${path}[]`);
        }
    };

    it('is strict all the way down', () => {
        assertStrict(LESSON_PLAN_SCHEMA as unknown as Record<string, unknown>, 'lesson_plan');
    });

    it('offers exactly the three demo modes and the seven instruction types', () => {
        const demoProps = LESSON_PLAN_SCHEMA.properties.demo.properties;
        expect(demoProps.mode.enum).toEqual(['exaggerated', 'reference', 'none']);
        expect(demoProps.dimensions.items.properties.type.enum).toEqual([
            'tempo', 'dynamics', 'articulation', 'rubato', 'ornament', 'accentuationPattern', 'asynchrony',
        ]);
    });

    it('makes the optional parts nullable rather than absent', () => {
        const demoProps = LESSON_PLAN_SCHEMA.properties.demo.properties;
        expect(demoProps.range.type).toContain('null');
        expect(demoProps.dimensions.type).toContain('null');
    });
});
