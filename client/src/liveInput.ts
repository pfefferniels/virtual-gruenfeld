/**
 * The student's playing, as a stream rather than a take.
 *
 * `midi.ts` answers a different question: it waits for the playing to *stop* and hands over a
 * finished take. The live lesson needs the opposite — everything struck so far, available while
 * the hands are still down — so this keeps a rolling buffer and never clears it at a boundary.
 *
 * A note is heard when it is struck. Waiting for note-off would drop still-sounding notes out of
 * the window, and the fit reads that gap as a deviation: an identity take scored six notes of a
 * bar and reported itself 4.4 bpm slow.
 */
import type { StudentNote } from './matcher';

/** Long enough for the tracker's window and a two-bar verdict, with room to spare. */
const KEEP_NOTES = 400;

const NOTE_ON = 0x90;
const NOTE_OFF = 0x80;

type LiveInputOptions = {
    /** Refuses the app's own playing coming back, and silent key presses. `disklavier/gate.ts`. */
    readonly accepts?: (data: Uint8Array, atMs: number) => boolean;
    /** Called after every accepted message, with the buffer as it now stands. */
    readonly onHeard: (played: readonly StudentNote[], atMs: number) => void;
};

export type LiveInput = {
    /** Everything struck so far, oldest first, with any still-held note ending at `atMs`. */
    played(atMs: number): StudentNote[];
    /** Feed one raw MIDI message. Exposed so the loop can be driven without a browser. */
    receive(data: Uint8Array, atMs: number): void;
    /** Forget the take. The lesson's memory of what it corrected is kept elsewhere. */
    clear(): void;
    /** Stop listening and release the input. */
    dispose(): void;
};

type Struck = { pitch: number; onsetMs: number; velocity: number; releasedAtMs: number | null };

const isNoteOn = (data: Uint8Array) => (data[0] & 0xf0) === NOTE_ON && data[2] > 0;
const isNoteOff = (data: Uint8Array) =>
    (data[0] & 0xf0) === NOTE_OFF || ((data[0] & 0xf0) === NOTE_ON && data[2] === 0);

export const createLiveInput = (options: LiveInputOptions): LiveInput => {
    let struck: Struck[] = [];
    const held = new Map<number, Struck>();
    let disposed = false;

    const played = (atMs: number): StudentNote[] =>
        struck.map((note, index) => ({
            id: `s${index}`,
            pitch: note.pitch,
            onset: note.onsetMs / 1000,
            duration: Math.max(0.01, ((note.releasedAtMs ?? atMs) - note.onsetMs)) / 1000,
            velocity: note.velocity,
        }));

    return {
        played,

        receive(data, atMs) {
            if (disposed) return;
            if (options.accepts && !options.accepts(data, atMs)) return;

            if (isNoteOn(data)) {
                // A key struck again without a note-off in between: the first sounding ends here.
                const stillHeld = held.get(data[1]);
                if (stillHeld && stillHeld.releasedAtMs === null) stillHeld.releasedAtMs = atMs;

                const note: Struck = { pitch: data[1], onsetMs: atMs, velocity: data[2], releasedAtMs: null };
                held.set(data[1], note);
                struck.push(note);
                if (struck.length > KEEP_NOTES) struck = struck.slice(-KEEP_NOTES);
            } else if (isNoteOff(data)) {
                const note = held.get(data[1]);
                if (note) {
                    note.releasedAtMs = atMs;
                    held.delete(data[1]);
                }
            } else {
                return; // control changes carry the pedal, which the fit does not read yet
            }

            options.onHeard(played(atMs), atMs);
        },

        clear() {
            struck = [];
            held.clear();
        },

        dispose() {
            disposed = true;
            struck = [];
            held.clear();
        },
    };
};

/**
 * Attaches a {@link LiveInput} to a Web MIDI port. Returns the detach, so whoever opened the
 * input is the one that closes it.
 */
export const listenTo = (input: MIDIInput, live: LiveInput): (() => void) => {
    const handler = (message: MIDIMessageEvent) => {
        if (message.data) live.receive(new Uint8Array(message.data), message.timeStamp);
    };
    input.addEventListener('midimessage', handler as EventListener);
    return () => input.removeEventListener('midimessage', handler as EventListener);
};
