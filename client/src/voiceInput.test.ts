import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    armAutoStop,
    MAX_RECORDING_MS,
    micErrorMessage,
    pickRecordingMimeType,
    PREFERRED_MIME_TYPES,
    stripDataUrlPrefix,
} from './voiceInput';

describe('max recording length', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('stops a recording that runs past the limit', () => {
        const stop = vi.fn();
        armAutoStop(stop);

        vi.advanceTimersByTime(MAX_RECORDING_MS - 1);
        expect(stop).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('leaves a normal, released recording alone', () => {
        const stop = vi.fn();
        const cancel = armAutoStop(stop);

        // The button came up after four seconds, as it usually does.
        vi.advanceTimersByTime(4000);
        cancel();

        vi.advanceTimersByTime(MAX_RECORDING_MS * 2);
        expect(stop).not.toHaveBeenCalled();
    });

    it('does not mind being cancelled after it has already fired', () => {
        const stop = vi.fn();
        const cancel = armAutoStop(stop);

        vi.advanceTimersByTime(MAX_RECORDING_MS);
        expect(() => cancel()).not.toThrow();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('is long enough for a real question and short of the body limit', () => {
        // Opus in webm is ~4kB/s, so 30s is ~120kB — the route accepts 10mb.
        expect(MAX_RECORDING_MS).toBeGreaterThanOrEqual(15_000);
        expect(MAX_RECORDING_MS).toBeLessThanOrEqual(60_000);
    });
});

describe('recording container', () => {
    it('takes opus in webm when the browser has it', () => {
        expect(pickRecordingMimeType(() => true)).toBe('audio/webm;codecs=opus');
    });

    it('falls back through the list', () => {
        expect(pickRecordingMimeType((type) => type === 'audio/mp4')).toBe('audio/mp4');
        expect(pickRecordingMimeType((type) => !type.includes('codecs'))).toBe('audio/webm');
    });

    it('reports that nothing fits rather than guessing', () => {
        expect(pickRecordingMimeType(() => false)).toBeNull();
    });

    it('offers only containers the transcription API accepts', () => {
        for (const type of PREFERRED_MIME_TYPES) {
            expect(type).toMatch(/^audio\/(webm|mp4|ogg)/);
        }
    });
});

describe('recording payload', () => {
    it('drops the data-url header a FileReader prepends', () => {
        expect(stripDataUrlPrefix('data:audio/webm;base64,AAAABBBB')).toBe('AAAABBBB');
    });

    it('leaves bare base64 alone', () => {
        expect(stripDataUrlPrefix('AAAABBBB')).toBe('AAAABBBB');
        expect(stripDataUrlPrefix('')).toBe('');
    });
});

describe('microphone failures', () => {
    it('tells the student what to do about a refused microphone', () => {
        expect(micErrorMessage({ name: 'NotAllowedError' })).toContain('allow it for this page');
        expect(micErrorMessage({ name: 'NotFoundError' })).toBe('No microphone found.');
        expect(micErrorMessage({ name: 'NotReadableError' })).toContain('in use by another application');
    });

    it('has something to say about anything else', () => {
        expect(micErrorMessage(new Error('boom'))).toBe('Could not start recording.');
        expect(micErrorMessage(undefined)).toBe('Could not start recording.');
        expect(micErrorMessage('nope')).toBe('Could not start recording.');
    });
});
