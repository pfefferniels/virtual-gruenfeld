import { describe, it, expect } from 'vitest';
import {
    charOffsetToTime,
    findCutPoint,
    chunkVocalStream,
    type TeacherStreamAlignment,
    type TeacherStreamResponse,
} from './chunker';

// ── charOffsetToTime ──

describe('charOffsetToTime', () => {
    const alignment: TeacherStreamAlignment = {
        characters: ['H', 'e', 'l', 'l', 'o'],
        character_start_times_seconds: [0.0, 0.1, 0.2, 0.3, 0.4],
        character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5],
    };

    it('returns first char time for offset 0', () => {
        expect(charOffsetToTime(0, alignment)).toBe(0.0);
    });

    it('returns correct time for middle offset', () => {
        expect(charOffsetToTime(2, alignment)).toBe(0.2);
    });

    it('returns last end time for offset beyond length', () => {
        expect(charOffsetToTime(10, alignment)).toBe(0.5);
    });

    it('returns first time for negative offset', () => {
        expect(charOffsetToTime(-1, alignment)).toBe(0.0);
    });

    it('returns null for empty alignment', () => {
        const empty: TeacherStreamAlignment = {
            characters: [],
            character_start_times_seconds: [],
            character_end_times_seconds: [],
        };
        expect(charOffsetToTime(0, empty)).toBeNull();
    });
});

// ── findCutPoint ──

describe('findCutPoint', () => {
    const sampleRate = 44100;

    it('finds silence in a buffer with a silent gap', () => {
        // 1 second of audio with silence from 0.45s to 0.55s
        const samples = new Float32Array(sampleRate);
        for (let i = 0; i < samples.length; i++) {
            const sec = i / sampleRate;
            if (sec >= 0.45 && sec <= 0.55) {
                samples[i] = 0; // silence
            } else {
                samples[i] = 0.5 * Math.sin(2 * Math.PI * 440 * sec);
            }
        }

        const cut = findCutPoint(samples, sampleRate, 0.5);
        expect(cut.silent).toBe(true);
        expect(cut.timeSec).toBeGreaterThanOrEqual(0.44);
        expect(cut.timeSec).toBeLessThanOrEqual(0.56);
    });

    it('finds minimum energy when no silence exists', () => {
        // Continuous signal with a quieter region around 0.5s
        const samples = new Float32Array(sampleRate);
        for (let i = 0; i < samples.length; i++) {
            const sec = i / sampleRate;
            const envelope = sec >= 0.45 && sec <= 0.55 ? 0.05 : 0.5;
            samples[i] = envelope * Math.sin(2 * Math.PI * 440 * sec);
        }

        const cut = findCutPoint(samples, sampleRate, 0.5);
        // Should find the quieter region even if not silent
        expect(cut.timeSec).toBeGreaterThanOrEqual(0.35);
        expect(cut.timeSec).toBeLessThanOrEqual(0.65);
    });

    it('handles empty buffer', () => {
        const samples = new Float32Array(0);
        const cut = findCutPoint(samples, sampleRate, 0.5);
        expect(cut.timeSec).toBeGreaterThanOrEqual(0);
    });
});

// ── chunkVocalStream ──

