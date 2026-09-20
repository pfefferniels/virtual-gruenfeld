/**
 * A rendered fragment, as the strikes and pedal moves an action can actually perform.
 *
 * Three things the MIDI a renderer writes does not account for and the instrument does.
 *
 * **A key must rise before it can strike again.** Where Grünfeld repeats a pitch, the earlier
 * release is moved earlier rather than the later strike later, so the gap is opened by moving a
 * future event and nothing is played late (the rule is Aria-Duet's). Over the whole
 * reconstruction 33 strikes fall on a key that is still down and 10 repeats leave under 30 ms
 * between release and strike, so this is not a hypothetical case.
 *
 * **A fragment is cut out of the middle of a performance**, so the last pedal position it inherits
 * is whatever the phrase happened to be holding. Every pedal the plan moved is returned to zero a
 * short tail after the last release, or the damper stays down until the next demonstration.
 *
 * **Two thirds of the control messages say nothing new.** 2,485 of the reconstruction's 3,786
 * repeat the value already in effect. Dropping them halves what a 31,250-baud bus has to carry and
 * leaves the echo guard one expectation per pedal move rather than three.
 */
import type { MidiFile, AnyEvent } from 'midifile-ts';
import { addAbsoluteTime } from '../pianosound/MidiNote';
import {
    PEDAL_CONTROLLERS,
    controlKey,
    pitchKey,
    releaseFor,
    type ChannelMessage,
    type ControlMessage,
    type NoteMessage,
} from './midiMessage';

/**
 * The jack has to reset before the key will strike again. Chosen rather than measured: no Yamaha
 * figure for solenoid retriggering is published, and this instrument is weeks away.
 */
export const RETRIGGER_GAP_MS = 30;

/** How long the pedal is left where the fragment left it before it is returned to zero. */
export const PEDAL_TAIL_MS = 300;

export type PlannedNote = {
    readonly channel: number;
    readonly note: number;
    readonly velocity: number;
    readonly releaseVelocity: number;
    readonly onAtMs: number;
    readonly offAtMs: number;
};

/** A message with the plan-relative time it is wanted, and the note it belongs to if it is one. */
export type PlannedMessage = {
    readonly atMs: number;
    readonly message: ChannelMessage;
    /** Index into {@link DemonstrationPlan.notes}. A strike dropped as stale takes its release with it. */
    readonly noteIndex: number | null;
};

type TimedControl = { readonly atMs: number; readonly message: ControlMessage };

export type DemonstrationPlan = {
    readonly notes: readonly PlannedNote[];
    readonly pedal: readonly TimedControl[];
    /** When the fragment is over: the last release, plus the pedal tail. */
    readonly endsAtMs: number;
};

export type PlanOptions = {
    readonly retriggerGapMs: number;
    readonly pedalTailMs: number;
    /**
     * What is forwarded. Channel volume is deliberately absent: the renderer emits CC7 at a
     * constant 100, and an instrument that honours it would scale the very dynamics the fragment
     * exists to demonstrate.
     */
    readonly controllers: readonly number[];
};

const DEFAULTS: PlanOptions = {
    retriggerGapMs: RETRIGGER_GAP_MS,
    pedalTailMs: PEDAL_TAIL_MS,
    controllers: PEDAL_CONTROLLERS,
};

type Timed = { readonly atMs: number; readonly message: ChannelMessage };

const messageOf = (event: AnyEvent): ChannelMessage | null => {
    if (event.type !== 'channel') return null;
    switch (event.subtype) {
        case 'noteOn':
            return event.velocity > 0
                ? { kind: 'noteOn', channel: event.channel, note: event.noteNumber, velocity: event.velocity }
                : { kind: 'noteOff', channel: event.channel, note: event.noteNumber, velocity: 0 };
        case 'noteOff':
            return { kind: 'noteOff', channel: event.channel, note: event.noteNumber, velocity: event.velocity };
        case 'controller':
            return { kind: 'control', channel: event.channel, controller: event.controllerType, value: event.value };
        default:
            return null;
    }
};

/** At one instant: keys up, then the pedal, then keys down. */
const order = (message: ChannelMessage): number =>
    message.kind === 'noteOff' ? 0 : message.kind === 'control' ? 1 : 2;

const byTime = (a: Timed, b: Timed): number =>
    a.atMs - b.atMs || order(a.message) - order(b.message);

const noteOf = (
    strike: NoteMessage,
    onAtMs: number,
    offAtMs: number,
    releaseVelocity: number,
): PlannedNote => ({
    channel: strike.channel,
    note: strike.note,
    velocity: strike.velocity,
    releaseVelocity,
    onAtMs,
    offAtMs: Math.max(onAtMs, offAtMs),
});

