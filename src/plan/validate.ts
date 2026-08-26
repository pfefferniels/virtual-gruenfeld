import { positionToTick, tickToPos } from '../shared/musicalTime';
import {
    DEFAULT_PLAN,
    DEMO_MODES,
    EDITS_MAX,
    EDITS_MIN,
    INSTRUCTION_TYPES,
    MIN_DEMO_TICKS,
    SHAPING_MODES,
    STRENGTH_MAX,
    STRENGTH_MIN,
    type DemoMode,
    type InstructionType,
    type LessonPlan,
    type PlanDimension,
    type RawLessonPlan,
} from './types';

type PlanContext = {
    /** The take the plan has to stay inside. Absent for the legacy diff-string path. */
    takeRange?: { from: number; to: number };
    /**
     * The types this take actually measured — the audibility gate's list intersected with what
     * the fitter wrote (DESIGN §3.4), sent by the client since S5/S6. A plan may only shape a
     * type the diff measured (semantics 26); absent, nothing is filtered, which is what the
     * legacy diff-string path and the probe get.
     *
     * It is a stronger list than "types that produced an event": a type can be measured on a
     * take where the student got it right, and the demonstration is then allowed to name it.
     */
    measuredTypes?: Iterable<string>;
};

type ValidatedPlan = {
    plan: LessonPlan;
    /** Everything that had to be corrected — logged by the route, asserted by tests. */
    warnings: string[];
};

const isMode = (value: unknown): value is DemoMode =>
    typeof value === 'string' && (DEMO_MODES as readonly string[]).includes(value);

const isInstructionType = (value: unknown): value is InstructionType =>
    typeof value === 'string' && (INSTRUCTION_TYPES as readonly string[]).includes(value);

const clampStrength = (value: unknown): number | null => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.max(STRENGTH_MIN, Math.min(STRENGTH_MAX, value));
};

/**
 * Resolve the model's `mN.B` range against the take. Anything unusable falls back
 * to the whole take rather than failing the turn — a demo of the wrong passage is
 * worse than a demo of the obvious one, but no demo at all is worse than both.
 */
const validateRange = (
    raw: unknown,
    takeRange: { from: number; to: number } | undefined,
    warnings: string[],
): LessonPlan['range'] => {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'object') {
        warnings.push('range: not an object, using the full take');
        return null;
    }

    const { from, to } = raw as { from?: unknown; to?: unknown };
    const fromTick = typeof from === 'string' ? positionToTick(from) : null;
    const toTick = typeof to === 'string' ? positionToTick(to) : null;
    if (fromTick === null || toTick === null) {
        warnings.push(`range: unparseable positions (${JSON.stringify(from)}, ${JSON.stringify(to)}), using the full take`);
        return null;
    }

    let lo = Math.min(fromTick, toTick);
    let hi = Math.max(fromTick, toTick);
    if (!takeRange) return { from: lo, to: hi };

    if (lo < takeRange.from || hi > takeRange.to) {
        const before = `${tickToPos(lo)}–${tickToPos(hi)}`;
        lo = Math.max(lo, takeRange.from);
        hi = Math.min(hi, takeRange.to);
        warnings.push(
            `range: ${before} reaches outside the take ${tickToPos(takeRange.from)}–${tickToPos(takeRange.to)}, clamped`,
        );
    }

    if (hi - lo < MIN_DEMO_TICKS) {
        warnings.push(`range: ${tickToPos(lo)}–${tickToPos(hi)} is shorter than one beat, using the full take`);
        return null;
    }

    // Asking for the whole take is the same as asking for nothing.
    if (lo <= takeRange.from && hi >= takeRange.to) return null;
    return { from: lo, to: hi };
};

/**
 * `mode: 'path'`'s k. Anything unusable falls back to `null`, which is the client's own default
 * of three — a demonstration of the wrong number of corrections beats no demonstration.
 */
const validateEdits = (raw: unknown, mode: DemoMode, warnings: string[]): number | null => {
    if (mode !== 'path') return null;
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        warnings.push(`edits: ${JSON.stringify(raw)} is not a number, using the default`);
        return null;
    }
    const clamped = Math.max(EDITS_MIN, Math.min(EDITS_MAX, Math.round(raw)));
    if (clamped !== raw) warnings.push(`edits: ${raw} clamped to ${clamped}`);
    return clamped;
};

