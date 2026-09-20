import { describe, expect, it } from 'vitest';
import { createTestTiming, type TestTiming } from './clock';
import { createFakeMidiPort, type FakeMidiPort } from './port';
import { DAMPER, decodeChannelMessage, type ChannelMessage, type ControlMessage } from './midiMessage';
import type { EchoGuard } from './echo';
import type { DemonstrationPlan, PlannedNote } from './plan';
import {
    LOOKAHEAD_MS,
    MIDI_IN_DELAY_MS,
    PUMP_INTERVAL_MS,
    startDemonstration,
    type DemonstrationDeps,
} from './demonstrate';

const note = (onAtMs: number, offAtMs: number, pitch = 60, velocity = 64): PlannedNote => ({
    channel: 0,
    note: pitch,
    velocity,
    releaseVelocity: 0,
    onAtMs,
    offAtMs,
});

const damper = (atMs: number, value: number): { atMs: number; message: ControlMessage } => ({
    atMs,
    message: { kind: 'control', channel: 0, controller: DAMPER, value },
});

const planOf = (
    notes: readonly PlannedNote[],
    pedal: readonly { atMs: number; message: ControlMessage }[] = [],
): DemonstrationPlan => ({
    notes,
    pedal,
    endsAtMs: Math.max(0, ...notes.map((n) => n.offAtMs), ...pedal.map((p) => p.atMs)),
});

type Expectation = { readonly message: ChannelMessage; readonly sentAtMs: number };

const recordingGuard = (): EchoGuard & { readonly expected: readonly Expectation[] } => {
    const expected: Expectation[] = [];
    return {
        expected,
        expect: (message, sentAtMs) => expected.push({ message, sentAtMs }),
        isEcho: () => false,
    };
};

type Rig = {
    readonly timing: TestTiming;
    readonly port: FakeMidiPort;
    readonly echo: ReturnType<typeof recordingGuard>;
    readonly deps: DemonstrationDeps;
};

const rig = (overrides: Partial<DemonstrationDeps> = {}): Rig => {
    const timing = createTestTiming();
    const port = createFakeMidiPort(timing.now);
    const echo = recordingGuard();
    return {
        timing,
        port,
        echo,
        deps: {
            port,
            timing,
            echo,
            leadMs: MIDI_IN_DELAY_MS,
            lookaheadMs: LOOKAHEAD_MS,
            pumpIntervalMs: PUMP_INTERVAL_MS,
            ...overrides,
        },
    };
};

type Seen = {
    readonly kind: ChannelMessage['kind'];
    /** The key for a note, the controller for a pedal move. */
    readonly target: number;
    /** The velocity for a note, the position for a pedal move. */
    readonly value: number;
    readonly atMs: number;
    readonly handedOverAtMs: number;
};

const seen = (port: FakeMidiPort): Seen[] =>
    port.sent.flatMap(({ data, atMs, handedOverAtMs }): Seen[] => {
        const message = decodeChannelMessage(data);
        if (!message) return [];
        return [
            {
                kind: message.kind,
                target: message.kind === 'control' ? message.controller : message.note,
                value: message.kind === 'control' ? message.value : message.velocity,
                atMs,
                handedOverAtMs,
            },
        ];
    });

describe('the 500 ms lead', () => {
    it('hands a strike over a whole MIDI IN Delay before it is to sound', () => {
        const { deps, port, timing } = rig();
        startDemonstration(deps, planOf([note(0, 200)]), 600);
        timing.advance(400);

        expect(seen(port).map(({ kind, atMs }) => [kind, atMs])).toEqual([
            ['noteOn', 600 - MIDI_IN_DELAY_MS],
            ['noteOff', 800 - MIDI_IN_DELAY_MS],
        ]);
    });

    it('keeps the fragment’s own timing, since the delay is the same for every message', () => {
        const { deps, port } = rig();
        startDemonstration(deps, planOf([note(0, 50), note(120, 170, 64)]), 600);

        const strikes = seen(port).filter(({ kind }) => kind === 'noteOn');
        expect(strikes[1].atMs - strikes[0].atMs).toBe(120);
    });

    it('answers when the fragment’s last release sounds', () => {
        const { deps } = rig();
        const demonstration = startDemonstration(deps, planOf([note(0, 900)]), 600);
        expect(demonstration.endsAtMs).toBe(1500);
    });
});

describe('a look-ahead at a time', () => {
    it('hands over only what falls inside the window, and the rest as it comes round', () => {
        const { deps, port, timing } = rig();
        startDemonstration(deps, planOf([note(0, 100), note(600, 700, 64)]), MIDI_IN_DELAY_MS);

        expect(seen(port)).toHaveLength(2);
        timing.advance(700);
        expect(seen(port)).toHaveLength(4);
    });

    it('stops pumping once the fragment is out', () => {
        const { deps, port, timing } = rig();
        startDemonstration(deps, planOf([note(0, 100)]), MIDI_IN_DELAY_MS);
        timing.advance(10_000);
        expect(seen(port)).toHaveLength(2);
    });
});

