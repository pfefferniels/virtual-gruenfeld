import { useContext, useEffect, useMemo, useState } from 'react';
import * as Tone from "../../../../react-pianosound/node_modules/tone";
import { AnyEvent, MIDIControlEvents, MidiFile } from 'midifile-ts';
import { addAbsoluteTime } from './MidiNote';
import { PianoContext } from './PianoContext';

type PianoPlaybackEvent = {
    event: AnyEvent;
    transportSeconds: number;
};

type Listener = (e: PianoPlaybackEvent) => void;
const listeners = new Set<Listener>();

function emitPlaybackEvent(data: PianoPlaybackEvent) {
    for (const fn of listeners) fn(data);
}

function convertRange(value: number, r1: [number, number], r2: [number, number]) {
    return (value - r1[0]) * (r2[1] - r2[0]) / (r1[1] - r1[0]) + r2[0];
}

type EventListener = (e: AnyEvent) => void;

type ScheduledAudioCue = {
    atSec: number;
    audioBuffer: AudioBuffer;
    onStart?: () => void;
};

type PlaybackSetupApi = {
    scheduleAudioCue: (cue: ScheduledAudioCue) => void;
    audioContext: AudioContext;
};

type PlaybackSetup = (api: PlaybackSetupApi) => void;

const isNoteOn = (e: AnyEvent) => e.type === 'channel' && e.subtype === 'noteOn';
const isNoteOff = (e: AnyEvent) => e.type === 'channel' && e.subtype === 'noteOff';

const isPedalOn = (e: AnyEvent) =>
    e.type === 'channel' &&
    e.subtype === 'controller' &&
    e.controllerType === MIDIControlEvents.SUSTAIN &&
    (e.value ?? 0) > 63;

const isPedalOff = (e: AnyEvent) =>
    e.type === 'channel' &&
    e.subtype === 'controller' &&
    e.controllerType === MIDIControlEvents.SUSTAIN &&
    (e.value ?? 0) <= 63;

const isSoftPedalOn = (e: AnyEvent) =>
    e.type === 'channel' &&
    e.subtype === 'controller' &&
    e.controllerType === MIDIControlEvents.SOFT_PEDAL &&
    (e.value ?? 0) > 63;

const isSoftPedalOff = (e: AnyEvent) =>
    e.type === 'channel' &&
    e.subtype === 'controller' &&
    e.controllerType === MIDIControlEvents.SOFT_PEDAL &&
    (e.value ?? 0) <= 63;

type MIDIOutputLike = MIDIOutput | null;

function getFirstOutput(access: MIDIAccess | null): MIDIOutputLike {
    if (!access) return null;
    for (const output of access.outputs.values()) return output;
    return null;
}

function statusNoteOn(channel: number) { return 0x90 | (channel & 0x0F); }
function statusNoteOff(channel: number) { return 0x80 | (channel & 0x0F); }
function statusCC(channel: number) { return 0xB0 | (channel & 0x0F); }
function statusPC(channel: number) { return 0xC0 | (channel & 0x0F); }

function eventChannel(e: AnyEvent): number {
    if (e.type === 'channel' && typeof e.channel === 'number') return e.channel & 0x0F;
    return 0;
}

function toMidiMessages(e: AnyEvent): Uint8Array[] {
    if (e.type !== 'channel') return [];
    const ch = eventChannel(e);
    switch (e.subtype) {
        case 'noteOn': {
            const vel = Math.max(0, Math.min(127, e.velocity ?? 64));
            return [new Uint8Array([statusNoteOn(ch), e.noteNumber & 0x7F, vel])];
        }
        case 'noteOff':
            return [new Uint8Array([statusNoteOff(ch), e.noteNumber & 0x7F, 0])];
        case 'controller': {
            const ctl = (e.controllerType ?? 0) & 0x7F;
            const val = (e.value ?? 0) & 0x7F;
            return [new Uint8Array([statusCC(ch), ctl, val])];
        }
        case 'programChange': {
            const pgm = (e.value ?? 0) & 0x7F;
            return [new Uint8Array([statusPC(ch), pgm])];
        }
        default:
            return [];
    }
}