/** Pair each strike with its release, first in first out per key; anything still down ends at `endsAtMs`. */
const notesOf = (timed: readonly Timed[], endsAtMs: number): PlannedNote[] => {
    const down = new Map<number, { atMs: number; strike: NoteMessage }[]>();
    const notes: PlannedNote[] = [];

    timed.forEach(({ atMs, message }) => {
        if (message.kind === 'control') return;
        const key = pitchKey(message);
        if (message.kind === 'noteOn') {
            const queue = down.get(key);
            if (queue) queue.push({ atMs, strike: message });
            else down.set(key, [{ atMs, strike: message }]);
            return;
        }
        const struck = down.get(key)?.shift();
        if (struck) notes.push(noteOf(struck.strike, struck.atMs, atMs, message.velocity));
    });

    const hanging = [...down.values()]
        .flat()
        .map(({ atMs, strike }) => noteOf(strike, atMs, endsAtMs, 0));

    return [...notes, ...hanging].sort((a, b) => a.onAtMs - b.onAtMs);
};

const strikeOf = (note: PlannedNote): NoteMessage => ({
    kind: 'noteOn',
    channel: note.channel,
    note: note.note,
    velocity: note.velocity,
});

const byPitch = (notes: readonly PlannedNote[]): Map<number, PlannedNote[]> =>
    notes.reduce((groups, note) => {
        const key = pitchKey(strikeOf(note));
        const group = groups.get(key);
        if (group) group.push(note);
        else groups.set(key, [note]);
        return groups;
    }, new Map<number, PlannedNote[]>());

/**
 * Open a gap between a release and the next strike of the same key by moving the release earlier.
 * A release is never moved before its own strike: where two strikes are closer together than the
 * gap, the note becomes momentary and the action does what it can.
 */
const withRetriggerGaps = (notes: readonly PlannedNote[], gapMs: number): PlannedNote[] =>
    [...byPitch(notes).values()].flatMap((group) => {
        const sorted = [...group].sort((a, b) => a.onAtMs - b.onAtMs);
        return sorted.map((note, index) => {
            const next = sorted[index + 1];
            if (!next) return note;
            const latestRelease = next.onAtMs - gapMs;
            return note.offAtMs <= latestRelease
                ? note
                : { ...note, offAtMs: Math.max(note.onAtMs, latestRelease) };
        });
    });

/** Drop a control that restates the value already in effect for its controller. */
const withoutRestatedValues = (controls: readonly TimedControl[]): TimedControl[] => {
    const inEffect = new Map<number, number>();
    return controls.filter(({ message }) => {
        const key = controlKey(message);
        if (inEffect.get(key) === message.value) return false;
        inEffect.set(key, message.value);
        return true;
    });
};

/** Return every pedal the fragment left down to zero, so it does not hold into the next demonstration. */
const pedalTail = (controls: readonly TimedControl[], atMs: number): TimedControl[] => {
    const last = new Map<number, ControlMessage>();
    controls.forEach(({ message }) => last.set(controlKey(message), message));
    return [...last.values()]
        .filter((message) => message.value > 0)
        .map((message) => ({ atMs, message: { ...message, value: 0 } }));
};

/** The plan as one ordered stream, each message carrying the note it belongs to. */
export const messagesOf = (plan: DemonstrationPlan): PlannedMessage[] =>
    [
        ...plan.pedal.map(({ atMs, message }) => ({ atMs, message, noteIndex: null })),
        ...plan.notes.flatMap((note, noteIndex): PlannedMessage[] => [
            { atMs: note.onAtMs, message: strikeOf(note), noteIndex },
            {
                atMs: note.offAtMs,
                message: releaseFor(strikeOf(note), note.releaseVelocity),
                noteIndex,
            },
        ]),
    ].sort(byTime);

/**
 * A fragment rendered by `services/mpmRenderer.perform`, as a plan. Times stay relative to the
 * fragment's first note, which `perform` has already shifted to zero.
 */
export const planDemonstration = (
    midi: MidiFile,
    options: Partial<PlanOptions> = {},
): DemonstrationPlan => {
    const { retriggerGapMs, pedalTailMs, controllers } = { ...DEFAULTS, ...options };

    const timed = addAbsoluteTime(midi)
        .flatMap((event): Timed[] => {
            const message = messageOf(event);
            return message ? [{ atMs: event.abs, message }] : [];
        })
        .sort(byTime);

    const lastMessageMs = timed.length === 0 ? 0 : timed[timed.length - 1].atMs;
    const notes = withRetriggerGaps(notesOf(timed, lastMessageMs), retriggerGapMs);
    const lastReleaseMs = notes.reduce((latest, note) => Math.max(latest, note.offAtMs), lastMessageMs);

    const moves = withoutRestatedValues(
        timed.flatMap(({ atMs, message }): TimedControl[] =>
            message.kind === 'control' && controllers.includes(message.controller)
                ? [{ atMs, message }]
                : [],
        ),
    );
    const tailAtMs = lastReleaseMs + pedalTailMs;
    const tail = pedalTail(moves, tailAtMs);

    return {
        notes,
        pedal: [...moves, ...tail],
        endsAtMs: tail.length > 0 ? tailAtMs : lastReleaseMs,
    };
};
