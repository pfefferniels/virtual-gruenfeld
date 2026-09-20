import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { perform } from '../services/mpmRenderer';
import { createTestTiming } from './clock';
import { createDisklavier, type Disklavier, type DisklavierOptions } from './disklavier';
import { MIDI_IN_DELAY_MS } from './demonstrate';
import { LIVE_ECHO } from './echo';
import { DAMPER, decodeChannelMessage, encodeChannelMessage } from './midiMessage';
import { planDemonstration } from './plan';
import { createFakeMidiPort, type FakeMidiPort } from './port';

const load = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const mei = load('../../public/score.mei');
const mpm = load('../../public/performance.mpm');

/** One bar of Grünfeld, which is about the length of fragment the design calls for. */
const fragment = planDemonstration(perform(mei, mpm, { from: 0, to: 2880 })!);

type Rig = {
    readonly instrument: Disklavier;
    readonly port: FakeMidiPort;
    readonly timing: ReturnType<typeof createTestTiming>;
};

const rig = (overrides: Partial<DisklavierOptions> = {}): Rig => {
    const timing = createTestTiming();
    const port = createFakeMidiPort(timing.now);
    return { timing, port, instrument: createDisklavier({ port, timing, ...overrides }) };
};

const pedalMovesSent = (port: FakeMidiPort) =>
    port.sent.flatMap(({ data, atMs }) => {
        const message = decodeChannelMessage(data);
        return message?.kind === 'control' ? [{ message, atMs }] : [];
    });

describe('one instrument, two directions', () => {
    it('does not read its own pedalling back as the student’s', () => {
        const { instrument, port, timing } = rig();
        instrument.demonstrate(fragment, 1000);
        timing.advance(2000);

        const moves = pedalMovesSent(port);
        expect(moves.length).toBeGreaterThan(0);

        // The reflection arrives when the delay has run, which is where the window is widest.
        const reflected = moves.every(
            ({ message, atMs }) =>
                !instrument.accepts(encodeChannelMessage(message), atMs + LIVE_ECHO.delayMs),
        );
        expect(reflected).toBe(true);
    });

    it('still hears the student pedalling through it', () => {
        const { instrument, port, timing } = rig();
        instrument.demonstrate(fragment, 1000);
        timing.advance(2000);

        const [first] = pedalMovesSent(port);
        const bytes = encodeChannelMessage(first.message);
        expect(instrument.accepts(bytes, first.atMs)).toBe(false);
        // The expectation is consumed, so the same move again is somebody's foot.
        expect(instrument.accepts(bytes, first.atMs + 1)).toBe(true);
    });

    it('hears a pedal position it never sent', () => {
        const { instrument, timing } = rig();
        instrument.demonstrate(fragment, 1000);
        timing.advance(2000);
        expect(instrument.accepts(new Uint8Array([0xb0, DAMPER, 3]), 1500)).toBe(true);
    });
});

describe('who is playing', () => {
    it('stops the fragment in hand before starting another', () => {
        const { instrument, port, timing } = rig();
        instrument.demonstrate(fragment, 1000);
        timing.advance(1000);
        const before = port.sent.length;

        instrument.demonstrate(fragment, 6000);
        const releases = port.sent
            .slice(before)
            .flatMap(({ data }) => decodeChannelMessage(data) ?? []);
        expect(releases.some((message) => message.kind === 'noteOff')).toBe(true);
    });

    it('takes the hands off on request', () => {
        const { instrument, port, timing } = rig();
        instrument.demonstrate(fragment, 1000);
        timing.advance(300);
        const before = port.sent.length;

        instrument.silence();
        expect(port.sent.length).toBeGreaterThan(before);
    });

    it('answers at the lead the instrument needs', () => {
        const { instrument, port, timing } = rig();
        instrument.demonstrate(fragment, 1000);
        timing.advance(400);
        expect(Math.min(...port.sent.map(({ atMs }) => atMs))).toBe(1000 - MIDI_IN_DELAY_MS);
    });

    it('takes no lead at all where the delay is switched off at the front panel', () => {
        const { instrument, port, timing } = rig({ leadMs: 0 });
        instrument.demonstrate(fragment, 1000);
        timing.advance(800);
        expect(Math.min(...port.sent.map(({ atMs }) => atMs))).toBe(1000);
    });
});