export const usePiano = () => {
    const context = useContext(PianoContext);
    if (!context) throw new Error('usePiano must be used within a PianoContextProvider');
    const { piano, status } = context;

    const [, setMidiAccess] = useState<MIDIAccess | null>(null);
    const [midiOutput, setMidiOutput] = useState<MIDIOutputLike>(null);

    const transport = Tone.getTransport();
    const audioContext = Tone.getContext().rawContext as AudioContext;
    const usingHardware = useMemo(() => !!midiOutput, [midiOutput]);
    const activeCueSources = useMemo(() => new Set<AudioBufferSourceNode>(), []);

    useEffect(() => {
        let cancelled = false;
        let removeListener: (() => void) | undefined;

        void (async () => {
            if (!navigator.requestMIDIAccess) return;
            try {
                const access = await navigator.requestMIDIAccess({ sysex: false });
                if (cancelled) return;

                setMidiAccess(access);
                setMidiOutput(getFirstOutput(access));

                const onChange = () => setMidiOutput(getFirstOutput(access));
                access.addEventListener('statechange', onChange);
                removeListener = () => access.removeEventListener('statechange', onChange);
            } catch {
                // fall back to Tone output
            }
        })();

        return () => {
            cancelled = true;
            removeListener?.();
            transport.stop();
            transport.position = 0;
            transport.cancel();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const stopActiveCueSources = () => {
        for (const source of activeCueSources) {
            try { source.stop(); } catch { /* ignore */ }
        }
        activeCueSources.clear();
    };

    const scheduleEvents = (
        file: MidiFile,
        cb?: EventListener,
        setup?: PlaybackSetup,
    ) => {
        const events = addAbsoluteTime(file);
        const softRegions = events.reduce((arr, ev) => {
            if (isSoftPedalOn(ev)) {
                arr.push([ev.abs, null as number | null]);
            } else if (isSoftPedalOff(ev) && arr.length && arr[arr.length - 1][1] === null) {
                arr[arr.length - 1][1] = ev.abs;
            }
            return arr;
        }, new Array<[number, number | null]>());

        transport.stop();
        transport.position = 0;
        transport.cancel();
        stopActiveCueSources();

        const scheduleAudioCue = (cue: ScheduledAudioCue) => {
            transport.schedule((time) => {
                cue.onStart?.();
                const source = audioContext.createBufferSource();
                source.buffer = cue.audioBuffer;
                source.connect(audioContext.destination);
                source.onended = () => activeCueSources.delete(source);
                activeCueSources.add(source);
                source.start(time);
            }, cue.atSec);
        };

        setup?.({ scheduleAudioCue, audioContext });

        if (usingHardware) {
            for (const ev of events) {
                transport.schedule(() => {
                    cb?.(ev);
                    emitPlaybackEvent({
                        event: ev,
                        transportSeconds: transport.seconds,
                    });

                    const msgs = toMidiMessages(ev);
                    for (const msg of msgs) {
                        midiOutput!.send(Array.from(msg));
                    }
                }, ev.abs / 1000);
            }
        } else {
            if (!piano) {
                console.warn('Piano not loaded yet');
                return;
            }
            piano.toDestination();

            for (const ev of events) {
                const insideSoft =
                    softRegions.findIndex(([start, end]) => start < ev.abs && end !== null && end > ev.abs) !== -1;

                transport.schedule((time) => {
                    cb?.(ev);
                    emitPlaybackEvent({
                        event: ev,
                        transportSeconds: transport.seconds,
                    });

                    if (isNoteOn(ev)) {
                        piano.keyDown({
                            note: ev.noteNumber.toString(),
                            velocity: convertRange(ev.velocity ?? 64, [0, 127], [0, 1]) * (insideSoft ? 0.67 : 1),
                            time,
                        });
                    } else if (isNoteOff(ev)) {
                        piano.keyUp({ note: ev.noteNumber.toString(), time });
                    } else if (isPedalOn(ev)) {
                        piano.pedalDown({ time });
                    } else if (isPedalOff(ev)) {
                        piano.pedalUp({ time });
                    }
                }, ev.abs / 1000);
            }
        }
    };

    const play = (file: MidiFile, cb?: EventListener, setup?: PlaybackSetup) => {
        scheduleEvents(file, cb, setup);

        if (transport.state !== 'started') {
            void Tone.start();
            transport.start();
        }
    };

    const playAudioBuffer = async (audioBuffer: AudioBuffer, onStart?: () => void) => {
        await Tone.start();
        if (audioContext.state === 'suspended') await audioContext.resume();

        await new Promise<void>((resolve) => {
            const source = audioContext.createBufferSource();
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                activeCueSources.delete(source);
                resolve();
            };

            source.buffer = audioBuffer;
            source.connect(audioContext.destination);
            source.onended = finish;
            activeCueSources.add(source);
            onStart?.();
            source.start();
        });
    };

    const stopAll = () => {
        transport.stop();
        transport.position = 0;
        transport.cancel();
        stopActiveCueSources();

        if (usingHardware && midiOutput) {
            for (let c = 0; c < 16; c++) {
                midiOutput.send([statusCC(c), 64, 0]);
                midiOutput.send([statusCC(c), 123, 0]);
            }
        } else if (piano) {
            piano.stopAll();
        }
    };

    const playSingleNote = (pitch: number, durationMs = 500, velocity?: number) => {
        if (usingHardware && midiOutput) {
            const c = 0;
            const vel = Math.max(0, Math.min(127, Math.round((velocity ?? 0.8) * 127)));

            midiOutput.send([statusNoteOn(c), pitch & 0x7F, vel]);
            window.setTimeout(() => {
                midiOutput.send([statusNoteOff(c), pitch & 0x7F, 0]);
            }, durationMs);
            midiOutput.send([statusCC(c), 64, 0]);
            return;
        }

        if (!piano) return;
        piano.toDestination();
        piano.keyDown({ note: pitch.toString(), velocity });
        window.setTimeout(() => piano.keyUp({ note: pitch.toString() }), durationMs);
    };

    const jumpTo = (seconds: number) => {
        transport.seconds = Math.max(0, seconds);
    };

    const unlock = async () => {
        await Tone.start();
        if (audioContext.state === 'suspended') await audioContext.resume();
    };

    return {
        status,
        play,
        playAudioBuffer,
        playSingleNote,
        stop: stopAll,
        jumpTo,
        unlock,
        audioContext,
        device: midiOutput?.name ?? 'synthetic',
    };
};
