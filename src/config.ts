import OpenAI from 'openai';

export type CuePrepMode = 'realtime' | 'balanced' | 'studio';

export const MODEL = process.env.OPENAI_MODEL || 'gpt-5.2';
export const JUDGEMENT_MODEL = process.env.OPENAI_JUDGEMENT_MODEL || 'gpt-4.1-mini';
export const OUTPUT_LANGUAGE = process.env.OUTPUT_LANGUAGE || 'German';

export const DEFAULT_CUE_MODELS: Record<CuePrepMode, string> = {
    realtime: process.env.OPENAI_CUE_MODEL_REALTIME || process.env.OPENAI_CUE_MODEL || 'gpt-4.1-mini',
    balanced: process.env.OPENAI_CUE_MODEL_BALANCED || process.env.OPENAI_CUE_MODEL || 'gpt-5-mini',
    studio: process.env.OPENAI_CUE_MODEL_STUDIO || process.env.OPENAI_CUE_MODEL || 'gpt-5.2',
};

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
