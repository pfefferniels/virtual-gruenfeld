import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { read, type MidiFile } from 'midifile-ts';
import { describe, expect, it } from 'vitest';
import { perform } from '../services/mpmRenderer';
import { buildSmfFromMessages } from '../smf';
import { DAMPER, SOFT, pitchKey, type ChannelMessage } from './midiMessage';
import {
    PEDAL_TAIL_MS,
    RETRIGGER_GAP_MS,
    messagesOf,
    planDemonstration,
    type PlanOptions,
    type PlannedMessage,
    type PlannedNote,
} from './plan';

/** 480 ticks a quarter at 125 bpm makes a tick a millisecond, so the fixtures read as written. */
const midiOf = (messages: readonly { atMs: number; data: number[] }[]): MidiFile =>
    read(
        buildSmfFromMessages(
            messages.map(({ atMs, data }) => ({ tMs: atMs, data: new Uint8Array(data) })),
            { ticksPerQuarter: 480, bpm: 125 },
        ),
    );

const on = (note: number, velocity = 64) => [0x90, note, velocity];
const off = (note: number) => [0x80, note, 0];
const cc = (controller: number, value: number) => [0xb0, controller, value];

const CHANNEL_VOLUME = 7;

describe('pairing', () => {
    it('pairs each strike with its release', () => {
        const { notes } = planDemonstration(
            midiOf([
                { atMs: 0, data: on(60, 70) },
                { atMs: 500, data: off(60) },
            ]),
        );
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatchObject({ channel: 0, note: 60, velocity: 70, releaseVelocity: 0 });
        expect(notes[0].onAtMs).toBeCloseTo(0);
        expect(notes[0].offAtMs).toBeCloseTo(500);
    });

    it('releases a note the fragment never let go of, rather than leaving the key down', () => {
        const { notes } = planDemonstration(
            midiOf([
                { atMs: 0, data: on(60) },
                { atMs: 400, data: on(64) },
                { atMs: 800, data: off(64) },
            ]),
        );
        expect(notes.find((note) => note.note === 60)?.offAtMs).toBe(800);
    });
});

describe('the retrigger gap', () => {
    it('moves the release earlier when the same key is struck again too soon', () => {
        const { notes } = planDemonstration(
            midiOf([
                { atMs: 0, data: on(60) },
                { atMs: 195, data: off(60) },
                { atMs: 200, data: on(60) },
                { atMs: 400, data: off(60) },
            ]),
        );
        expect(notes.map((note) => [note.onAtMs, note.offAtMs])).toEqual([
            [0, 200 - RETRIGGER_GAP_MS],
            [200, 400],
        ]);
    });

    it('opens the gap by moving the release, never by moving the strike', () => {
        const struck = [0, 200];
        const { notes } = planDemonstration(
            midiOf([
                { atMs: 0, data: on(60) },
                { atMs: 195, data: off(60) },
                { atMs: 200, data: on(60) },
                { atMs: 400, data: off(60) },
            ]),
        );
        expect(notes.map((note) => note.onAtMs)).toEqual(struck);
    });

    it('holds a strike that already has room', () => {
        const { notes } = planDemonstration(
            midiOf([
                { atMs: 0, data: on(60) },
                { atMs: 100, data: off(60) },
                { atMs: 200, data: on(60) },
                { atMs: 300, data: off(60) },
            ]),
        );
        expect(notes[0].offAtMs).toBe(100);
    });

    it('never moves a release before its own strike, however close the repeat', () => {
        const { notes } = planDemonstration(
            midiOf([
                { atMs: 0, data: on(60) },
                { atMs: 5, data: off(60) },
                { atMs: 10, data: on(60) },
                { atMs: 200, data: off(60) },
            ]),
        );
        expect(notes[0].offAtMs).toBe(0);
    });

    it('leaves a different key alone', () => {
        const { notes } = planDemonstration(
            midiOf([
                { atMs: 0, data: on(60) },
                { atMs: 195, data: off(60) },
                { atMs: 200, data: on(61) },
                { atMs: 400, data: off(61) },
            ]),
        );
        expect(notes[0].offAtMs).toBe(195);
    });
});

