import { describe, expect, it } from 'vitest';
import type { MidiFile } from 'midifile-ts';
import { appendMidiWithOffset, millisecondsToMidiTicks, offsetCueTimes } from './midiSequence';

describe('appendMidiWithOffset', () => {
    it('keeps the second MIDI on the same continuous timeline', () => {
        const first: MidiFile = {
            header: { formatType: 1, trackCount: 2, ticksPerBeat: 720 },
            tracks: [
                [
                    { deltaTime: 0, type: 'meta', subtype: 'setTempo', microsecondsPerBeat: 500000 },
                    { deltaTime: 0, type: 'meta', subtype: 'endOfTrack' },
                ],
                [
                    { deltaTime: 0, type: 'channel', channel: 0, subtype: 'noteOn', noteNumber: 60, velocity: 64 },
                    { deltaTime: 720, type: 'channel', channel: 0, subtype: 'noteOff', noteNumber: 60, velocity: 0 },
                    { deltaTime: 0, type: 'meta', subtype: 'endOfTrack' },
                ],
            ],
        };
        const second: MidiFile = {
            header: { formatType: 1, trackCount: 2, ticksPerBeat: 720 },
            tracks: [
                [
                    { deltaTime: 0, type: 'meta', subtype: 'setTempo', microsecondsPerBeat: 600000 },
                    { deltaTime: 0, type: 'meta', subtype: 'endOfTrack' },
                ],
                [
                    { deltaTime: 0, type: 'channel', channel: 0, subtype: 'noteOn', noteNumber: 64, velocity: 64 },
                    { deltaTime: 360, type: 'channel', channel: 0, subtype: 'noteOff', noteNumber: 64, velocity: 0 },
                    { deltaTime: 0, type: 'meta', subtype: 'endOfTrack' },
                ],
            ],
        };

        const merged = appendMidiWithOffset(first, second, 1080);

        expect(merged.header.trackCount).toBe(2);
        expect(merged.tracks[0]).toEqual([
            { deltaTime: 0, type: 'meta', subtype: 'setTempo', microsecondsPerBeat: 500000 },
            { deltaTime: 1080, type: 'meta', subtype: 'setTempo', microsecondsPerBeat: 600000 },
            { deltaTime: 0, type: 'meta', subtype: 'endOfTrack' },
        ]);
        expect(merged.tracks[1]).toEqual([
            { deltaTime: 0, type: 'channel', channel: 0, subtype: 'noteOn', noteNumber: 60, velocity: 64 },
            { deltaTime: 720, type: 'channel', channel: 0, subtype: 'noteOff', noteNumber: 60, velocity: 0 },
            { deltaTime: 360, type: 'channel', channel: 0, subtype: 'noteOn', noteNumber: 64, velocity: 64 },
            { deltaTime: 360, type: 'channel', channel: 0, subtype: 'noteOff', noteNumber: 64, velocity: 0 },
            { deltaTime: 0, type: 'meta', subtype: 'endOfTrack' },
        ]);
    });
});

describe('offsetCueTimes', () => {
    it('shifts cue scheduling onto the combined timeline', () => {
        expect(offsetCueTimes([{ atSec: 0.5, id: 'a' }], 1.25)).toEqual([{ atSec: 1.75, id: 'a' }]);
    });
});

describe('millisecondsToMidiTicks', () => {
    it('uses the rendered MIDI tempo map instead of a hard-coded conversion', () => {
        const midi: MidiFile = {
            header: { formatType: 1, trackCount: 1, ticksPerBeat: 720 },
            tracks: [[
                { deltaTime: 0, type: 'meta', subtype: 'setTempo', microsecondsPerBeat: 720000 },
                { deltaTime: 0, type: 'meta', subtype: 'endOfTrack' },
            ]],
        };

        expect(millisecondsToMidiTicks(midi, 2560)).toBe(2560);
    });
});
