export const ELEVEN_V3_MODEL_ID = 'eleven_v3';

/**
 * The answer path's voice. v3 is the most expressive model and the take path
 * needs it for character timestamps, but it is also by far the slowest: measured
 * 2026-08-08 on a 314-character German answer (3 runs, medians) —
 * eleven_turbo_v2_5 650ms · eleven_flash_v2_5 725ms · eleven_multilingual_v2
 * 3134ms · eleven_v3 10240ms. Transcribing all four renders back gave 0% word
 * error, so the cost of leaving v3 here is only delivery: v3 speaks the same
 * sentence over 24.6s where turbo takes 18.1s, unhurried where turbo is brisk.
 * A 15x wait for that is the wrong trade when the student is holding a question.
 */
export const ELEVEN_ASK_MODEL_ID = 'eleven_turbo_v2_5';
