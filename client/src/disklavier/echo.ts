/**
 * Recognising the app's own playing when the instrument reflects it back.
 *
 * The Mark III manual states that during playback, and for data received at MIDI IN, nothing is
 * sent to MIDI OUT "except for pedal data", because "unlike the keyboard, the pedals cannot
 * distinguish whether they are being activated by foot or by data". So Grünfeld's own pedalling
 * arrives as input, and if it were not recognised the app would measure his reading as the
 * student's. That is the failure this guard exists to prevent, and it is why notes are filtered by
 * default too although the Mark III says they do not come back: the generations differ, ENSPIRE is
 * unverified, and being wrong in that direction is far more expensive than being wrong in the
 * other.
 *
 * Two things are matched loosely on purpose.
 *
 * *Velocity is ignored for notes.* A reflection is the same key at the same moment; a device that
 * re-derived the byte would otherwise let the whole demonstration through.
 *
 * *The window spans both hypotheses about the 500 ms MIDI IN Delay.* Yamaha document that the delay
 * exists to remove the velocity-dependent spread in when a note sounds, but not whether MIDI OUT is
 * tapped before or after it. Until that is measured the window runs from shortly before the bytes
 * were due to arrive to shortly after they would have sounded.
 *
 * An expectation is consumed by the reflection that matches it, so a student pedalling in the same
 * window as one of Grünfeld's moves still gets through on the second message. Where they pedal to
 * exactly the same value at exactly the same moment, nothing in the data distinguishes them, and
 * this guard prefers to lose the student's.
 */
import { controlKey, pitchKey, type ChannelMessage } from './midiMessage';

export type EchoPolicy = {
    /** Mark III: the pedals cannot tell foot from data, so what is sent comes back. */
    readonly pedal: boolean;
    /** Mark III says strikes are not reflected. Unverified elsewhere, so filtered until it is. */
    readonly notes: boolean;
    /** Yamaha's MIDI IN Delay. */
    readonly delayMs: number;
    /** Bus serialisation, the handler's own lateness, and the two taps the delay could sit between. */
    readonly slackMs: number;
};

export const LIVE_ECHO: EchoPolicy = { pedal: true, notes: true, delayMs: 500, slackMs: 60 };

export type EchoGuard = {
    /** Record a message on its way out, so that its reflection can be recognised. */
    expect(message: ChannelMessage, sentAtMs: number): void;
    /** True when this incoming message is one of ours, which consumes the expectation. */
    isEcho(message: ChannelMessage, atMs: number): boolean;
};

/** Everything a reflection is expected to preserve. Note velocity is not part of it. */
const echoKey = (message: ChannelMessage): string =>
    message.kind === 'control'
        ? `control:${controlKey(message)}:${message.value}`
        : `${message.kind}:${pitchKey(message)}`;

export const createEchoGuard = (policy: EchoPolicy = LIVE_ECHO): EchoGuard => {
    const expected = new Map<string, number[]>();

    const watched = (message: ChannelMessage): boolean =>
        message.kind === 'control' ? policy.pedal : policy.notes;

    const forget = (beforeMs: number): void => {
        expected.forEach((times, key) => {
            const live = times.filter((sentAtMs) => sentAtMs >= beforeMs);
            if (live.length === 0) expected.delete(key);
            else expected.set(key, live);
        });
    };

    return {
        expect(message, sentAtMs) {
            if (!watched(message)) return;
            const key = echoKey(message);
            const times = expected.get(key);
            if (times) times.push(sentAtMs);
            else expected.set(key, [sentAtMs]);
        },

        isEcho(message, atMs) {
            if (!watched(message)) return false;
            forget(atMs - policy.delayMs - policy.slackMs);

            const times = expected.get(echoKey(message));
            if (!times) return false;

            const index = times.findIndex(
                (sentAtMs) =>
                    atMs >= sentAtMs - policy.slackMs &&
                    atMs <= sentAtMs + policy.delayMs + policy.slackMs,
            );
            if (index < 0) return false;

            times.splice(index, 1);
            if (times.length === 0) expected.delete(echoKey(message));
            return true;
        },
    };
};