describe('the pedal', () => {
    it('drops a value that restates the one already in effect', () => {
        const { pedal } = planDemonstration(
            midiOf([
                { atMs: 0, data: on(60) },
                { atMs: 0, data: cc(DAMPER, 127) },
                { atMs: 10, data: cc(DAMPER, 127) },
                { atMs: 20, data: cc(DAMPER, 127) },
                { atMs: 30, data: cc(DAMPER, 64) },
                { atMs: 400, data: off(60) },
            ]),
        );
        expect(pedal.map(({ atMs, message }) => [atMs, message.value])).toEqual([
            [0, 127],
            [30, 64],
            [400 + PEDAL_TAIL_MS, 0],
        ]);
    });

    it('returns every pedal the fragment left down, a tail after the last release', () => {
        const plan = planDemonstration(
            midiOf([
                { atMs: 0, data: on(60) },
                { atMs: 0, data: cc(DAMPER, 100) },
                { atMs: 0, data: cc(SOFT, 127) },
                { atMs: 400, data: off(60) },
            ]),
        );
        const tail = plan.pedal.filter(({ atMs }) => atMs === plan.endsAtMs);
        expect(tail.map(({ message }) => [message.controller, message.value])).toEqual([
            [DAMPER, 0],
            [SOFT, 0],
        ]);
        expect(plan.endsAtMs).toBe(400 + PEDAL_TAIL_MS);
    });

    it('adds no tail where the fragment already ends with the pedal up', () => {
        const plan = planDemonstration(
            midiOf([
                { atMs: 0, data: on(60) },
                { atMs: 0, data: cc(DAMPER, 127) },
                { atMs: 300, data: cc(DAMPER, 0) },
                { atMs: 400, data: off(60) },
            ]),
        );
        expect(plan.endsAtMs).toBe(400);
        expect(plan.pedal).toHaveLength(2);
    });

    it('does not forward channel volume, which would scale the dynamics being demonstrated', () => {
        const { pedal } = planDemonstration(
            midiOf([
                { atMs: 0, data: on(60) },
                { atMs: 0, data: cc(CHANNEL_VOLUME, 100) },
                { atMs: 400, data: off(60) },
            ]),
        );
        expect(pedal).toEqual([]);
    });

    it('forwards what it is told to, so a measured instrument can widen the set', () => {
        const options: Partial<PlanOptions> = { controllers: [CHANNEL_VOLUME] };
        const { pedal } = planDemonstration(
            midiOf([
                { atMs: 0, data: on(60) },
                { atMs: 0, data: cc(CHANNEL_VOLUME, 100) },
                { atMs: 400, data: off(60) },
            ]),
            options,
        );
        expect(pedal.map(({ message }) => message.controller)).toEqual([CHANNEL_VOLUME, CHANNEL_VOLUME]);
    });
});

describe('the message stream', () => {
    it('at one instant lifts keys, then moves the pedal, then strikes', () => {
        const plan = planDemonstration(
            midiOf([
                { atMs: 0, data: on(60) },
                { atMs: 200, data: off(60) },
                { atMs: 200, data: cc(DAMPER, 127) },
                { atMs: 200, data: on(64) },
                { atMs: 400, data: off(64) },
            ]),
        );
        const atTheTurn: PlannedMessage[] = messagesOf(plan).filter(({ atMs }) => atMs === 200);
        expect(atTheTurn.map(({ message }) => message.kind)).toEqual(['noteOff', 'control', 'noteOn']);
    });

    it('gives a strike and its release the same note index, so a dropped strike takes its release', () => {
        const plan = planDemonstration(
            midiOf([
                { atMs: 0, data: on(60) },
                { atMs: 0, data: cc(DAMPER, 127) },
                { atMs: 200, data: off(60) },
            ]),
        );
        expect(messagesOf(plan).map(({ message, noteIndex }) => [message.kind, noteIndex])).toEqual([
            ['control', null],
            ['noteOn', 0],
            ['noteOff', 0],
            ['control', null],
        ]);
    });
});

const load = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/**
 * The plan has to hold against the document the app actually plays, not only against fixtures.
 * Over the whole reconstruction 33 strikes land on a key that is still down.
 */
describe('against the reconstruction', () => {
    const mei = load('../../public/score.mei');
    const mpm = load('../../public/performance.mpm');
    const plan = planDemonstration(perform(mei, mpm, { from: 0, to: 34560 })!);

    it('leaves no key down and no repeat inside the gap', () => {
        const byKey = plan.notes.reduce((groups, note) => {
            const key = pitchKey({ kind: 'noteOn', ...note });
            groups.set(key, [...(groups.get(key) ?? []), note]);
            return groups;
        }, new Map<number, PlannedNote[]>());

        const gaps = [...byKey.values()].flatMap((group) =>
            [...group]
                .sort((a, b) => a.onAtMs - b.onAtMs)
                .slice(1)
                .map((note, index) => note.onAtMs - group[index].offAtMs),
        );
        expect(gaps.length).toBeGreaterThan(0);
        expect(Math.min(...gaps)).toBeGreaterThanOrEqual(0);
        // Where two strikes sit closer together than the gap the note becomes momentary, so the
        // guarantee is that a release never follows the next strike, not that the gap is always met.
        expect(plan.notes.every((note) => note.offAtMs >= note.onAtMs)).toBe(true);
    });

    it('ends with every pedal up', () => {
        const last = new Map<number, number>();
        plan.pedal.forEach(({ message }) => last.set(message.controller, message.value));
        expect([...last.values()]).toEqual(Array(last.size).fill(0));
    });

    it('carries no message the instrument was not meant to hear', () => {
        const kinds = new Set(messagesOf(plan).map(({ message }) => message.kind));
        expect([...kinds].sort()).toEqual<ChannelMessage['kind'][]>(['control', 'noteOff', 'noteOn']);
        expect(new Set(plan.pedal.map(({ message }) => message.controller))).toEqual(
            new Set([DAMPER, SOFT]),
        );
    });
});
