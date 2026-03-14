import { AnyEvent, MidiFile } from "midifile-ts";

function midiTickToMilliseconds(ticks: number, microsecondsPerBeat: number, ppq: number): number {
    const beats = ticks / ppq;
    return (beats * microsecondsPerBeat) / 1000;
}

type AbsoluteEvent = AnyEvent & { abs: number };

export const addAbsoluteTime = (file: MidiFile): AbsoluteEvent[] => {
    const ppq = file.header.ticksPerBeat;

    // First pass: collect all tempo changes across all tracks
    type TempoChange = { atTick: number; microsecondsPerBeat: number };
    const rawTempos: TempoChange[] = [];
    for (const track of file.tracks) {
        let tick = 0;
        for (const event of track) {
            tick += event.deltaTime;
            if (event.type === 'meta' && event.subtype === 'setTempo') {
                rawTempos.push({ atTick: tick, microsecondsPerBeat: event.microsecondsPerBeat });
            }
        }
    }
    rawTempos.sort((a, b) => a.atTick - b.atTick);

    // Deduplicate: keep last tempo at each tick position
    const tempoChanges: TempoChange[] = [];
    for (const t of rawTempos) {
        if (tempoChanges.length > 0 && tempoChanges[tempoChanges.length - 1].atTick === t.atTick) {
            tempoChanges[tempoChanges.length - 1] = t;
        } else {
            tempoChanges.push(t);
        }
    }

    // Pre-compute cumulative absolute time at each tempo change point
    type TempoPoint = { atTick: number; atMs: number; microsecondsPerBeat: number };
    const points: TempoPoint[] = [];
    {
        let ms = 0;
        let prevTick = 0;
        let prevTempo = 500000; // MIDI default: 120 BPM
        for (const tc of tempoChanges) {
            if (tc.atTick > prevTick) {
                ms += midiTickToMilliseconds(tc.atTick - prevTick, prevTempo, ppq);
            }
            points.push({ atTick: tc.atTick, atMs: ms, microsecondsPerBeat: tc.microsecondsPerBeat });
            prevTick = tc.atTick;
            prevTempo = tc.microsecondsPerBeat;
        }
    }

    // Convert a tick position to absolute milliseconds, accumulating across
    // tempo changes rather than applying a single tempo to all ticks.
    const tickToMs = (tick: number): number => {
        let baseMs = 0;
        let baseTick = 0;
        let tempo = 500000;
        for (const p of points) {
            if (p.atTick > tick) break;
            baseMs = p.atMs;
            baseTick = p.atTick;
            tempo = p.microsecondsPerBeat;
        }
        return baseMs + midiTickToMilliseconds(tick - baseTick, tempo, ppq);
    };

    // Second pass: convert all events to absolute time
    const newEvents: AbsoluteEvent[] = [];
    for (const track of file.tracks) {
        let tick = 0;
        for (const event of track) {
            tick += event.deltaTime;
            newEvents.push({ ...event, abs: tickToMs(tick) });
        }
    }

    newEvents.sort((a, b) => a.abs - b.abs);
    return newEvents;
};
