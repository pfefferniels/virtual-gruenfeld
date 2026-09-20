/**
 * One instrument, two directions.
 *
 * The student plays the Disklavier and the app answers on the same keys, so what goes out and what
 * comes in are not two systems but one: every message sent is a message that may arrive again a
 * moment later. This is what holds the two sides together — the echo guard is filled by the
 * demonstration and read by the gate — and it owns the demonstration in flight, so there is never
 * more than one and starting a second stops the first.
 */
import { createEchoGuard, type EchoPolicy } from './echo';
import { createInputGate, type SilentPressPolicy } from './gate';
import {
    startDemonstration,
    LOOKAHEAD_MS,
    MIDI_IN_DELAY_MS,
    PUMP_INTERVAL_MS,
    type Demonstration,
} from './demonstrate';
import { pageTiming, type Timing } from './clock';
import type { DemonstrationPlan } from './plan';
import type { MidiPort } from './port';

export type DisklavierOptions = {
    readonly port: MidiPort;
    readonly timing?: Timing;
    /** Set to 0 where the instrument's MIDI IN Delay is switched off. */
    readonly leadMs?: number;
    readonly lookaheadMs?: number;
    readonly pumpIntervalMs?: number;
    readonly echo?: EchoPolicy;
    readonly silentPresses?: SilentPressPolicy;
};

export type Disklavier = {
    /** Play `plan`, whose first note sounds at `startAtMs` on the page clock. Stops whatever was playing. */
    demonstrate(plan: DemonstrationPlan, startAtMs: number): Demonstration;
    /** Whether this incoming message is the student's own playing. */
    accepts(data: Uint8Array, atMs: number): boolean;
    /** Take the hands off the keys. */
    silence(): void;
};

export const createDisklavier = ({
    port,
    timing = pageTiming,
    leadMs = MIDI_IN_DELAY_MS,
    lookaheadMs = LOOKAHEAD_MS,
    pumpIntervalMs = PUMP_INTERVAL_MS,
    echo: echoPolicy,
    silentPresses,
}: DisklavierOptions): Disklavier => {
    const echo = createEchoGuard(echoPolicy);
    const gate = createInputGate(echo, silentPresses);
    const deps = { port, timing, echo, leadMs, lookaheadMs, pumpIntervalMs };

    let playing: Demonstration | null = null;

    const silence = (): void => {
        playing?.stop();
        playing = null;
    };

    return {
        demonstrate(plan, startAtMs) {
            silence();
            playing = startDemonstration(deps, plan, startAtMs);
            return playing;
        },

        accepts: (data, atMs) => gate.accepts(data, atMs),

        silence,
    };
};
