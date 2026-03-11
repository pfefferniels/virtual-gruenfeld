import { AnyEvent, MidiFile } from "midifile-ts";

function midiTickToMilliseconds(ticks: number, microsecondsPerBeat: number, ppq: number): number {
    const beats = ticks / ppq;
    return (beats * microsecondsPerBeat) / 1000;
}

type AbsoluteEvent = AnyEvent & { abs: number };

export const addAbsoluteTime = (file: MidiFile): AbsoluteEvent[] => {
    type Tempo = { atTick: number; microsecondsPerBeat: number };
    const tempoMap: Tempo[] = [];
    const newEvents: AbsoluteEvent[] = [];

    for (let i = 0; i < file.tracks.length; i++) {
        const track = file.tracks[i];
        let currentTick = 0;

        for (const event of track) {
            currentTick += event.deltaTime;

            if (event.type === 'meta' && event.subtype === 'setTempo') {
                tempoMap.push({
                    atTick: currentTick,
                    microsecondsPerBeat: event.microsecondsPerBeat,
                });
            }

            const currentTempo = tempoMap.slice().reverse().find((tempo) => tempo.atTick <= currentTick);
            if (!currentTempo) continue;

            newEvents.push({
                ...event,
                abs: midiTickToMilliseconds(currentTick, currentTempo.microsecondsPerBeat, file.header.ticksPerBeat),
            });
        }
    }

    newEvents.sort((a, b) => a.abs - b.abs);
    return newEvents;
};
