/**
 * The three bytes a piano speaks, as a value.
 *
 * A note-on with velocity 0 is a note-off by MIDI convention, and it is normalised to one here so
 * that nothing downstream has to remember it. That matters most for the echo guard, which compares
 * what this app sent against what the instrument reflected back: the two sides are written by
 * different devices and need not choose the same spelling for the same event.
 */

/** Damper, sostenuto, soft: what a Disklavier's KBD Out sends, mixed onto the note channel. */
export const DAMPER = 64;
export const SOSTENUTO = 66;
export const SOFT = 67;

export const PEDAL_CONTROLLERS: readonly number[] = [DAMPER, SOSTENUTO, SOFT];

export type NoteMessage = {
    readonly kind: 'noteOn' | 'noteOff';
    readonly channel: number;
    readonly note: number;
    readonly velocity: number;
};

export type ControlMessage = {
    readonly kind: 'control';
    readonly channel: number;
    readonly controller: number;
    readonly value: number;
};

export type ChannelMessage = NoteMessage | ControlMessage;

const NOTE_OFF = 0x80;
const NOTE_ON = 0x90;
const CONTROL_CHANGE = 0xb0;

/** Null for anything this path does not model: aftertouch, pitch bend, program change, sysex, clock. */
export const decodeChannelMessage = (data: Uint8Array): ChannelMessage | null => {
    if (data.length < 3) return null;
    const channel = data[0] & 0x0f;
    switch (data[0] & 0xf0) {
        case NOTE_ON:
            return data[2] > 0
                ? { kind: 'noteOn', channel, note: data[1], velocity: data[2] }
                : { kind: 'noteOff', channel, note: data[1], velocity: 0 };
        case NOTE_OFF:
            return { kind: 'noteOff', channel, note: data[1], velocity: data[2] };
        case CONTROL_CHANGE:
            return { kind: 'control', channel, controller: data[1], value: data[2] };
        default:
            return null;
    }
};

export const encodeChannelMessage = (message: ChannelMessage): Uint8Array =>
    message.kind === 'control'
        ? new Uint8Array([CONTROL_CHANGE | message.channel, message.controller, message.value])
        : new Uint8Array([
              (message.kind === 'noteOn' ? NOTE_ON : NOTE_OFF) | message.channel,
              message.note,
              message.velocity,
          ]);

/** The release for a strike. Zero velocity, because the reconstruction states no release velocity. */
export const releaseFor = (strike: NoteMessage, velocity = 0): NoteMessage => ({
    kind: 'noteOff',
    channel: strike.channel,
    note: strike.note,
    velocity,
});

/** One key of one channel, the identity a strike and its release share. */
export const pitchKey = (message: NoteMessage): number => (message.channel << 7) | message.note;

export const controlKey = (message: ControlMessage): number =>
    (message.channel << 7) | message.controller;
