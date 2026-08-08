import { describe, expect, it } from 'vitest';

import { resolveTeacherUrl } from './api';

describe('resolveTeacherUrl', () => {
    it('uses the build variable, tidied', () => {
        expect(resolveTeacherUrl({ VITE_TEACHER_URL: 'https://api.welte225.org/teacher/' }))
            .toBe('https://api.welte225.org/teacher');
        expect(resolveTeacherUrl({ VITE_TEACHER_URL: '  https://api.welte225.org  ', DEV: true }))
            .toBe('https://api.welte225.org');
    });

    it('falls back to the local server only while developing', () => {
        expect(resolveTeacherUrl({ DEV: true })).toBe('http://localhost:3002');
        expect(resolveTeacherUrl({ VITE_TEACHER_URL: '', DEV: true })).toBe('http://localhost:3002');
    });

    it('leaves a production build without a URL rather than guessing localhost', () => {
        // Guessing costs every visitor six seconds of failing requests to a
        // server almost none of them are running.
        expect(resolveTeacherUrl({ DEV: false })).toBe('');
        expect(resolveTeacherUrl({})).toBe('');
        expect(resolveTeacherUrl({ VITE_TEACHER_URL: '   ', DEV: false })).toBe('');
    });

    it('lets one browser point itself at a teacher, whatever the build says', () => {
        // The documented way to run a local teacher against the deployed page.
        expect(resolveTeacherUrl({ DEV: false }, 'http://localhost:3002'))
            .toBe('http://localhost:3002');
        expect(resolveTeacherUrl({ VITE_TEACHER_URL: 'https://api.welte225.org' }, 'http://localhost:3002/'))
            .toBe('http://localhost:3002');
    });

    it('ignores an override that is empty or absent', () => {
        expect(resolveTeacherUrl({ VITE_TEACHER_URL: 'https://api.welte225.org' }, null))
            .toBe('https://api.welte225.org');
        expect(resolveTeacherUrl({ VITE_TEACHER_URL: 'https://api.welte225.org' }, '  '))
            .toBe('https://api.welte225.org');
        expect(resolveTeacherUrl({ DEV: true }, null)).toBe('http://localhost:3002');
    });
});
