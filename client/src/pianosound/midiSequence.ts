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

/** Shift all MIDI events forward by `offsetTicks`, prepending silence. */
export const delayMidi = (
    midi: MidiFile,
    offsetTicks: number,
): MidiFile => {
    if (offsetTicks <= 0) return midi;
    const tracks: AnyEvent[][] = midi.tracks.map((track) => {
        if (track.length === 0) return track;
        return [
            { ...track[0], deltaTime: track[0].deltaTime + offsetTicks },
            ...track.slice(1),
        ];
    });
    return { header: { ...midi.header }, tracks };
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

// ── Sustain tail ──

const CC_SUSTAIN = 64;
const RAMP_STEPS = 8;

/**
 * Append a sustain-pedal tail to the MIDI: hold the damper pedal from the last
 * note-on through `holdMs` after the piece ends, then ramp CC64 from 127→0
 * over `rampMs` (gradual half-pedaling on hardware; Tone.js lifts at the
 * first value ≤63).
 */
export const appendSustainTail = (
    midi: MidiFile,
    holdMs: number = 2500,
    rampMs: number = 1500,
): MidiFile => {
    const ppq = midi.header.ticksPerBeat;

    // Last tempo for ms→tick conversion at end of piece
    let lastTempo = 500000; // default 120 BPM
    for (const track of midi.tracks) {
        for (const event of track) {
            if (event.type === 'meta' && event.subtype === 'setTempo') {
                lastTempo = event.microsecondsPerBeat;
            }
        }
    }
    const msToTick = (ms: number) => Math.round(ms * 1000 * ppq / lastTempo);

    // Find the track with the last note-on and its channel
    let lastNoteOnTick = -1;
    let noteTrackIdx = -1;
    let noteChannel = 0;

    for (let t = 0; t < midi.tracks.length; t++) {
        let tick = 0;
        for (const event of midi.tracks[t]) {
            tick += event.deltaTime;
            if (
                event.type === 'channel' &&
                event.subtype === 'noteOn' &&
                (event.velocity ?? 0) > 0 &&
                tick > lastNoteOnTick
            ) {
                lastNoteOnTick = tick;
                noteTrackIdx = t;
                noteChannel = event.channel ?? 0;
            }
        }
    }

    if (noteTrackIdx === -1) return midi; // no notes

    // Total tick length of the note track (excluding endOfTrack)
    let trackEndTick = 0;
    for (const event of midi.tracks[noteTrackIdx]) {
        trackEndTick += event.deltaTime;
    }

    // Collect existing events as absolute-tick pairs (drop endOfTrack — re-added later)
    const timed: { tick: number; event: AnyEvent }[] = [];
    let tick = 0;
    for (const event of midi.tracks[noteTrackIdx]) {
        tick += event.deltaTime;
        if (event.type === 'meta' && event.subtype === 'endOfTrack') continue;
        timed.push({ tick, event: { ...event } });
    }

    // Strip CC64 events at or after the last note-on (we override pedaling from here)
    const filtered = timed.filter((e) => {
        if (e.tick < lastNoteOnTick) return true;
        if (
            e.event.type === 'channel' &&
            e.event.subtype === 'controller' &&
            (e.event.controllerType ?? 0) === CC_SUSTAIN
        ) {
            return false;
        }
        return true;
    });

    // Pedal down at the last note-on
    filtered.push({
        tick: lastNoteOnTick,
        event: {
            deltaTime: 0,
            type: 'channel',
            subtype: 'controller',
            channel: noteChannel,
            controllerType: CC_SUSTAIN,
            value: 127,
        },
    });

    // Gradual ramp-down after hold period
    const holdEndTick = trackEndTick + msToTick(holdMs);
    const stepTicks = Math.round(msToTick(rampMs) / RAMP_STEPS);
    for (let step = 1; step <= RAMP_STEPS; step++) {
        filtered.push({
            tick: holdEndTick + step * stepTicks,
            event: {
                deltaTime: 0,
                type: 'channel',
                subtype: 'controller',
                channel: noteChannel,
                controllerType: CC_SUSTAIN,
                value: Math.round(127 * (1 - step / RAMP_STEPS)),
            },
        });
    }

    // Sort by tick, rebuild delta times
    filtered.sort((a, b) => a.tick - b.tick);
    const newTrack: AnyEvent[] = [];
    let prev = 0;
    for (const e of filtered) {
        newTrack.push({ ...e.event, deltaTime: e.tick - prev });
        prev = e.tick;
    }
    newTrack.push({ deltaTime: 0, type: 'meta', subtype: 'endOfTrack' });

    const tracks = midi.tracks.map((t, i) => (i === noteTrackIdx ? newTrack : t));
    return { header: { ...midi.header }, tracks };
};

// ── Mood chord post-processing ──

const MOOD_NOTE_DURATION_MS = 300;
const MOOD_PEDAL_RAMP_STEPS = 16;
const MOOD_PEDAL_DOWN_RAMP_MS = 400;

/**
 * Post-process mood chord MIDI:
 * 1. Shift all events forward to make room for a smooth pedal-down ramp
 * 2. Shorten note durations (sustain pedal carries the sound, not held keys)
 * 3. Replace pedal envelope with smooth press → hold → gradual release
 */
export const prepareMoodChordMidi = (
    midi: MidiFile,
    rampStartMs: number,
    rampDurationMs: number,
    noteDurationMs: number = MOOD_NOTE_DURATION_MS,
    pedalDownRampMs: number = MOOD_PEDAL_DOWN_RAMP_MS,
): MidiFile => {
    const ppq = midi.header.ticksPerBeat;

    let lastTempo = 500000;
    for (const track of midi.tracks) {
        for (const event of track) {
            if (event.type === 'meta' && event.subtype === 'setTempo') {
                lastTempo = event.microsecondsPerBeat;
            }
        }
    }
    const msToTick = (ms: number) => Math.round(ms * 1000 * ppq / lastTempo);

    const noteDurationTicks = Math.max(1, msToTick(noteDurationMs));
    const pedalDownTicks = msToTick(pedalDownRampMs);
    const clampedRampStart = Math.max(0, rampStartMs);
    const rampStartTick = msToTick(clampedRampStart);
    const rampEndTick = msToTick(clampedRampStart + rampDurationMs);

    // Find the note track (track with most note-ons)
    let noteTrackIdx = -1;
    let maxNoteOns = 0;
    for (let t = 0; t < midi.tracks.length; t++) {
        let count = 0;
        for (const event of midi.tracks[t]) {
            if (event.type === 'channel' && event.subtype === 'noteOn' && (event.velocity ?? 0) > 0) {
                count++;
            }
        }
        if (count > maxNoteOns) {
            maxNoteOns = count;
            noteTrackIdx = t;
        }
    }

    if (noteTrackIdx === -1) return midi;

    const tracks = midi.tracks.map((track, trackIndex) => {
        if (trackIndex !== noteTrackIdx) return track;

        // Convert to absolute ticks, drop endOfTrack
        const timed: { tick: number; event: AnyEvent }[] = [];
        let tick = 0;
        for (const event of track) {
            tick += event.deltaTime;
            if (event.type === 'meta' && event.subtype === 'endOfTrack') continue;
            timed.push({ tick, event: { ...event } });
        }

        // Shift all events forward by pedalDownTicks to make room for the press
        const noteOns = new Map<string, number>();
        const result: { tick: number; event: AnyEvent }[] = [];
        let pedalChannel = 0;

        for (const item of timed) {
            const ev = item.event;
            const shifted = item.tick + pedalDownTicks;

            // Strip existing CC64 (sustain) events — we insert our own
            if (
                ev.type === 'channel' &&
                ev.subtype === 'controller' &&
                (ev.controllerType ?? 0) === CC_SUSTAIN
            ) {
                pedalChannel = ev.channel ?? 0;
                continue;
            }

            if (ev.type === 'channel' && ev.subtype === 'noteOn' && (ev.velocity ?? 0) > 0) {
                const key = `${ev.channel}-${ev.noteNumber}`;
                noteOns.set(key, shifted);
                pedalChannel = ev.channel ?? 0;
                result.push({ tick: shifted, event: ev });
            } else if (
                ev.type === 'channel' &&
                (ev.subtype === 'noteOff' || (ev.subtype === 'noteOn' && (ev.velocity ?? 0) === 0))
            ) {
                const key = `${ev.channel}-${ev.noteNumber}`;
                const onTick = noteOns.get(key);
                if (onTick != null) {
                    result.push({ tick: onTick + noteDurationTicks, event: ev });
                    noteOns.delete(key);
                } else {
                    result.push({ tick: shifted, event: ev });
                }
            } else {
                result.push({ tick: shifted, event: ev });
            }
        }

        // Smooth pedal-down ramp (0→127 over pedalDownTicks, completing before first note)
        for (let step = 0; step <= MOOD_PEDAL_RAMP_STEPS; step++) {
            result.push({
                tick: Math.round(step * pedalDownTicks / MOOD_PEDAL_RAMP_STEPS),
                event: {
                    deltaTime: 0,
                    type: 'channel',
                    subtype: 'controller',
                    channel: pedalChannel,
                    controllerType: CC_SUSTAIN,
                    value: Math.round(127 * step / MOOD_PEDAL_RAMP_STEPS),
                },
            });
        }

        // Gradual pedal release ramp (127→0)
        const releaseStepTicks = Math.max(1, Math.round((rampEndTick - rampStartTick) / MOOD_PEDAL_RAMP_STEPS));
        for (let step = 1; step <= MOOD_PEDAL_RAMP_STEPS; step++) {
            result.push({
                tick: rampStartTick + step * releaseStepTicks,
                event: {
                    deltaTime: 0,
                    type: 'channel',
                    subtype: 'controller',
                    channel: pedalChannel,
                    controllerType: CC_SUSTAIN,
                    value: Math.round(127 * (1 - step / MOOD_PEDAL_RAMP_STEPS)),
                },
            });
        }

        // Sort and rebuild delta times
        result.sort((a, b) => a.tick - b.tick);
        const newTrack: AnyEvent[] = [];
        let prev = 0;
        for (const e of result) {
            newTrack.push({ ...e.event, deltaTime: e.tick - prev });
            prev = e.tick;
        }
        newTrack.push({ deltaTime: 0, type: 'meta', subtype: 'endOfTrack' });

        return newTrack;
    });

    return { header: { ...midi.header }, tracks };
};
