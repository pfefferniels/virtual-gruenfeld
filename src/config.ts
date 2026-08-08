import OpenAI from 'openai';

export type CuePrepMode = 'realtime' | 'balanced' | 'studio';

export const OUTPUT_LANGUAGE = process.env.OUTPUT_LANGUAGE || 'German';

/**
 * Tier → model. Measured 2026-08-08 on the grounded prompt (3 fixtures, 3 runs each):
 * gpt-5.4-mini ~1.3s · gpt-5.6-terra ~2.0-3.7s (richest output) · gpt-5.6-luna
 * 4.7-6.0s and noticeably more generic — dominated by terra on both axes, so both
 * non-realtime tiers pin terra; they differ in corpus depth (see CORPUS_DEPTH).
 * The pre-modernization pins (gpt-4.1-mini / gpt-5-mini / gpt-5.2) were
 * latency-inverted — "balanced" (gpt-5-mini) was the slowest of the three.
 */
export const DEFAULT_CUE_MODELS: Record<CuePrepMode, string> = {
    realtime: process.env.OPENAI_CUE_MODEL_REALTIME || process.env.OPENAI_CUE_MODEL || 'gpt-5.4-mini',
    balanced: process.env.OPENAI_CUE_MODEL_BALANCED || process.env.OPENAI_CUE_MODEL || 'gpt-5.6-terra',
    studio: process.env.OPENAI_CUE_MODEL_STUDIO || process.env.OPENAI_CUE_MODEL || 'gpt-5.6-terra',
};

/**
 * How much of the scholarly corpus each tier carries. `realtime` speaks over live
 * playback, so it trades the argumentations that carry no motivation and no
 * editorial prose for a shorter prompt.
 */
export const CORPUS_DEPTH: Record<CuePrepMode, { compactCorpus: boolean; rangeDetail: boolean }> = {
    realtime: { compactCorpus: true, rangeDetail: true },
    balanced: { compactCorpus: false, rangeDetail: true },
    studio: { compactCorpus: false, rangeDetail: true },
};

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const parseCuePrepMode = (value: unknown): CuePrepMode =>
    value === 'studio' || value === 'balanced' || value === 'realtime' ? value : 'balanced';
