/**
 * The browser half of push-to-talk: what to record, how to package it, and what
 * to say when the microphone is not available. Kept apart from the React hook so
 * the decisions are testable without a DOM.
 */

/** Containers we would like, best first. Opus in WebM is what the route expects. */
export const PREFERRED_MIME_TYPES = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
];

export const pickRecordingMimeType = (isSupported: (type: string) => boolean): string | null =>
    PREFERRED_MIME_TYPES.find(isSupported) ?? null;

/** The best available container, or null when this browser cannot record at all. */
export const recordingMimeType = (): string | null => {
    if (typeof MediaRecorder === 'undefined') return null;
    return pickRecordingMimeType((type) => MediaRecorder.isTypeSupported(type));
};

/** Strip the `data:…;base64,` prefix a FileReader adds. */
export const stripDataUrlPrefix = (dataUrl: string): string => {
    const comma = dataUrl.indexOf(',');
    return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
};

export const blobToBase64 = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error('could not read the recording'));
        reader.onloadend = () => {
            resolve(stripDataUrlPrefix(typeof reader.result === 'string' ? reader.result : ''));
        };
        reader.readAsDataURL(blob);
    });

/** A recording this short is a mis-click, not a question. */
export const MIN_RECORDING_BYTES = 1200;

const errorName = (error: unknown): string =>
    typeof error === 'object' && error !== null && 'name' in error
        ? String((error as { name: unknown }).name)
        : '';

/** What to put on screen when the microphone could not be used. */
export const micErrorMessage = (error: unknown): string => {
    switch (errorName(error)) {
        case 'NotAllowedError':
        case 'SecurityError':
            return 'Microphone blocked — allow it for this page and try again.';
        case 'NotFoundError':
        case 'DevicesNotFoundError':
            return 'No microphone found.';
        case 'NotReadableError':
            return 'The microphone is in use by another application.';
        default:
            return 'Could not start recording.';
    }
};
