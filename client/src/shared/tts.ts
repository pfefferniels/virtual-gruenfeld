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

export const normalizeV3Tag = (rawTag: string): string | null => {
    const normalized = rawTag.trim().toLowerCase();
    if (!normalized) return null;
    if (ALLOWED_V3_TAGS.has(normalized)) return normalized;
    return V3_TAG_ALIASES[normalized] ?? null;
};

