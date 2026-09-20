import { describe, expect, it } from 'vitest';
import {
    DAMPER,
    PEDAL_CONTROLLERS,
    SOFT,
    SOSTENUTO,
    controlKey,
    decodeChannelMessage,
    encodeChannelMessage,
    pitchKey,
    releaseFor,
    type ChannelMessage,
} from './midiMessage';

const bytes = (...data: number[]) => new Uint8Array(data);

describe('decoding', () => {
    it('reads a strike', () => {
        expect(decodeChannelMessage(bytes(0x92, 60, 64))).toEqual<ChannelMessage>({
            kind: 'noteOn',
            channel: 2,
            note: 60,
            velocity: 64,
        });
    });

    it('reads a strike at velocity 0 as the release it is', () => {
        expect(decodeChannelMessage(bytes(0x90, 60, 0))).toEqual<ChannelMessage>({
            kind: 'noteOff',
            channel: 0,
            note: 60,
            velocity: 0,
        });
    });

    it('keeps the release velocity of a real note-off', () => {
        expect(decodeChannelMessage(bytes(0x80, 60, 37))).toEqual<ChannelMessage>({
            kind: 'noteOff',
            channel: 0,
            note: 60,
            velocity: 37,
        });
    });

    it('reads a pedal move', () => {
        expect(decodeChannelMessage(bytes(0xb0, DAMPER, 87))).toEqual<ChannelMessage>({
            kind: 'control',
            channel: 0,
            controller: DAMPER,
            value: 87,
        });
    });

    it('declines what this path does not model, rather than guessing', () => {
        expect(decodeChannelMessage(bytes(0xc0, 0))).toBeNull(); // program change
        expect(decodeChannelMessage(bytes(0xe0, 0, 64))).toBeNull(); // pitch bend
        expect(decodeChannelMessage(bytes(0xf8))).toBeNull(); // clock
        expect(decodeChannelMessage(bytes(0x90, 60))).toBeNull(); // truncated
    });
});

describe('encoding', () => {
    it('round-trips every message it models', () => {
        const messages: ChannelMessage[] = [
            { kind: 'noteOn', channel: 0, note: 60, velocity: 41 },
            { kind: 'noteOff', channel: 3, note: 77, velocity: 12 },
            { kind: 'control', channel: 0, controller: SOFT, value: 127 },
        ];
        messages.forEach((message) =>
            expect(decodeChannelMessage(encodeChannelMessage(message))).toEqual(message),
        );
    });

    it('writes a note-off as 0x80, never as a strike at velocity 0', () => {
        const off: ChannelMessage = { kind: 'noteOff', channel: 0, note: 60, velocity: 0 };
        expect([...encodeChannelMessage(off)]).toEqual([0x80, 60, 0]);
    });
});

describe('identities', () => {
    it('gives a strike and its release the same key, and keeps channels apart', () => {
        const strike = { kind: 'noteOn', channel: 0, note: 60, velocity: 90 } as const;
        expect(pitchKey(releaseFor(strike))).toBe(pitchKey(strike));
        expect(pitchKey({ ...strike, channel: 1 })).not.toBe(pitchKey(strike));
    });

    it('keeps the three pedals apart', () => {
        const keys = PEDAL_CONTROLLERS.map((controller) =>
            controlKey({ kind: 'control', channel: 0, controller, value: 0 }),
        );
        expect(new Set(keys).size).toBe(3);
        expect(PEDAL_CONTROLLERS).toEqual([DAMPER, SOSTENUTO, SOFT]);
    });
});
