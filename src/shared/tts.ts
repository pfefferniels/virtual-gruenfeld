export const ELEVEN_V3_MODEL_ID = 'eleven_v3';

const ALLOWED_V3_TAGS = new Set([
    'warmly',
    'encouragingly',
    'softly',
    'whispers',
    'slowly',
    'urgent',
    'curious',
    'excited',
    'sad',
    'gently',
]);

const V3_TAG_ALIASES: Record<string, string> = {
    inviting: 'warmly',
    leading: 'encouragingly',
    resolving: 'softly',
    releasing: 'softly',
    neutral: 'slowly',
    guiding: 'encouragingly',
    supportive: 'warmly',
    tenderly: 'gently',
};

const normalizeV3Tag = (rawTag: string): string | null => {
    const normalized = rawTag.trim().toLowerCase();
    if (!normalized) return null;
    if (ALLOWED_V3_TAGS.has(normalized)) return normalized;
    return V3_TAG_ALIASES[normalized] ?? null;
};

export const sanitizeCueForSpeech = (text: string, modelId: string): string => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return normalized;

    const leadingTagMatch = normalized.match(/^\[([a-zA-Z][a-zA-Z ]{0,23})\]\s*/);
    const normalizedTag = modelId === ELEVEN_V3_MODEL_ID && leadingTagMatch
        ? normalizeV3Tag(leadingTagMatch[1])
        : null;
    const leadingTag = normalizedTag ? `[${normalizedTag}] ` : '';

    const body = normalized
        .slice(leadingTagMatch?.[0].length ?? 0)
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return `${leadingTag}${body}`.trim();
};
