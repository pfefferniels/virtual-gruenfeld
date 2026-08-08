/**
 * One lesson = one page load. The id ties every take of this sitting together so
 * the teacher can remember the earlier ones; nothing is persisted client-side, so
 * a reload deliberately starts a fresh lesson.
 */

let sessionId: string | null = null;

const createSessionId = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // Non-secure contexts have no randomUUID; the id only needs to be unique.
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};

export const getSessionId = (): string => {
    if (!sessionId) sessionId = createSessionId();
    return sessionId;
};
