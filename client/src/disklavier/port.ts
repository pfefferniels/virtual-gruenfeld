/**
 * The way out to the instrument, and a fake that records instead of playing.
 *
 * One method, because there is nothing to release, and as far as I can see nothing to recall
 * either: `MIDIOutput.clear()` is absent from the DOM typings this project builds against, and a
 * message given a future timestamp is converted to a mach absolute time and scheduled by CoreMIDI
 * rather than held in the page. What keeps a demonstration stoppable is therefore not the port but
 * `demonstrate.ts`, which hands the fragment over a slice at a time. Should a recall turn out to
 * exist, it would shorten the tail a stop leaves behind; it would not change the design.
 */
import type { Clock } from './clock';

export type MidiPort = {
    /**
     * `atMs` is on the page clock, the clock an incoming `MIDIMessageEvent.timeStamp` uses.
     * Omitting it means as soon as the bus allows.
     */
    send(data: Uint8Array, atMs?: number): void;
};

export const webMidiPort = (output: MIDIOutput): MidiPort => ({
    // The specification takes `sequence<octet>`, which accepts the view; the DOM typings say `number[]`.
    send: (data, atMs) => output.send(Array.from(data), atMs),
});

/** The output to answer on: the one named by `id`, else the first that calls itself a Disklavier. */
export const findDisklavierOutput = (access: MIDIAccess, id?: string | null): MIDIOutput | null => {
    const outputs = [...access.outputs.values()];
    if (id) return outputs.find((output) => output.id === id) ?? null;
    return outputs.find((output) => /disklavier/i.test(output.name ?? '')) ?? outputs[0] ?? null;
};

export type SentMessage = {
    readonly data: Uint8Array;
    /** When the instrument was asked to receive it. */
    readonly atMs: number;
    /** When the page let go of it, which is earlier whenever the message was scheduled ahead. */
    readonly handedOverAtMs: number;
};

export type FakeMidiPort = MidiPort & { readonly sent: readonly SentMessage[] };

export const createFakeMidiPort = (now: Clock): FakeMidiPort => {
    const sent: SentMessage[] = [];
    return {
        sent,
        send(data, atMs) {
            const handedOverAtMs = now();
            sent.push({ data: new Uint8Array(data), atMs: atMs ?? handedOverAtMs, handedOverAtMs });
        },
    };
};
