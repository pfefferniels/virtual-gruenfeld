import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    isAgenticTeacher, isVoiceTeacher, setFlagOverride,
    TEACHER_AGENTIC_KEY, TEACHER_VOICE_KEY,
} from './featureFlags';

/** A localStorage that only knows the keys a test puts in it. */
const withStorage = (entries: Record<string, string>) =>
    vi.stubGlobal('localStorage', { getItem: (key: string) => entries[key] ?? null });

/** A localStorage that can be written to, as the debug toggles write to it. */
const withWritableStorage = (entries: Record<string, string> = {}) => {
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => entries[key] ?? null,
        setItem: (key: string, value: string) => { entries[key] = value; },
        removeItem: (key: string) => { delete entries[key]; },
    });
    return entries;
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('feature flags', () => {
    it('are off when nothing turns them on', () => {
        vi.stubEnv('VITE_TEACHER_VOICE', '');
        vi.stubEnv('VITE_TEACHER_AGENTIC', '');
        expect(isVoiceTeacher()).toBe(false);
        expect(isAgenticTeacher()).toBe(false);
    });

    it('survive a page with no localStorage at all', () => {
        vi.stubEnv('VITE_TEACHER_VOICE', '1');
        // No stubGlobal: reading `localStorage` throws, as it does in private mode.
        expect(isVoiceTeacher()).toBe(true);
    });

    it('read the build variable', () => {
        vi.stubEnv('VITE_TEACHER_VOICE', '1');
        expect(isVoiceTeacher()).toBe(true);
        vi.stubEnv('VITE_TEACHER_VOICE', 'true');
        expect(isVoiceTeacher()).toBe(true);
        vi.stubEnv('VITE_TEACHER_VOICE', '0');
        expect(isVoiceTeacher()).toBe(false);
    });

    it('let the browser override the build in both directions', () => {
        vi.stubEnv('VITE_TEACHER_VOICE', '');
        withStorage({ [TEACHER_VOICE_KEY]: '1' });
        expect(isVoiceTeacher()).toBe(true);

        vi.stubEnv('VITE_TEACHER_VOICE', '1');
        withStorage({ [TEACHER_VOICE_KEY]: '0' });
        expect(isVoiceTeacher()).toBe(false);
    });

    it('can be switched from the page and read back', () => {
        vi.stubEnv('VITE_TEACHER_AGENTIC', '');
        const stored = withWritableStorage();

        setFlagOverride(TEACHER_AGENTIC_KEY, true);
        expect(stored[TEACHER_AGENTIC_KEY]).toBe('1');
        expect(isAgenticTeacher()).toBe(true);

        setFlagOverride(TEACHER_AGENTIC_KEY, false);
        expect(isAgenticTeacher()).toBe(false);
    });

    it('hand the flag back to the build when the override is dropped', () => {
        vi.stubEnv('VITE_TEACHER_VOICE', '1');
        const stored = withWritableStorage({ [TEACHER_VOICE_KEY]: '0' });
        expect(isVoiceTeacher()).toBe(false);

        setFlagOverride(TEACHER_VOICE_KEY, null);
        expect(stored[TEACHER_VOICE_KEY]).toBeUndefined();
        expect(isVoiceTeacher()).toBe(true);
    });

    it('do not break a page whose storage refuses to be written', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => null,
            setItem: () => { throw new Error('QuotaExceededError'); },
            removeItem: () => { throw new Error('QuotaExceededError'); },
        });
        expect(() => setFlagOverride(TEACHER_VOICE_KEY, true)).not.toThrow();
        expect(() => setFlagOverride(TEACHER_VOICE_KEY, null)).not.toThrow();
    });

    it('are independent of each other', () => {
        vi.stubEnv('VITE_TEACHER_VOICE', '');
        vi.stubEnv('VITE_TEACHER_AGENTIC', '');
        withStorage({ [TEACHER_VOICE_KEY]: '1' });
        expect(isVoiceTeacher()).toBe(true);
        expect(isAgenticTeacher()).toBe(false);

        withStorage({ [TEACHER_AGENTIC_KEY]: '1' });
        expect(isVoiceTeacher()).toBe(false);
        expect(isAgenticTeacher()).toBe(true);
    });
});
