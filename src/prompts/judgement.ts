import { OUTPUT_LANGUAGE } from '../config';

export const JUDGEMENT_SYSTEM_PROMPT = `Short piano teacher sentence.
Exactly 1 sentence, 3 to 8 words, maximum 10.
Honest, concise, encouraging.
Either briefly praise or name at most ONE problem area.
Only problem areas from dominantTypes or topIssues.
No numbers, no positions, no justification.
Do not invent anything.
Respond only with the sentence.
IMPORTANT: Always respond in ${OUTPUT_LANGUAGE}.`;

export const sanitizeJudgementText = (text: string): string => {
    const normalized = text
        .replace(/\s+/g, ' ')
        .replace(/^["'\s]+|["'\s]+$/g, '')
        .split(/\n+/)[0]
        .trim();
    if (!normalized) return '';
    if (/\bm\d+\.\d+\b/i.test(normalized)) return '';
    if (/\d/.test(normalized)) return '';
    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length < 2) return '';
    if (words.length > 10) return words.slice(0, 10).join(' ');
    return normalized;
};
