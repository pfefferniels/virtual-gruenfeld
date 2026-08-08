/**
 * The judgement is spoken aloud, so it must not contain measure markers or bare
 * numbers — TTS reads "m2.3" as "em two point three". Offending tokens are
 * stripped rather than discarding the whole sentence; only a sentence that ends
 * up too short to say is rejected, and the caller then falls back to raw text.
 */
export const sanitizeJudgementText = (text: string): string => {
    const normalized = text
        .replace(/\s+/g, ' ')
        .replace(/^["'\s]+|["'\s]+$/g, '')
        .split(/\n+/)[0]
        .trim();
    if (!normalized) return '';

    const words = normalized.split(/\s+/).filter(Boolean);
    const spoken = words.filter((word) => !/\d/.test(word));
    if (spoken.length !== words.length) {
        console.warn('judgement sanitizer: dropped numeric tokens from spoken text', {
            removed: words.filter((word) => /\d/.test(word)),
        });
    }

    if (spoken.length < 2) {
        console.warn('judgement sanitizer: rejected, too little speakable text', { text: normalized });
        return '';
    }
    if (spoken.length > 10) return spoken.slice(0, 10).join(' ');
    return spoken.join(' ');
};
