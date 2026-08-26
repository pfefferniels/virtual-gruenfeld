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

export type DemoMode = 'exaggerated' | 'path' | 'reference' | 'none';

export const DEMO_MODES: readonly DemoMode[] = ['exaggerated', 'path', 'reference', 'none'];

/** The modes that read `dimensions`: one shapes the reference, the other filters the edit script. */
export const SHAPING_MODES: readonly DemoMode[] = ['exaggerated', 'path'];

/**
 * The types `mode: 'path'` can actually correct.
 *
 * `path` writes onto the student's own **instructions**; `ornament` spacing and `articulation`
 * are numbers on shared `<...Def>` elements, which carry no `@date` and belong to the whole
 * piece, and `<ornament @scale>` is excluded with them for risk R3. The client enforces the
 * same list in `client/src/mpm/path.ts` (`PATH_TYPES`) — this copy exists so a plan naming a
 * type the demonstration cannot write is corrected *before* it is sent, with a warning the model
 * can be shown, instead of silently coming out as a correction of something else (a take whose
 * ornament spacing was doubled was demonstrated with three tempo edits).
 */
export const PATH_TYPES: readonly InstructionType[] = ['tempo', 'dynamics', 'rubato', 'accentuationPattern'];

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
     * legacy default strength", which is exactly today's behaviour. For `path` the
     * strengths are ignored and the types alone select which edits are applied.
     */
    dimensions: PlanDimension[];
    /**
     * `mode: 'path'` only — how many of the costliest corrections the student hears
     * applied to their own playing. `null` means the client's own default of three.
     * Null for every other mode, which have nothing to count.
     */
    edits: number | null;
};

/** What the model returns, before validation: shapes are unknown at this point. */
export type RawLessonPlan = {
    monologue: string;
    demo: LessonPlan | null;
};

export const STRENGTH_MIN = 0.05;
export const STRENGTH_MAX = 0.5;

/**
 * How many corrections `mode: 'path'` may put into one demonstration.
 *
 * One is the smallest statement there is; five is where "the things that matter most" stops being
 * a shortlist and becomes a rewrite of the take. The client clamps to the same band
 * (`client/src/lessonPlan.ts`), as it does with the strengths.
 */
export const EDITS_MIN = 1;
export const EDITS_MAX = 5;

/** A demo shorter than one beat cannot be heard as a passage. */
export const MIN_DEMO_TICKS = 720;

export const DEFAULT_PLAN: LessonPlan = { mode: 'exaggerated', range: null, dimensions: [], edits: null };
