/**
 * What the routes need to ask for a lesson plan and trust the answer. The
 * schema, the clamping rules and the shape constants stay inside the module —
 * `plan.test.ts` reaches for them directly, nothing else should.
 */
export { LESSON_PLAN_FORMAT } from './schema';
export { describePlan, parseAgenticResponse, validatePlan } from './validate';
export { DEFAULT_PLAN } from './types';
export type { LessonPlan } from './types';
