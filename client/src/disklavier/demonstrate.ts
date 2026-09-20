/**
 * Playing a fragment on the instrument the student is sitting at.
 *
 * **The 500 ms lead.** Yamaha's MIDI IN Delay makes a strike land a documented 500 ms after the
 * bytes arrive, and exists to remove the velocity-dependent spread in when a note sounds. For a
 * project whose claim is that the timing is right, that is worth having, so every message is
 * handed over 500 ms before it is wanted. The delay is uniform, so the fragment's own relative
 * timing survives it untouched.
 *
 * **Why a slice at a time.** A message given a future timestamp is scheduled by CoreMIDI, not by a
 * JavaScript timer, and cannot afterwards be recalled — Web MIDI has no way to take it back. Handing
 * the fragment over in slices is what keeps a demonstration stoppable: `stop` drops the rest of the
 * queue and releases what has already gone, so at worst the instrument plays on to the edge of the
 * look-ahead and then lifts, like a pianist taking their hands off.
 *
 * **What a stop releases.** Exactly the keys this fragment struck and the pedals it moved, tracked
 * one by one, rather than All Notes Off and a blanket CC64 of zero. Both instruments are the same
 * instrument, and the student may be holding keys and the pedal throughout; releasing only what is
 * ours is the one part of that distinction the software can actually make.
 *
 * **What a late commit costs.** A strike whose moment has passed is dropped rather than played
 * late, and its release goes with it (Aria-Duet's rule). A release or a pedal position is state
 * rather than an event, so a late one is sent at once instead: dropping a release would leave a key
 * down, and dropping a pedal move would leave the damper in a position the fragment never intended.
 */
import {
    controlKey,
    encodeChannelMessage,
    pitchKey,
    releaseFor,
    type ChannelMessage,
    type ControlMessage,
    type NoteMessage,
} from './midiMessage';
import { messagesOf, type DemonstrationPlan } from './plan';
import type { EchoGuard } from './echo';
import type { MidiPort } from './port';
import type { Timing } from './clock';

/** Documented by Yamaha: with MIDI IN Delay on, the strike lands this long after reception. */
export const MIDI_IN_DELAY_MS = 500;

/** How far ahead of its delivery time a message is handed to the OS. */
export const LOOKAHEAD_MS = 250;

/** How often the next slice is handed over. Shorter than the look-ahead, so a slow frame cannot starve it. */
export const PUMP_INTERVAL_MS = 100;

export type DemonstrationDeps = {
    readonly port: MidiPort;
    readonly timing: Timing;
    readonly echo: EchoGuard;
    readonly leadMs: number;
    readonly lookaheadMs: number;
    readonly pumpIntervalMs: number;
};

export type Demonstration = {
    /** Page-clock time at which the fragment's last release sounds. */
    readonly endsAtMs: number;
    /** Strikes left out because the fragment was committed too late to reach the instrument in time. */
    dropped(): number;
    /** Release what is sounding and hand nothing further over. Idempotent. */
    stop(): void;
};

type Scheduled = {
    /** Page-clock time at which the bytes must reach the instrument. */
    readonly sendAtMs: number;
    readonly message: ChannelMessage;
    readonly noteIndex: number | null;
};

const partition = <T>(items: readonly T[], holds: (item: T) => boolean): [T[], T[]] => [
    items.filter(holds),
    items.filter((item) => !holds(item)),
];

/** Of several overdue moves of one pedal, only the last says anything. */
const withoutSupersededControls = (late: readonly Scheduled[]): Scheduled[] => {
    const lastIndex = new Map<number, number>();
    late.forEach(({ message }, index) => {
        if (message.kind === 'control') lastIndex.set(controlKey(message), index);
    });
    return late.filter(
        ({ message }, index) =>
            message.kind !== 'control' || lastIndex.get(controlKey(message)) === index,
    );
};

export const startDemonstration = (
    { port, timing, echo, leadMs, lookaheadMs, pumpIntervalMs }: DemonstrationDeps,
    plan: DemonstrationPlan,
    startAtMs: number,
): Demonstration => {
    /** Page-clock time at which a message wanted at plan time 0 must reach the instrument. */
    const originMs = startAtMs - leadMs;

    let queue: Scheduled[] = messagesOf(plan).map(({ atMs, message, noteIndex }) => ({
        sendAtMs: originMs + atMs,
        message,
        noteIndex,
    }));

    /** Struck and not yet released, and pedals moved and not yet returned: what `stop` has to undo. */
    const sounding = new Map<number, NoteMessage>();
    const moved = new Map<number, ControlMessage>();
    const droppedNotes = new Set<number>();

    let cancelPump: (() => void) | null = null;
    let stopped = false;
    let lastHandedOverMs = -Infinity;

    const remember = (message: ChannelMessage): void => {
        if (message.kind === 'control') {
            moved.set(controlKey(message), message);
            return;
        }
        if (message.kind === 'noteOn') sounding.set(pitchKey(message), message);
        else sounding.delete(pitchKey(message));
    };

    const handOver = (message: ChannelMessage, atMs?: number): void => {
        port.send(encodeChannelMessage(message), atMs);
        const sentAtMs = atMs ?? timing.now();
        echo.expect(message, sentAtMs);
        lastHandedOverMs = Math.max(lastHandedOverMs, sentAtMs);
        remember(message);
    };

    const stillWorthSending = (entry: Scheduled, nowMs: number): boolean => {
        if (entry.noteIndex !== null && droppedNotes.has(entry.noteIndex)) return false;
        if (entry.sendAtMs >= nowMs) return true;
        if (entry.message.kind !== 'noteOn' || entry.noteIndex === null) return true;
        droppedNotes.add(entry.noteIndex);
        return false;
    };

    const pump = (): void => {
        cancelPump = null;
        if (stopped) return;

        const nowMs = timing.now();
        const [due, later] = partition(queue, (entry) => entry.sendAtMs < nowMs + lookaheadMs);
        queue = later;

        const sendable = due.filter((entry) => stillWorthSending(entry, nowMs));
        const [late, onTime] = partition(sendable, (entry) => entry.sendAtMs < nowMs);

        withoutSupersededControls(late).forEach(({ message }) => handOver(message));
        onTime.forEach(({ message, sendAtMs }) => handOver(message, sendAtMs));

        if (queue.length > 0) cancelPump = timing.defer(pumpIntervalMs, pump);
    };

    pump();

    return {
        endsAtMs: startAtMs + plan.endsAtMs,

        dropped: () => droppedNotes.size,

        stop() {
            if (stopped) return;
            stopped = true;
            cancelPump?.();
            cancelPump = null;
            queue = [];

            // Nothing handed over can be recalled, so the releases go after the last message that
            // was: they cut the fragment short rather than leaving a key or a pedal down.
            const releaseAtMs = Math.max(timing.now(), lastHandedOverMs + 1);
            [
                ...[...sounding.values()].map((strike) => releaseFor(strike)),
                ...[...moved.values()]
                    .filter((control) => control.value > 0)
                    .map((control): ControlMessage => ({ ...control, value: 0 })),
            ].forEach((message) => handOver(message, releaseAtMs));
        },
    };
};
