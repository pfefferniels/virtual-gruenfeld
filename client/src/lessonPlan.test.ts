import { afterEach, describe, expect, it, vi } from 'vitest';

import { isAgenticTeacher, TEACHER_AGENTIC_KEY } from './featureFlags';
import { describePlan, readLessonPlan } from './lessonPlan';

describe('readLessonPlan', () => {
    it('reads a validated plan off the wire', () => {
        expect(readLessonPlan({
            mode: 'reference',
            range: { from: 2880, to: 8640 },
            dimensions: [{ type: 'tempo', strength: 0.35 }],
        })).toEqual({
            mode: 'reference',
            range: { from: 2880, to: 8640 },
            dimensions: [{ type: 'tempo', strength: 0.35 }],
            edits: null,
        });
    });

    it('keeps the fourth mode, and the edit count that only it uses', () => {
        expect(readLessonPlan({ mode: 'path', range: null, dimensions: [], edits: 2 })).toEqual({
            mode: 'path',
            range: null,
            dimensions: [],
            edits: 2,
        });
    });

    it('re-applies the edit bounds and reads a missing count as the default', () => {
        const edits = (raw: unknown) => readLessonPlan({ mode: 'path', range: null, dimensions: [], edits: raw })?.edits;
        expect(edits(9)).toBe(5);
        expect(edits(0)).toBe(1);
        expect(edits(2.6)).toBe(3);
        for (const unusable of [null, undefined, 'three', Number.NaN]) expect(edits(unusable)).toBeNull();
    });

    it('returns null when the response carried no plan', () => {
        for (const raw of [undefined, null, 'exaggerated', 7]) {
            expect(readLessonPlan(raw)).toBeNull();
        }
    });

    it('re-applies the strength bounds the server should already have applied', () => {
        const plan = readLessonPlan({
            mode: 'exaggerated',
            range: null,
            dimensions: [{ type: 'tempo', strength: 9 }, { type: 'dynamics', strength: -1 }],
        });
        expect(plan?.dimensions).toEqual([
            { type: 'tempo', strength: 0.5 },
            { type: 'dynamics', strength: 0.05 },
        ]);
    });

    it('drops a range it cannot use and falls back to the whole take', () => {
        for (const range of [{ from: 'm2.1', to: 'm4.1' }, { from: 900, to: 900 }, { from: 900 }, 'all']) {
            expect(readLessonPlan({ mode: 'exaggerated', range, dimensions: [] })?.range).toBeNull();
        }
    });

    it('drops malformed dimensions instead of passing them to exaggerate()', () => {
        const plan = readLessonPlan({
            mode: 'exaggerated',
            range: null,
            dimensions: [{ type: 'tempo' }, { strength: 0.2 }, 'tempo', null, { type: 'rubato', strength: 0.2 }],
        });
        expect(plan?.dimensions).toEqual([{ type: 'rubato', strength: 0.2 }]);
    });

    it('falls back to exaggerated for an unknown mode', () => {
        expect(readLessonPlan({ mode: 'caricature', range: null, dimensions: [] })?.mode).toBe('exaggerated');
    });

    it('describes a plan for the debug log', () => {
        expect(describePlan({ mode: 'none', range: null, dimensions: [], edits: null }))
            .toBe('none full take all@default');
        expect(describePlan({
            mode: 'exaggerated',
            range: { from: 2880, to: 8640 },
            dimensions: [{ type: 'tempo', strength: 0.4 }],
            edits: null,
        })).toBe('exaggerated [2880, 8640] tempo@0.4');
        expect(describePlan({ mode: 'path', range: null, dimensions: [], edits: 1 }))
            .toBe('path full take all@default 1 edit');
    });
});

describe('the agentic feature flag', () => {
    const withStorage = (value: string | null) => {
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => (key === TEACHER_AGENTIC_KEY ? value : null),
        });
    };

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('is off when nothing asked for it', () => {
        expect(isAgenticTeacher()).toBe(false);
    });

    it('follows the build env when the browser has no opinion', () => {
        withStorage(null);
        vi.stubEnv('VITE_TEACHER_AGENTIC', '1');
        expect(isAgenticTeacher()).toBe(true);

        vi.stubEnv('VITE_TEACHER_AGENTIC', '0');
        expect(isAgenticTeacher()).toBe(false);
    });

    it('lets the browser override the build in both directions', () => {
        vi.stubEnv('VITE_TEACHER_AGENTIC', '0');
        withStorage('1');
        expect(isAgenticTeacher()).toBe(true);

        vi.stubEnv('VITE_TEACHER_AGENTIC', '1');
        withStorage('0');
        expect(isAgenticTeacher()).toBe(false);
    });

    it('stays off when storage throws instead of taking the page down', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => { throw new Error('access denied'); },
        });
        expect(isAgenticTeacher()).toBe(false);
    });
});
