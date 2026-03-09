import { read } from "midifile-ts";
import { MSM } from "mpmify";
import { buildSmfFromMessages, isRealtimeStatus, MidiMessageEvent } from "./smf";
import { implant } from "./api";
import type { Range } from "./mpm";

export type MidiStartResult =
    | { ok: true; dispose: () => void }
    | { ok: false; error: string };

export const waitForPlayingSafe = async (
    msm: MSM,
    callback: (msm: MSM, range: Range) => void,
    log: (msg: string) => void,
    getDateHint?: () => number | undefined,
): Promise<MidiStartResult> => {
    if (!('requestMIDIAccess' in navigator) || typeof navigator.requestMIDIAccess !== 'function') {
        log('MIDI: navigator.requestMIDIAccess unavailable -> no Web MIDI support');
        return { ok: false, error: 'No Web MIDI support (navigator.requestMIDIAccess unavailable).' };
    }

    log('MIDI: requesting MIDI access…');

    let events: MidiMessageEvent[] = [];
    let finishTimer: number | null = null;
    let finishing = false;
    let disposed = false;

    const SILENCE_BASE_MS = 1200;
    const SILENCE_SHORT_MS = 800;
    const NOTES_FOR_SHORT = 20;

    const getNoteOnCount = () =>
        events.filter(e => (e.data[0] & 0xf0) === 0x90 && e.data[2] > 0).length;

    const clearTimer = () => {
        if (finishTimer !== null) window.clearTimeout(finishTimer);
        finishTimer = null;
    };

    const resetTimer = () => {
        clearTimer();
        const silenceMs = getNoteOnCount() >= NOTES_FOR_SHORT ? SILENCE_SHORT_MS : SILENCE_BASE_MS;
        finishTimer = window.setTimeout(() => {
            log(`MIDI: silence timeout (${silenceMs}ms) hit -> finishing take (events=${events.length})`);
            void onFinish();
        }, silenceMs);
    };

    const onFinish = async () => {
        if (disposed || finishing || events.length === 0) return;

        finishing = true;
        try {
            const take = events;
            events = [];
            clearTimer();

            const t0 = take[0].tMs;
            const normalized = take.map(e => ({ tMs: e.tMs - t0, data: e.data }));

            log(`MIDI: finishing take -> rawEvents=${take.length}, durationMs≈${Math.round(take[take.length - 1].tMs - t0)}`);

            const smfBytes = buildSmfFromMessages(normalized, { ticksPerQuarter: 480, bpm: 120 });
            log(`MIDI: built SMF bytes len=${smfBytes.length}`);

            const midiFile = read(smfBytes);
            log(`MIDI: parsed SMF -> tracks=${midiFile.tracks.length}, tpq=${midiFile.header.ticksPerBeat}`);

            const dateHint = getDateHint?.();
            log(`IMPLANT: sending to /implant (notes=${msm.allNotes?.length ?? 'unknown'}, dateHint=${dateHint ?? 'none'})…`);
            const { studentMsm, range } = await implant(msm, midiFile, log, dateHint);
            log(`IMPLANT: done -> range=[${range.from}, ${range.to}], notesNow=${studentMsm.allNotes?.length ?? 'unknown'}`);

            if (!disposed) callback(studentMsm, range);
        } catch (e) {
            log(`ERROR: onFinish failed -> ${String(e)}`);
            throw e;
        } finally {
            finishing = false;
        }
    };

    const attachedInputs = new Set<MIDIInput>();
    let accessRef: MIDIAccess | null = null;

    const inputName = (input: MIDIInput) =>
        `${input.manufacturer ?? 'Unknown'} ${input.name ?? '(unnamed)'} [${input.id}]`;

    const attachInput = (input: MIDIInput) => {
        if (attachedInputs.has(input)) return;
        attachedInputs.add(input);

        log(`MIDI: attach input -> ${inputName(input)}`);

        input.onmidimessage = (message) => {
            if (disposed || !message.data) return;

            const status = message.data[0] ?? 0;
            if (isRealtimeStatus(status) && message.data.length === 1) return;

            events.push({ tMs: message.timeStamp, data: new Uint8Array(message.data) });
            resetTimer();
        };
    };

    const detachAll = () => {
        disposed = true;
        clearTimer();
        log(`MIDI: detachAll (inputs=${attachedInputs.size})`);

        for (const input of attachedInputs) {
            try { input.onmidimessage = null; } catch { /* ignore */ }
        }
        attachedInputs.clear();

        if (accessRef) {
            try { accessRef.onstatechange = null; } catch { /* ignore */ }
            accessRef = null;
        }
    };

    try {
        const access = await navigator.requestMIDIAccess();
        if (disposed) return { ok: true, dispose: detachAll };

        accessRef = access;

        const inputs = Array.from(access.inputs.values());
        const outputs = Array.from(access.outputs.values());

        log(`MIDI: access granted. inputs=${inputs.length}, outputs=${outputs.length}`);
        for (const inp of inputs) log(`MIDI: input available -> ${inputName(inp)}`);

        access.inputs.forEach(attachInput);

        access.onstatechange = (e) => {
            if (disposed) return;
            const port = e.port;
            log(`MIDI: statechange -> type=${port?.type}, state=${port?.state}, name=${(port as MIDIPort)?.name ?? ''}`);

            if (port && port.type === 'input' && port.state === 'connected') {
                attachInput(port as MIDIInput);
            }
        };

        log('MIDI: ready (listening for input)…');
        return { ok: true, dispose: detachAll };
    } catch (err) {
        detachAll();
        log(`MIDI: requestMIDIAccess failed -> ${String(err)}`);
        return { ok: false, error: `Failed to get MIDI access: ${String(err)}` };
    }
};