const validateDimensions = (
    raw: unknown,
    measuredTypes: Set<string> | null,
    warnings: string[],
): PlanDimension[] => {
    if (raw === null || raw === undefined) return [];
    if (!Array.isArray(raw)) {
        warnings.push('dimensions: not an array, shaping every dimension by default');
        return [];
    }

    const dimensions: PlanDimension[] = [];
    const seen = new Set<string>();

    for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) continue;
        const { type, strength } = entry as { type?: unknown; strength?: unknown };

        if (!isInstructionType(type)) {
            warnings.push(`dimensions: dropped unknown type ${JSON.stringify(type)}`);
            continue;
        }
        if (measuredTypes && !measuredTypes.has(type)) {
            warnings.push(`dimensions: dropped ${type} — the diff measured no such deviation`);
            continue;
        }
        if (seen.has(type)) {
            warnings.push(`dimensions: dropped duplicate ${type}`);
            continue;
        }

        const clamped = clampStrength(strength);
        if (clamped === null) {
            warnings.push(`dimensions: dropped ${type} — strength ${JSON.stringify(strength)} is not a number`);
            continue;
        }
        if (typeof strength === 'number' && clamped !== strength) {
            warnings.push(`dimensions: ${type} strength ${strength} clamped to ${clamped}`);
        }

        seen.add(type);
        dimensions.push({ type, strength: clamped });
    }

    return dimensions;
};

/**
 * Turn whatever the model produced into a plan the client is allowed to execute.
 * Never throws and never returns null: an unusable plan degrades to today's
 * behaviour (exaggerate the whole take across every dimension).
 */
export const validatePlan = (raw: unknown, context: PlanContext = {}): ValidatedPlan => {
    const warnings: string[] = [];
    const measuredTypes = context.measuredTypes ? new Set(context.measuredTypes) : null;

    if (typeof raw !== 'object' || raw === null) {
        warnings.push('demo: missing, falling back to the exaggerated whole take');
        return { plan: { ...DEFAULT_PLAN }, warnings };
    }

    const demo = raw as Record<string, unknown>;

    let mode: DemoMode;
    if (isMode(demo.mode)) {
        mode = demo.mode;
    } else {
        warnings.push(`mode: ${JSON.stringify(demo.mode)} is not a demo mode, falling back to exaggerated`);
        mode = 'exaggerated';
    }

    const range = validateRange(demo.range, context.takeRange, warnings);
    // Two modes read the dimensions — `exaggerated` shapes them, `path` filters the edit script
    // by them — and the other two play as-is or not at all.
    const dimensions = (SHAPING_MODES as readonly string[]).includes(mode)
        ? validateDimensions(demo.dimensions, measuredTypes, warnings)
        : [];
    const edits = validateEdits(demo.edits, mode, warnings);

    return { plan: { mode, range, dimensions, edits }, warnings };
};

/**
 * Read the structured-output payload. The monologue is returned verbatim so the
 * existing «MARKER» parser sees exactly the bytes it would have seen as free text.
 */
export const parseAgenticResponse = (rawOutput: string): RawLessonPlan | null => {
    let payload: unknown;
    try {
        payload = JSON.parse(rawOutput);
    } catch {
        return null;
    }
    if (typeof payload !== 'object' || payload === null) return null;

    const { monologue, demo } = payload as { monologue?: unknown; demo?: unknown };
    if (typeof monologue !== 'string') return null;

    return { monologue, demo: (demo ?? null) as RawLessonPlan['demo'] };
};

export const describePlan = (plan: LessonPlan): string => {
    const range = plan.range ? `${tickToPos(plan.range.from)}–${tickToPos(plan.range.to)}` : 'full take';
    const dimensions = plan.dimensions.length > 0
        ? plan.dimensions.map((d) => `${d.type}@${d.strength}`).join(',')
        : 'all@default';
    const edits = typeof plan.edits === 'number' ? ` | ${plan.edits} edit${plan.edits === 1 ? '' : 's'}` : '';
    return `${plan.mode} | ${range} | ${dimensions}${edits}`;
};
