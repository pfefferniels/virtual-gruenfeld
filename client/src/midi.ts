import { read } from "midifile-ts";
import { buildSmfFromMessages, isRealtimeStatus, MidiMessageEvent } from "./smf";
import { implant } from "./api";
import type { Range } from "./mpm";
import type { MeasuredNote } from "./score/measured";

type MidiStartResult =
    | { ok: true; dispose: () => void }
    | { ok: false; error: string };

export const waitForPlayingSafe = async (
    scoreNotes: readonly MeasuredNote[],
    callback: (notes: MeasuredNote[], range: Range) => void,
    log: (msg: string) => void,
    getDateHint?: () => number | undefined,
    inputId?: string | null,
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

    // Track currently held notes so we never trigger while keys are down.
    // Key: (channel << 7) | note, to distinguish channels.
    const activeNotes = new Set<number>();

    const getNoteOnCount = () =>
        events.filter(e => (e.data[0] & 0xf0) === 0x90 && e.data[2] > 0).length;

    const clearTimer = () => {
        if (finishTimer !== null) window.clearTimeout(finishTimer);
        finishTimer = null;
    };

    const startTimerIfIdle = () => {
        clearTimer();
        if (activeNotes.size > 0) return;
        const silenceMs = getNoteOnCount() >= NOTES_FOR_SHORT ? SILENCE_SHORT_MS : SILENCE_BASE_MS;
        finishTimer = window.setTimeout(() => {
            log(`MIDI: silence timeout (${silenceMs}ms) hit -> finishing take (events=${events.length})`);
            void onFinish();
        }, silenceMs);
    };

    const trackNoteState = (data: Uint8Array) => {
        const status = data[0] & 0xf0;
        const channel = data[0] & 0x0f;
        const note = data[1];
        const key = (channel << 7) | note;

        if (status === 0x90 && data[2] > 0) {
            activeNotes.add(key);
        } else if (status === 0x80 || (status === 0x90 && data[2] === 0)) {
            activeNotes.delete(key);
        }
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
            log(`IMPLANT: matching the take (score notes=${scoreNotes.length}, dateHint=${dateHint ?? 'none'})…`);
            const { notes, range } = await implant(scoreNotes, midiFile, log, dateHint);
            log(`IMPLANT: done -> range=[${range.from}, ${range.to}], notesNow=${notes.length}`);

            if (!disposed) callback(notes, range);
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

            const data = new Uint8Array(message.data);
            events.push({ tMs: message.timeStamp, data });
            trackNoteState(data);
            startTimerIfIdle();
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

        const shouldAttach = (input: MIDIInput) => !inputId || input.id === inputId;

        access.inputs.forEach(input => { if (shouldAttach(input)) attachInput(input); });

        access.onstatechange = (e) => {
            if (disposed) return;
            const port = e.port;
            log(`MIDI: statechange -> type=${port?.type}, state=${port?.state}, name=${(port as MIDIPort)?.name ?? ''}`);

            if (port && port.type === 'input' && port.state === 'connected' && shouldAttach(port as MIDIInput)) {
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
