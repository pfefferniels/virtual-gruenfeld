/**
 * How much time the teacher may spend preparing a cue. The mode travels with
 * every request to the teacher service, which reads it as a tier: which model
 * answers and how much of the scholarly corpus it carries (see `src/config.ts`).
 */
export type CuePrepMode = 'realtime' | 'balanced' | 'studio';
