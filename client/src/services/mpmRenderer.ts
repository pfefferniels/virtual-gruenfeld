import { MidiFile, read } from "midifile-ts";
import { exportMPM, MPM } from "mpm-ts";
import type { Range } from "../mpm/types";

const BASE_URL = 'http://localhost:8080';

const assertOk = async (r: Response) => {
    if (r.ok) return;
    let text = '';
    try { text = await r.text(); } catch { /* ignore */ }
    throw new Error(`HTTP ${r.status} ${r.statusText}${text ? `: ${text}` : ''}`);
};

const readMidiBase64 = (b64: string): MidiFile => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return read(bytes.buffer);
};

export const convert = async (mei: string): Promise<{ msm: string }> => {
    const response = await fetch(`${BASE_URL}/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mei }),
    });
    await assertOk(response);
    return response.json();
};

export const perform = async (
    mei: string,
    mpm: MPM,
    range: Range,
    opts?: { sketchiness?: number },
): Promise<MidiFile | undefined> => {
    const response = await fetch(`${BASE_URL}/perform`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mei, mpm: exportMPM(mpm),
            ...range,
            ...(opts?.sketchiness != null && opts.sketchiness > 1 ? { sketchiness: opts.sketchiness } : {}),
        }),
    });
    await assertOk(response);
    const payload = await response.json();
    const b64 = payload?.midi_b64;
    if (!b64) return undefined;
    return readMidiBase64(b64);
};

export const warmPerformEndpoint = () => {
    fetch(`${BASE_URL}/perform`, { method: 'OPTIONS' }).catch(() => {});
};
