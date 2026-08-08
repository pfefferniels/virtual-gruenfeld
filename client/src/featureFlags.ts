/**
 * Prototype switches. Each is off by default, turned on for a build with its
 * `VITE_*` variable, and overridable per browser through localStorage so the two
 * paths can be compared live without a rebuild.
 */

const isTruthy = (value: unknown): boolean =>
    value === '1' || value === 'true' || value === true;

const readFlag = (key: string, envValue: unknown): boolean => {
    try {
        const override = localStorage.getItem(key);
        if (override === '1') return true;
        if (override === '0') return false;
    } catch {
        // Private mode, or no DOM at all under vitest — fall through to the env.
    }
    return isTruthy(envValue);
};

/**
 * Agentic pedagogy: let the model decide what to demonstrate instead of always
 * playing the exaggerated counter-performance over the whole take.
 */
export const TEACHER_AGENTIC_KEY = 'TEACHER_AGENTIC';

export const isAgenticTeacher = (): boolean =>
    readFlag(TEACHER_AGENTIC_KEY, import.meta.env.VITE_TEACHER_AGENTIC);

/**
 * Push-to-talk: hold a button, ask the teacher a question, hear the answer.
 * Off means the page has no microphone UI at all.
 */
export const TEACHER_VOICE_KEY = 'TEACHER_VOICE';

export const isVoiceTeacher = (): boolean =>
    readFlag(TEACHER_VOICE_KEY, import.meta.env.VITE_TEACHER_VOICE);

/**
 * Pin a flag for this browser, whatever the build says. `null` drops the
 * override and hands the flag back to the build variable. Storage can be
 * unavailable (private mode), in which case the switch simply does not stick.
 */
export const setFlagOverride = (key: string, value: boolean | null): void => {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value ? '1' : '0');
    } catch {
        // Nothing to do about it, and nothing worth breaking the page over.
    }
};
