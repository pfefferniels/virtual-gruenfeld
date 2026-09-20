import type { AnyEvent, MidiFile } from 'midifile-ts';

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
