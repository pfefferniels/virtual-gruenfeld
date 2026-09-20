import { describe, expect, it } from 'vitest';
import { DAMPER, SOFT, type ChannelMessage } from './midiMessage';
import { LIVE_ECHO, createEchoGuard, type EchoPolicy } from './echo';

const damper = (value: number): ChannelMessage => ({
    kind: 'control',
    channel: 0,
    controller: DAMPER,
    value,
});

const strike = (note: number, velocity = 64): ChannelMessage => ({
    kind: 'noteOn',
    channel: 0,
    note,
    velocity,
});

/** The far edge of the window: the bytes arrived, the delay ran, the reflection came back. */
const LATE = LIVE_ECHO.delayMs + LIVE_ECHO.slackMs;

describe('the window', () => {
    it('recognises a reflection that arrives with the bytes', () => {
        const guard = createEchoGuard();
        guard.expect(damper(87), 1000);
        expect(guard.isEcho(damper(87), 1000)).toBe(true);
    });

    it('recognises one that arrives a whole MIDI IN Delay later', () => {
        const guard = createEchoGuard();
        guard.expect(damper(87), 1000);
        expect(guard.isEcho(damper(87), 1000 + LIVE_ECHO.delayMs)).toBe(true);
    });

    it('lets through one that arrives after the window has closed', () => {
        const guard = createEchoGuard();
        guard.expect(damper(87), 1000);
        expect(guard.isEcho(damper(87), 1000 + LATE + 1)).toBe(false);
    });

    it('lets through one that arrives before the bytes could have', () => {
        const guard = createEchoGuard();
        guard.expect(damper(87), 1000);
        expect(guard.isEcho(damper(87), 1000 - LIVE_ECHO.slackMs - 1)).toBe(false);
    });
});

describe('what counts as the same message', () => {
    it('does not take a different pedal position for one of ours', () => {
        const guard = createEchoGuard();
        guard.expect(damper(87), 1000);
        expect(guard.isEcho(damper(86), 1000)).toBe(false);
    });

    it('keeps the pedals apart', () => {
        const guard = createEchoGuard();
        guard.expect(damper(127), 1000);
        expect(guard.isEcho({ kind: 'control', channel: 0, controller: SOFT, value: 127 }, 1000)).toBe(
            false,
        );
    });

    it('ignores velocity on a strike, since a reflection need not preserve the byte', () => {
        const guard = createEchoGuard({ ...LIVE_ECHO, notes: true });
        guard.expect(strike(60, 90), 1000);
        expect(guard.isEcho(strike(60, 12), 1000)).toBe(true);
    });

    it('does not take a release for the strike it belongs to', () => {
        const guard = createEchoGuard();
        guard.expect(strike(60), 1000);
        expect(guard.isEcho({ kind: 'noteOff', channel: 0, note: 60, velocity: 0 }, 1000)).toBe(false);
    });
});

describe('when the student pedals at the same moment', () => {
    it('consumes one expectation per reflection, so the second message gets through', () => {
        const guard = createEchoGuard();
        guard.expect(damper(87), 1000);
        expect(guard.isEcho(damper(87), 1010)).toBe(true);
        expect(guard.isEcho(damper(87), 1020)).toBe(false);
    });

    it('accounts for repeats of the same move separately', () => {
        const guard = createEchoGuard();
        guard.expect(damper(87), 1000);
        guard.expect(damper(87), 1100);
        expect(guard.isEcho(damper(87), 1050)).toBe(true);
        expect(guard.isEcho(damper(87), 1150)).toBe(true);
        expect(guard.isEcho(damper(87), 1160)).toBe(false);
    });
});

describe('the switches', () => {
    it('lets the pedal through when the instrument is known not to reflect it', () => {
        const policy: EchoPolicy = { ...LIVE_ECHO, pedal: false };
        const guard = createEchoGuard(policy);
        guard.expect(damper(87), 1000);
        expect(guard.isEcho(damper(87), 1000)).toBe(false);
    });

    it('filters strikes by default, because being wrong the other way costs the whole take', () => {
        const guard = createEchoGuard();
        guard.expect(strike(60), 1000);
        expect(guard.isEcho(strike(60), 1000)).toBe(true);
    });

    it('lets strikes through once the instrument is known not to reflect them', () => {
        const guard = createEchoGuard({ ...LIVE_ECHO, notes: false });
        guard.expect(strike(60), 1000);
        expect(guard.isEcho(strike(60), 1000)).toBe(false);
    });
});

describe('housekeeping', () => {
    it('forgets an expectation whose window has closed, so nothing accumulates over a lesson', () => {
        const guard = createEchoGuard();
        guard.expect(damper(87), 1000);
        // Any later message prunes it; the same move much later is then the student's.
        expect(guard.isEcho(damper(64), 1000 + LATE + 1)).toBe(false);
        expect(guard.isEcho(damper(87), 1000 + LATE + 2)).toBe(false);
    });
});
