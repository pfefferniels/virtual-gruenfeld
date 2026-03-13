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
