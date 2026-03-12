import type { AnyEvent, MidiFile } from 'midifile-ts';

type TimedEvent = {
    tick: number;
    order: number;
    event: AnyEvent;
};

const isEndOfTrack = (event: AnyEvent): boolean =>
    event.type === 'meta' && event.subtype === 'endOfTrack';

const toTimedEvents = (
    track: AnyEvent[] | undefined,
    tickOffset: number,
    orderOffset: number,
): TimedEvent[] => {
    if (!track) return [];

    let tick = 0;
    return track.flatMap((event, index) => {
        tick += event.deltaTime;
        if (isEndOfTrack(event)) return [];
        return [{
            tick: tick + tickOffset,
            order: orderOffset + index,
            event: { ...event },
        }];
    });
};

const toTrack = (events: TimedEvent[]): AnyEvent[] => {
    if (events.length === 0) {
        return [{ deltaTime: 0, type: 'meta', subtype: 'endOfTrack' }];
    }

    const sorted = events
        .slice()
        .sort((a, b) => a.tick - b.tick || a.order - b.order);

    const track: AnyEvent[] = [];
    let previousTick = 0;
    for (const item of sorted) {
        track.push({
            ...item.event,
            deltaTime: item.tick - previousTick,
        });
        previousTick = item.tick;
    }

    track.push({
        deltaTime: 0,
        type: 'meta',
        subtype: 'endOfTrack',
    });
    return track;
};

export const appendMidiWithOffset = (
    first: MidiFile,
    second: MidiFile,
    secondOffsetTicks: number,
): MidiFile => {
    if (first.header.ticksPerBeat !== second.header.ticksPerBeat) {
        throw new Error(
            `Cannot combine MIDI files with different PPQ (${first.header.ticksPerBeat} vs ${second.header.ticksPerBeat})`,
        );
    }

    const trackCount = Math.max(first.tracks.length, second.tracks.length);
    const tracks: AnyEvent[][] = [];

    for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
        const merged = [
            ...toTimedEvents(first.tracks[trackIndex], 0, 0),
            ...toTimedEvents(second.tracks[trackIndex], secondOffsetTicks, 1_000_000),
        ];
        tracks.push(toTrack(merged));
    }

    return {
        header: {
            formatType: 1,
            trackCount,
            ticksPerBeat: first.header.ticksPerBeat,
        },
        tracks,
    };
};

export const offsetCueTimes = <T extends { atSec: number }>(
    cues: T[],
    offsetSec: number,
): T[] =>
    cues.map((cue) => ({
        ...cue,
        atSec: cue.atSec + offsetSec,
    }));

type TempoPoint = {
    tick: number;
    microsecondsPerBeat: number;
};

export const millisecondsToMidiTicks = (
    midi: MidiFile,
    milliseconds: number,
): number => {
    const tempoPoints: TempoPoint[] = [];

    for (const track of midi.tracks) {
        let tick = 0;
        for (const event of track) {
            tick += event.deltaTime;
            if (event.type === 'meta' && event.subtype === 'setTempo') {
                tempoPoints.push({ tick, microsecondsPerBeat: event.microsecondsPerBeat });
            }
        }
    }

    const sortedTempos = tempoPoints
        .sort((a, b) => a.tick - b.tick)
        .filter((tempo, index, arr) => index === 0 || tempo.tick !== arr[index - 1].tick);

    let currentTempo = sortedTempos[0]?.microsecondsPerBeat ?? 500000;
    let currentTick = sortedTempos[0]?.tick === 0 ? 0 : 0;
    let elapsedMs = 0;

    for (const tempo of sortedTempos) {
        if (tempo.tick <= currentTick) {
            currentTempo = tempo.microsecondsPerBeat;
            continue;
        }

        const segmentTicks = tempo.tick - currentTick;
        const segmentMs = segmentTicks * currentTempo / midi.header.ticksPerBeat / 1000;
        if (elapsedMs + segmentMs >= milliseconds) {
            const remainingMs = milliseconds - elapsedMs;
            return currentTick + Math.round(remainingMs * 1000 * midi.header.ticksPerBeat / currentTempo);
        }

        elapsedMs += segmentMs;
        currentTick = tempo.tick;
        currentTempo = tempo.microsecondsPerBeat;
    }

    const remainingMs = Math.max(0, milliseconds - elapsedMs);
    return currentTick + Math.round(remainingMs * 1000 * midi.header.ticksPerBeat / currentTempo);
};
