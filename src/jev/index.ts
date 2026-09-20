/**
 * What a caller needs to ask Grünfeld's judgement of a window and trust the answer.
 * The questions and the state shape stay inside the module — the tests reach for them
 * directly, nothing else should.
 */
export { decide, startHeartbeat } from './client';
export type { Verdict } from './client';
export { planFrom } from './decide';
export { isLiveDimension } from './state';
export type { Correction, DecisionState, Deviation } from './state';
