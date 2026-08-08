/**
 * The lesson plan: what the teacher decided to demonstrate, and how hard.
 * Produced by the model under a strict JSON schema, then validated here before
 * it ever reaches the client (see `validate.ts`).
 */

/** The MPM instruction types the diff can report and `exaggerate()` can shape. */
export const INSTRUCTION_TYPES = [
    'tempo',
    'dynamics',
    'articulation',
    'rubato',
    'ornament',
    'accentuationPattern',
    'asynchrony',
] as const;

export type InstructionType = typeof INSTRUCTION_TYPES[number];

export type DemoMode = 'exaggerated' | 'reference' | 'none';

export const DEMO_MODES: readonly DemoMode[] = ['exaggerated', 'reference', 'none'];

export type PlanDimension = {
    type: InstructionType;
    /** Maps onto `exaggerate()`'s aggressiveness. Always within [MIN, MAX] after validation. */
    strength: number;
};

export type LessonPlan = {
    mode: DemoMode;
    /**
     * Ticks, always inside the take range. `null` means "the whole take" — either
     * the model asked for the full range or the request carried no range at all.
     */
    range: { from: number; to: number } | null;
    /**
     * The deviation types the demo should shape. Empty means "all of them at the
     * legacy default strength", which is exactly today's behaviour.
     */
    dimensions: PlanDimension[];
};

/** What the model returns, before validation: shapes are unknown at this point. */
export type RawLessonPlan = {
    monologue: string;
    demo: LessonPlan | null;
};

export const STRENGTH_MIN = 0.05;
export const STRENGTH_MAX = 0.5;

/** A demo shorter than one beat cannot be heard as a passage. */
export const MIN_DEMO_TICKS = 720;

export const DEFAULT_PLAN: LessonPlan = { mode: 'exaggerated', range: null, dimensions: [] };
