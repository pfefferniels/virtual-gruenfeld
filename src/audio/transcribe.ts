import { toFile } from 'openai';

import { openai, OUTPUT_LANGUAGE } from '../config';

/**
 * Speech-to-text for the push-to-talk question. Pinned to the transcription
 * model current at 2026-07-27; `gpt-live-transcribe` is its streaming sibling
 * and would only pay off once the answer streams too (see FUTURE.md).
 */
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-transcribe';

/** Naming the language up front buys accuracy and a little latency. */
const LANGUAGE_CODES: Record<string, string> = {
    german: 'de',
    english: 'en',
    french: 'fr',
    italian: 'it',
    spanish: 'es',
};

const transcribeLanguage = (): string | undefined =>
    process.env.OPENAI_TRANSCRIBE_LANGUAGE || LANGUAGE_CODES[OUTPUT_LANGUAGE.trim().toLowerCase()];

/**
 * The API reads the container from the filename, so the browser's mime type has
 * to become an extension. MediaRecorder sends `audio/webm;codecs=opus`, which is
 * accepted as-is — anything unrecognised is sent as webm rather than refused,
 * since the API's own sniffing is the better judge.
 */
const EXTENSIONS: Record<string, string> = {
    'audio/webm': 'webm',
    'video/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'mp4',
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/flac': 'flac',
};

export const audioExtension = (mimeType: string): string =>
    EXTENSIONS[mimeType.split(';')[0].trim().toLowerCase()] ?? 'webm';

export type QuestionAudio = {
    /** The recording, base64-encoded. */
    data: string;
    /** What the recorder said it produced, e.g. `audio/webm;codecs=opus`. */
    mimeType: string;
};

/** The spoken question as text, or '' when nothing intelligible was said. */
export const transcribeQuestion = async (audio: QuestionAudio): Promise<string> => {
    const file = await toFile(
        Buffer.from(audio.data, 'base64'),
        `question.${audioExtension(audio.mimeType)}`,
        { type: audio.mimeType },
    );

    const language = transcribeLanguage();
    const result = await openai.audio.transcriptions.create({
        file,
        model: TRANSCRIBE_MODEL,
        ...(language ? { language } : {}),
    });

    return (result.text ?? '').trim();
};
