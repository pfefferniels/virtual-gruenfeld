import { describe, expect, it } from 'vitest';

import {
    micErrorMessage,
    pickRecordingMimeType,
    PREFERRED_MIME_TYPES,
    stripDataUrlPrefix,
} from './voiceInput';

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
