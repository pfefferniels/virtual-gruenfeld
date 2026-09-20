/**
 * What of the incoming stream is the student actually playing.
 *
 * Two things arrive that are not: the app's own demonstration reflected back ({@link EchoGuard}),
 * and key presses that never reached a string. `Key Touch` defaults to ON, and the Disklavier
 * senses key motion rather than sound — it records and reproduces key movements that produced no
 * tone at all. Those presses would otherwise reach the matcher as notes the student played.
 *
 * What a silent press looks like on the wire is not stated in any Yamaha document I could find,
 * and velocity 0 is already a note-off by convention, so the filter is a velocity floor with a
 * deliberately timid default: velocity 1 sounds on no piano, and anything above it is left alone
 * until the real threshold is measured on the instrument, per register (LIVE.md §5).
 */
import { decodeChannelMessage, pitchKey } from './midiMessage';
import type { EchoGuard } from './echo';

export type SilentPressPolicy = {
    readonly enabled: boolean;
    /** Below this the key moved but no string sounded. */
    readonly minSoundingVelocity: number;
};

export const LIVE_SILENT_PRESSES: SilentPressPolicy = { enabled: true, minSoundingVelocity: 2 };

export type InputGate = {
    /** False for the app's own reflection and for a key press that never sounded. */
    accepts(data: Uint8Array, atMs: number): boolean;
};

export const createInputGate = (
    echo: EchoGuard,
    policy: SilentPressPolicy = LIVE_SILENT_PRESSES,
): InputGate => {
    /** Keys whose strike was dropped; their release has to go with it or the take holds a stray note-off. */
    const silent = new Set<number>();

    return {
        accepts(data, atMs) {
            const message = decodeChannelMessage(data);
            // Aftertouch, pitch bend, sysex, clock: nothing this path models, and nothing it judges.
            if (!message) return true;
            if (echo.isEcho(message, atMs)) return false;
            if (!policy.enabled || message.kind === 'control') return true;

            const key = pitchKey(message);
            if (message.kind === 'noteOff') return !silent.delete(key);
            if (message.velocity >= policy.minSoundingVelocity) return true;

            silent.add(key);
            return false;
        },
    };
};
