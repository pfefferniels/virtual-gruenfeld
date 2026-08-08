/**
 * Agentic pedagogy: let the model decide what to demonstrate instead of always
 * playing the exaggerated counter-performance over the whole take.
 *
 * Off by default. `VITE_TEACHER_AGENTIC=1` turns it on for a build;
 * `localStorage.TEACHER_AGENTIC = '1' | '0'` overrides that per browser, so the
 * two paths can be compared live without a rebuild.
 */
export const TEACHER_AGENTIC_KEY = 'TEACHER_AGENTIC';

const isTruthy = (value: unknown): boolean =>
    value === '1' || value === 'true' || value === true;

export const isAgenticTeacher = (): boolean => {
    try {
        const override = localStorage.getItem(TEACHER_AGENTIC_KEY);
        if (override === '1') return true;
        if (override === '0') return false;
    } catch {
        // Private mode, or no DOM at all under vitest — fall through to the env.
    }
    return isTruthy(import.meta.env.VITE_TEACHER_AGENTIC);
};
