export const ELEVEN_V3_MODEL_ID = 'eleven_v3';

/**
 * The answer path's voice. v3 is the most expressive model and the take path
 * needs it for character timestamps, but it is also far the slowest to generate.
 *
 * Measured 2026-08-08 on a 314-character German answer, interleaved A/B over 4
 * rounds, timing to response headers so the server's generation time is separated
 * from body transfer: eleven_v3 median 9667ms (spread 1.15x) against
 * eleven_turbo_v2_5 median 796ms — 12x, and 4.6x even comparing v3's fastest run
 * to turbo's slowest. Transcribing both renders back gave 0% word error, so the
 * cost of leaving v3 here is only delivery: v3 speaks the same sentence over
 * 24.6s where turbo takes 18.1s, unhurried where turbo is brisk. A 12x wait for
 * that is the wrong trade when the student is holding a question.
 */
export const ELEVEN_ASK_MODEL_ID = 'eleven_turbo_v2_5';