/**
 * Aria-Duet's rule. The configuration here pumps less often than it looks ahead, which is the
 * shape a blocked frame has: a slice arrives holding messages whose moment has already passed.
 */
describe('when the moment has passed', () => {
    const late: Partial<DemonstrationDeps> = { lookaheadMs: 50, pumpIntervalMs: 500 };

    it('drops a strike rather than playing it late, and its release with it', () => {
        const { deps, port, timing } = rig(late);
        const demonstration = startDemonstration(
            deps,
            planOf([note(0, 40), note(300, 400, 64)]),
            MIDI_IN_DELAY_MS,
        );
        timing.advance(500);

        expect(seen(port).map(({ target }) => target)).toEqual([60, 60]);
        expect(demonstration.dropped()).toBe(1);
    });

    it('sends an overdue release at once, because a dropped one leaves the key down', () => {
        const { deps, port, timing } = rig(late);
        startDemonstration(deps, planOf([note(0, 200)]), MIDI_IN_DELAY_MS);
        timing.advance(500);

        const release = seen(port).find(({ kind }) => kind === 'noteOff');
        expect(release?.atMs).toBe(500);
        expect(release?.handedOverAtMs).toBe(500);
    });

    it('sends an overdue pedal position at once, and only the last of them', () => {
        const { deps, port, timing } = rig(late);
        startDemonstration(
            deps,
            planOf([note(0, 40)], [damper(100, 127), damper(200, 64), damper(300, 20)]),
            MIDI_IN_DELAY_MS,
        );
        timing.advance(500);

        const moves = seen(port).filter(({ kind }) => kind === 'control');
        expect(moves.map(({ value }) => value)).toEqual([20]);
        expect(moves[0].handedOverAtMs).toBe(500);
    });

    it('counts nothing as dropped when the fragment is committed in time', () => {
        const { deps } = rig();
        const demonstration = startDemonstration(deps, planOf([note(0, 100)]), MIDI_IN_DELAY_MS);
        expect(demonstration.dropped()).toBe(0);
    });
});

describe('taking the hands off', () => {
    it('releases every key it struck, after the last message it has already let go of', () => {
        const { deps, port } = rig();
        startDemonstration(deps, planOf([note(0, 5000, 60), note(10, 5000, 64)]), 600).stop();

        const releases = seen(port).filter(({ kind }) => kind === 'noteOff');
        expect(releases.map(({ target }) => target).sort()).toEqual([60, 64]);
        // The strikes are already the OS's and cannot be recalled, so the releases go after them.
        expect(Math.min(...releases.map((r) => r.atMs))).toBe(110 + 1);
    });

    it('returns a pedal it put down', () => {
        const { deps, port } = rig();
        startDemonstration(deps, planOf([note(0, 5000)], [damper(0, 127)]), 600).stop();

        const moves = seen(port).filter(({ kind }) => kind === 'control');
        expect(moves.map(({ value }) => value)).toEqual([127, 0]);
    });

    it('says nothing about a key it never struck or a pedal it never moved', () => {
        const { deps, port } = rig();
        const demonstration = startDemonstration(deps, planOf([note(5000, 6000)]), 600);
        demonstration.stop();
        expect(seen(port)).toEqual([]);
    });

    it('sends nothing for a fragment that has already finished on its own', () => {
        const { deps, port, timing } = rig();
        const demonstration = startDemonstration(
            deps,
            planOf([note(0, 100)], [damper(0, 127), damper(400, 0)]),
            MIDI_IN_DELAY_MS,
        );
        timing.advance(2000);
        const before = seen(port).length;

        demonstration.stop();
        expect(seen(port)).toHaveLength(before);
    });

    it('is idempotent', () => {
        const { deps, port } = rig();
        const demonstration = startDemonstration(deps, planOf([note(0, 5000)]), 600);
        demonstration.stop();
        const after = seen(port).length;

        demonstration.stop();
        expect(seen(port)).toHaveLength(after);
    });

    it('hands nothing further over', () => {
        const { deps, port, timing } = rig();
        const demonstration = startDemonstration(
            deps,
            planOf([note(0, 100), note(2000, 2100, 64)]),
            MIDI_IN_DELAY_MS,
        );
        demonstration.stop();
        const after = seen(port).length;

        timing.advance(5000);
        expect(seen(port)).toHaveLength(after);
    });
});

describe('what the echo guard is told', () => {
    it('is every message sent, with the time the instrument receives it', () => {
        const { deps, port, echo } = rig();
        startDemonstration(deps, planOf([note(0, 200)], [damper(0, 127)]), 600);

        expect(echo.expected).toHaveLength(seen(port).length);
        expect(echo.expected.map(({ sentAtMs }) => sentAtMs)).toEqual(seen(port).map((m) => m.atMs));
    });

    it('includes the releases a stop sends, so they are not read back as the student’s', () => {
        const { deps, echo } = rig();
        startDemonstration(deps, planOf([note(0, 5000)]), 600).stop();

        expect(echo.expected.filter(({ message }) => message.kind === 'noteOff')).toHaveLength(1);
    });
});
