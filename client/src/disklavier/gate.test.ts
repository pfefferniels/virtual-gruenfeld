import { describe, expect, it } from 'vitest';
import { DAMPER, encodeChannelMessage } from './midiMessage';
import { createEchoGuard } from './echo';
import {
    LIVE_SILENT_PRESSES,
    createInputGate,
    type InputGate,
    type SilentPressPolicy,
} from './gate';

const bytes = (...data: number[]) => new Uint8Array(data);

const SOUNDS = LIVE_SILENT_PRESSES.minSoundingVelocity;

const openGate = (policy: SilentPressPolicy = LIVE_SILENT_PRESSES): InputGate =>
    createInputGate(createEchoGuard(), policy);

describe('the app’s own playing', () => {
    it('is not taken for the student’s', () => {
        const echo = createEchoGuard();
        const gate = createInputGate(echo);
        const move = { kind: 'control', channel: 0, controller: DAMPER, value: 87 } as const;

        echo.expect(move, 1000);
        expect(gate.accepts(encodeChannelMessage(move), 1200)).toBe(false);
    });

    it('leaves the student’s own pedalling alone', () => {
        const gate = openGate();
        expect(gate.accepts(bytes(0xb0, DAMPER, 87), 1200)).toBe(true);
    });
});

describe('keys that never sounded', () => {
    it('drops a press below the sounding floor', () => {
        const gate = openGate();
        expect(gate.accepts(bytes(0x90, 60, SOUNDS - 1), 0)).toBe(false);
    });

    it('drops its release too, so the take holds no stray note-off', () => {
        const gate = openGate();
        gate.accepts(bytes(0x90, 60, SOUNDS - 1), 0);
        expect(gate.accepts(bytes(0x80, 60, 0), 100)).toBe(false);
    });

    it('drops a release written as a strike at velocity 0 just the same', () => {
        const gate = openGate();
        gate.accepts(bytes(0x90, 60, SOUNDS - 1), 0);
        expect(gate.accepts(bytes(0x90, 60, 0), 100)).toBe(false);
    });

    it('keeps a press that sounded, and its release', () => {
        const gate = openGate();
        expect(gate.accepts(bytes(0x90, 60, SOUNDS), 0)).toBe(true);
        expect(gate.accepts(bytes(0x80, 60, 0), 100)).toBe(true);
    });

    it('keeps the release of a key struck before the silent one, by key', () => {
        const gate = openGate();
        gate.accepts(bytes(0x90, 64, 80), 0);
        gate.accepts(bytes(0x90, 60, SOUNDS - 1), 10);
        expect(gate.accepts(bytes(0x80, 64, 0), 100)).toBe(true);
        expect(gate.accepts(bytes(0x80, 60, 0), 110)).toBe(false);
    });

    it('lets everything through when the instrument turns out not to send them', () => {
        const gate = openGate({ ...LIVE_SILENT_PRESSES, enabled: false });
        expect(gate.accepts(bytes(0x90, 60, 1), 0)).toBe(true);
    });

    it('takes the floor it is given, so a measured one can replace the timid default', () => {
        const gate = openGate({ enabled: true, minSoundingVelocity: 20 });
        expect(gate.accepts(bytes(0x90, 60, 19), 0)).toBe(false);
        expect(gate.accepts(bytes(0x90, 62, 20), 0)).toBe(true);
    });
});

describe('what the gate does not judge', () => {
    it('passes a message it does not model rather than dropping it', () => {
        const gate = openGate();
        expect(gate.accepts(bytes(0xe0, 0, 64), 0)).toBe(true);
        expect(gate.accepts(bytes(0xf8), 0)).toBe(true);
    });
});
