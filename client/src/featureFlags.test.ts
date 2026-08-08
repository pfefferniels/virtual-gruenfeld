import { afterEach, describe, expect, it, vi } from 'vitest';

import { isAgenticTeacher, isVoiceTeacher, TEACHER_AGENTIC_KEY, TEACHER_VOICE_KEY } from './featureFlags';

/** A localStorage that only knows the keys a test puts in it. */
const withStorage = (entries: Record<string, string>) =>
    vi.stubGlobal('localStorage', { getItem: (key: string) => entries[key] ?? null });

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
