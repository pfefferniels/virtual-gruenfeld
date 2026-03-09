import { MidiFile, read } from "midifile-ts";
import { exportMPM, MPM } from "mpm-ts";
import { MSM } from "mpmify";
import type { Range } from "./mpm";
import { implantLocal } from "./matcher";

export const assertOk = async (r: Response) => {
    if (r.ok) return;
    let text = '';
    try { text = await r.text(); } catch { /* ignore */ }
    throw new Error(`HTTP ${r.status} ${r.statusText}${text ? `: ${text}` : ''}`);
};

export const implant = (
    msm: MSM,
    midi: MidiFile,
    log: (msg: string) => void,
    dateHint?: number,
): Promise<{ studentMsm: MSM; range: Range }> => {
    if (dateHint != null) {
        log(`IMPLANT: using date_hint=${dateHint}`);
    }
    log(`IMPLANT: matching ${msm.allNotes?.length ?? 0} ref notes against student MIDI…`);

    const { studentMsm, range } = implantLocal(msm, midi, dateHint);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    log(`IMPLANT: range=[${range.from}, ${range.to}], notes: ${studentMsm.allNotes.length}, implanted: ${studentMsm.allNotes.filter((n: any) => n.source === 'implanted').length}`);
    return Promise.resolve({ studentMsm, range });
};

export const performAsMIDI = async (mei: string, mpm: MPM, range: Range): Promise<MidiFile | undefined> => {
    console.log('performing range:', range, 'with mpm:', exportMPM(mpm));
    const response = await fetch('http://localhost:8080/perform', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mei, mpm: exportMPM(mpm),
            ...range
        }),
    });
    await assertOk(response);
    const payload = await response.json();
    const b64 = payload?.midi_b64;
    if (!b64) {
        console.log('No midi_b64 field in response');
        return;
    }

    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return read(bytes.buffer);
};

// Shared AudioContext for TTS — survives across calls and doesn't need
// a fresh user-gesture for each .play(), only for the initial resume().
let _ttsCtx: AudioContext | null = null;

function getTtsContext(): AudioContext {
    if (!_ttsCtx || _ttsCtx.state === 'closed') {
        _ttsCtx = new AudioContext();
    }
    return _ttsCtx;
}

// Call once from a user-gesture handler (e.g. click) to unlock audio.
export const unlockAudio = () => {
    const ctx = getTtsContext();
    if (ctx.state === 'suspended') ctx.resume();
};

export const explainAndSpeak = async (
    diffSummary: string,
    onDelta: (text: string) => void,
    log: (msg: string) => void,
): Promise<void> => {
    if (diffSummary === "No significant differences found.") {
        onDelta(diffSummary);
        return;
    }

    log('EXPLAIN+SPEAK: starting…');
    const response = await fetch('/explain-and-speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diff: diffSummary }),
    });
    await assertOk(response);

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let eventType = '';
    const audioChunks: Uint8Array[] = [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
            if (line.startsWith('event: ')) {
                eventType = line.slice(7);
            } else if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (eventType === 'delta') {
                    onDelta(data);
                } else if (eventType === 'audio') {
                    const binary = atob(data);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                    audioChunks.push(bytes);
                }
            }
        }
    }

    // Play collected audio chunks
    if (audioChunks.length > 0) {
        const totalLength = audioChunks.reduce((sum, c) => sum + c.length, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of audioChunks) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }

        log(`EXPLAIN+SPEAK: playing audio (${combined.length} bytes)`);
        const ctx = getTtsContext();
        if (ctx.state === 'suspended') await ctx.resume();

        const audioBuffer = await ctx.decodeAudioData(combined.buffer);
        await new Promise<void>((resolve) => {
            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(ctx.destination);
            source.onended = () => resolve();
            source.start();
        });
        log('EXPLAIN+SPEAK: playback done');
    }
};

export const warmPerformEndpoint = () => {
    fetch('http://localhost:8080/perform', { method: 'OPTIONS' }).catch(() => {});
};