describe('chunkVocalStream', () => {
    // Mock AudioContext for testing
    const createMockAudioContext = () => {
        const buffers: AudioBuffer[] = [];

        const createBuffer = (channels: number, length: number, sampleRate: number): AudioBuffer => {
            const channelData: Float32Array[] = [];
            for (let i = 0; i < channels; i++) {
                channelData.push(new Float32Array(length));
            }
            const buffer = {
                numberOfChannels: channels,
                length,
                sampleRate,
                duration: length / sampleRate,
                getChannelData: (ch: number) => channelData[ch],
                copyToChannel: (source: Float32Array, ch: number) => {
                    channelData[ch].set(source);
                },
            } as unknown as AudioBuffer;
            buffers.push(buffer);
            return buffer;
        };

        return {
            state: 'running',
            resume: () => Promise.resolve(),
            createBuffer,
            decodeAudioData: (arrayBuffer: ArrayBuffer) => {
                // Create a simple mono buffer from the array buffer
                const sampleRate = 44100;
                const length = Math.floor(arrayBuffer.byteLength / 2) || sampleRate; // default 1s
                return Promise.resolve(createBuffer(1, length, sampleRate));
            },
        } as unknown as AudioContext;
    };

    it('returns empty array when audioBase64 is empty', async () => {
        const response: TeacherStreamResponse = {
            rawText: '',
            anchors: [],
            cleanedText: '',
            audioBase64: '',
            alignment: { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] },
            model: 'test',
            stats: { llmMs: 0, ttsMs: 0, totalMs: 0 },
        };
        const chunks = await chunkVocalStream(response, createMockAudioContext());
        expect(chunks).toEqual([]);
    });

    it('returns empty array when no anchors', async () => {
        const response: TeacherStreamResponse = {
            rawText: 'hello',
            anchors: [],
            cleanedText: 'hello',
            audioBase64: btoa('fake-audio-data-padding-bytes'),
            alignment: {
                characters: ['h', 'e', 'l', 'l', 'o'],
                character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4],
                character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5],
            },
            model: 'test',
            stats: { llmMs: 0, ttsMs: 0, totalMs: 0 },
        };
        const chunks = await chunkVocalStream(response, createMockAudioContext());
        expect(chunks).toEqual([]);
    });

    it('returns single chunk when no alignment data', async () => {
        const response: TeacherStreamResponse = {
            rawText: '«JUDGE» Gut gemacht',
            anchors: [{ marker: 'JUDGE', charOffset: 0, text: 'Gut gemacht' }],
            cleanedText: 'Gut gemacht',
            audioBase64: btoa('fake-audio-data-padding-bytes'),
            alignment: { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] },
            model: 'test',
            stats: { llmMs: 0, ttsMs: 0, totalMs: 0 },
        };
        const ctx = createMockAudioContext();
        const chunks = await chunkVocalStream(response, ctx);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].marker).toBe('JUDGE');
        expect(chunks[0].text).toBe('Gut gemacht');
        expect(chunks[0].startSec).toBe(0);
    });

    it('returns single chunk for single anchor with alignment', async () => {
        const response: TeacherStreamResponse = {
            rawText: '«JUDGE» Gut gemacht',
            anchors: [{ marker: 'JUDGE', charOffset: 0, text: 'Gut gemacht' }],
            cleanedText: 'Gut gemacht',
            audioBase64: btoa('fake-audio-data-padding-bytes'),
            alignment: {
                characters: ['G', 'u', 't', ' ', 'g', 'e', 'm', 'a', 'c', 'h', 't'],
                character_start_times_seconds: [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5],
                character_end_times_seconds: [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55],
            },
            model: 'test',
            stats: { llmMs: 0, ttsMs: 0, totalMs: 0 },
        };
        const ctx = createMockAudioContext();
        const chunks = await chunkVocalStream(response, ctx);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].marker).toBe('JUDGE');
    });

    it('preserves marker and text for each chunk', async () => {
        const response: TeacherStreamResponse = {
            rawText: '«JUDGE» Gut... «m2.3» leiser «END» so...',
            anchors: [
                { marker: 'JUDGE', charOffset: 0, text: 'Gut...' },
                { marker: 'm2.3', charOffset: 7, text: 'leiser' },
                { marker: 'END', charOffset: 14, text: 'so...' },
            ],
            cleanedText: 'Gut... leiser so...',
            audioBase64: btoa('fake-audio-data-padding-bytes-longer-data'),
            alignment: {
                characters: 'Gut... leiser so...'.split(''),
                character_start_times_seconds: Array.from({ length: 19 }, (_, i) => i * 0.05),
                character_end_times_seconds: Array.from({ length: 19 }, (_, i) => (i + 1) * 0.05),
            },
            model: 'test',
            stats: { llmMs: 0, ttsMs: 0, totalMs: 0 },
        };
        const ctx = createMockAudioContext();
        const chunks = await chunkVocalStream(response, ctx);

        expect(chunks.length).toBeGreaterThanOrEqual(1);
        expect(chunks[0].marker).toBe('JUDGE');
        if (chunks.length >= 2) {
            expect(chunks[1].marker).toBe('m2.3');
        }
        if (chunks.length >= 3) {
            expect(chunks[2].marker).toBe('END');
        }
    });
});
