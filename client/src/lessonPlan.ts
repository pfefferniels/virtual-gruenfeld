/**
 * Client-side twin of `src/plan/types.ts`. The server validates the plan before
 * sending it; this module only has to survive a payload that is not what it
 * claims to be, so it re-applies the bounds rather than trusting the wire.
 */

import type { ExaggerationDimension } from './mpm';
import type { Range } from './mpm';

export type DemoMode = 'exaggerated' | 'path' | 'reference' | 'none';

export type LessonPlan = {
    mode: DemoMode;
    /** Ticks inside the take. Null means the whole take. */
    range: Range | null;
    /** Empty means every dimension at the default strength. */
    dimensions: ExaggerationDimension[];
    /**
     * `mode: 'path'` only — how many of the costliest corrections the student hears. Null means
     * the module's own default (`mpm/path.ts`'s three).
     */
    edits: number | null;
};

const DEMO_MODES: readonly string[] = ['exaggerated', 'path', 'reference', 'none'];
const STRENGTH_MIN = 0.05;
const STRENGTH_MAX = 0.5;
/** The server's `EDITS_MIN`/`EDITS_MAX`, restated here for the same reason the strengths are. */
const EDITS_MIN = 1;
const EDITS_MAX = 5;

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

const readEdits = (raw: unknown): number | null => {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
    return Math.max(EDITS_MIN, Math.min(EDITS_MAX, Math.round(raw)));
};

/** Null when the response carried no plan — the caller then demos as it always did. */
export const readLessonPlan = (raw: unknown): LessonPlan | null => {
    if (typeof raw !== 'object' || raw === null) return null;
    const { mode, range, dimensions, edits } = raw as Record<string, unknown>;
    return {
        mode: (typeof mode === 'string' && DEMO_MODES.includes(mode) ? mode : 'exaggerated') as DemoMode,
        range: readRange(range),
        dimensions: readDimensions(dimensions),
        edits: readEdits(edits),
    };
};

export const describePlan = (plan: LessonPlan): string => {
    const range = plan.range ? `[${plan.range.from}, ${plan.range.to}]` : 'full take';
    const dimensions = plan.dimensions.length > 0
        ? plan.dimensions.map((d) => `${d.type}@${d.strength}`).join(',')
        : 'all@default';
    const edits = typeof plan.edits === 'number' ? ` ${plan.edits} edit${plan.edits === 1 ? '' : 's'}` : '';
    return `${plan.mode} ${range} ${dimensions}${edits}`;
};
