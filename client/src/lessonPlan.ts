/**
 * Client-side twin of `src/plan/types.ts`. The server validates the plan before
 * sending it; this module only has to survive a payload that is not what it
 * claims to be, so it re-applies the bounds rather than trusting the wire.
 */

import type { ExaggerationDimension } from './mpm';
import type { Range } from './mpm';

export type DemoMode = 'exaggerated' | 'reference' | 'none';

export type LessonPlan = {
    mode: DemoMode;
    /** Ticks inside the take. Null means the whole take. */
    range: Range | null;
    /** Empty means every dimension at the default strength. */
    dimensions: ExaggerationDimension[];
};

const DEMO_MODES: readonly string[] = ['exaggerated', 'reference', 'none'];
const STRENGTH_MIN = 0.05;
const STRENGTH_MAX = 0.5;

const readRange = (raw: unknown): Range | null => {
    if (typeof raw !== 'object' || raw === null) return null;
    const { from, to } = raw as { from?: unknown; to?: unknown };
    if (typeof from !== 'number' || typeof to !== 'number') return null;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
    return { from, to };
};

const readDimensions = (raw: unknown): ExaggerationDimension[] => {
    if (!Array.isArray(raw)) return [];
    const dimensions: ExaggerationDimension[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) continue;
        const { type, strength } = entry as { type?: unknown; strength?: unknown };
        if (typeof type !== 'string' || typeof strength !== 'number' || !Number.isFinite(strength)) continue;
        dimensions.push({ type, strength: Math.max(STRENGTH_MIN, Math.min(STRENGTH_MAX, strength)) });
    }
    return dimensions;
};

/** Null when the response carried no plan — the caller then demos as it always did. */
export const readLessonPlan = (raw: unknown): LessonPlan | null => {
    if (typeof raw !== 'object' || raw === null) return null;
    const { mode, range, dimensions } = raw as Record<string, unknown>;
    return {
        mode: (typeof mode === 'string' && DEMO_MODES.includes(mode) ? mode : 'exaggerated') as DemoMode,
        range: readRange(range),
        dimensions: readDimensions(dimensions),
    };
};

export const describePlan = (plan: LessonPlan): string => {
    const range = plan.range ? `[${plan.range.from}, ${plan.range.to}]` : 'full take';
    const dimensions = plan.dimensions.length > 0
        ? plan.dimensions.map((d) => `${d.type}@${d.strength}`).join(',')
        : 'all@default';
    return `${plan.mode} ${range} ${dimensions}`;
};
