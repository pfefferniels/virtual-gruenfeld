import { MidiFile, read, write } from "midifile-ts";
import { exportMPM, MPM } from "mpm-ts";
import { importWork, MSM } from "mpmify";
import { useEffect, useMemo, useRef, useState } from "react";
import { asMSM } from "./asMSM";
import { usePiano } from "react-pianosound";

type MidiMessageEvent = { tMs: number; data: Uint8Array };

/** -------------------- MIDI -> SMF helpers -------------------- **/

const clampInt = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n | 0));
const u16be = (n: number) => new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
const u32be = (n: number) =>
    new Uint8Array([(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);

const vlq = (value: number) => {
    let v = Math.max(0, value >>> 0);
    const bytes: number[] = [v & 0x7f];
    v >>= 7;
    while (v > 0) {
        bytes.unshift((v & 0x7f) | 0x80);
        v >>= 7;
    }
    return new Uint8Array(bytes);
};

const concatBytes = (chunks: Uint8Array[]) => {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.length;
    }
    return out;
};

const isRealtimeStatus = (status: number) => status >= 0xf8 && status <= 0xff;

const buildSmfFromMessages = (
    messages: MidiMessageEvent[],
    opts?: { ticksPerQuarter?: number; bpm?: number }
): Uint8Array => {
    const tpq = opts?.ticksPerQuarter ?? 480;
    const bpm = opts?.bpm ?? 120;
    const usPerQuarter = Math.round(60_000_000 / bpm);
    const ticksPerMs = (tpq * bpm) / 60_000;

    const msgs = messages
        .slice()
        .sort((a, b) => (a.tMs === b.tMs ? 0 : a.tMs < b.tMs ? -1 : 1));

    const trackChunks: Uint8Array[] = [];

    // Tempo meta at start (so ms->ticks mapping is meaningful)
    trackChunks.push(
        vlq(0),
        new Uint8Array([
            0xff, 0x51, 0x03,
            (usPerQuarter >> 16) & 0xff,
            (usPerQuarter >> 8) & 0xff,
            usPerQuarter & 0xff
        ])
    );

    let lastMs = msgs.length ? msgs[0].tMs : 0;

    for (let i = 0; i < msgs.length; i++) {
        const { tMs, data } = msgs[i];
        if (!data || data.length === 0) continue;

        const status = data[0];

        // Ignore realtime single-byte messages (clock/start/stop/active sensing)
        if (isRealtimeStatus(status) && data.length === 1) continue;

        const deltaMs = i === 0 ? 0 : Math.max(0, tMs - lastMs);
        lastMs = tMs;

        const deltaTicks = clampInt(Math.round(deltaMs * ticksPerMs), 0, 0x0fffffff);
        trackChunks.push(vlq(deltaTicks));

        if (status === 0xf0 || status === 0xf7) {
            // SMF SysEx: F0/F7 <len> <payload>
            const payload = data.slice(1);
            trackChunks.push(new Uint8Array([status]), vlq(payload.length), payload);
        } else {
            // Channel + system common messages: write as-is
            trackChunks.push(data);
        }
    }

    // End-of-track
    trackChunks.push(vlq(0), new Uint8Array([0xff, 0x2f, 0x00]));

    const trackData = concatBytes(trackChunks);

    // SMF header: format 0, 1 track
    const header = concatBytes([
        new Uint8Array([0x4d, 0x54, 0x68, 0x64]), // MThd
        u32be(6),
        u16be(0),
        u16be(1),
        u16be(tpq),
    ]);

    const track = concatBytes([
        new Uint8Array([0x4d, 0x54, 0x72, 0x6b]), // MTrk
        u32be(trackData.length),
        trackData,
    ]);

    return concatBytes([header, track]);
};

const assertOk = async (r: Response) => {
    if (r.ok) return;
    let text = '';
    try { text = await r.text(); } catch { /* ignore */ }
    throw new Error(`HTTP ${r.status} ${r.statusText}${text ? `: ${text}` : ''}`);
};

const implant = async (msm: MSM, midi: MidiFile, log: (msg: string) => void): Promise<{ from: number; to: number }> => {
    const midiBytes = write(midi.tracks, midi.header.ticksPerBeat);
    const response = await fetch('http://localhost:8000/implant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            notes: msm.allNotes,
            midi: Array.from(midiBytes),
        }),
    });
    await assertOk(response);
    const data = await response.json();
    msm.allNotes = data.notes;
    console.log('all notes', msm.allNotes);
    log(`IMPLANT: ${data.range.to - data.range.from}, notes implanted: ${data.notes.length}, note names: ${msm.allNotes.filter(n => (n.date >= data.range.from) && (n.date <= data.range.to)).map(n => n.pitchname).join(', ')}`);
    return data.range;
};

/** -------------------- Safe MIDI waiting (replaces throwing version) -------------------- **/

type MidiStartResult =
    | { ok: true; dispose: () => void }
    | { ok: false; error: string };

/**
 * NOTE: Added `log` callback for verbose streaming debug output.
 */
const waitForPlayingSafe = async (
    msm: MSM,
    callback: (msm: MSM, range: { from: number; to: number }) => void,
    log: (msg: string) => void
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

    const SILENCE_MS = 2000;

    const clearTimer = () => {
        if (finishTimer !== null) window.clearTimeout(finishTimer);
        finishTimer = null;
    };

    const resetTimer = () => {
        clearTimer();
        finishTimer = window.setTimeout(() => {
            log(`MIDI: silence timeout (${SILENCE_MS}ms) hit -> finishing take (events=${events.length})`);
            void onFinish();
        }, SILENCE_MS);
    };

    const onFinish = async () => {
        if (disposed) return;
        if (finishing) return;
        if (events.length === 0) return;

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

            log(`IMPLANT: sending to /implant (notes=${msm.allNotes?.length ?? 'unknown'})…`);
            const range = await implant(msm, midiFile, log);
            log(`IMPLANT: done -> range=[${range.from}, ${range.to}], notesNow=${msm.allNotes?.length ?? 'unknown'}`);

            if (!disposed) callback(msm, range);
        } catch (e) {
            log(`ERROR: onFinish failed -> ${String(e)}`);
            throw e; // keep behavior: your outer try/catch in React will surface it
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
            if (disposed) return;
            if (!message.data) return;

            const status = message.data[0] ?? 0;

            // Ignore realtime single-byte messages (clock/start/stop/active sensing, etc.)
            if (isRealtimeStatus(status) && message.data.length === 1) return;

            // Copy because browser may reuse the buffer
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

        // Existing inputs
        access.inputs.forEach(attachInput);

        // Future inputs
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

const performAsMIDI = async (mei: string, mpm: MPM, range: { from: number, to: number }): Promise<MidiFile | undefined> => {
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

    // decode base64 to ArrayBuffer
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    const midiBuffer = bytes.buffer;

    const file = read(midiBuffer)
    return file
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mpmify = (msm: MSM, infoJson: any): MPM => {
    const mpm = new MPM();
    const { transformers } = importWork(infoJson);
    transformers.forEach(transformer => {
        transformer.run(msm, mpm);
    });
    return mpm;
};

type InstructionDiff = {
    id: string;
    type: 'dynamics' | 'tempo';
    diffs: Record<string, { ref: number; student: number; delta: number }>;
    magnitude: number; // for sorting by significance
};

// Thresholds below which differences are ignored
const THRESHOLDS = {
    volume: 4,
    bpm: 4,
    "transition.to": 4,
};

const diff = (mpm1: MPM, mpm2: MPM, topN: number = 10): string => {
    const allInstructions = mpm1.getInstructions();

    // Index mpm2 instructions by xml:id+type
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idx = new Map<string, any>();
    for (const i of mpm2.getInstructions()) {
        const key = `${i.type}::${i["xml:id"]}`;
        idx.set(key, i);
    }

    const peaks: InstructionDiff[] = [];

    for (const instruction of allInstructions) {
        const key = `${instruction.type}::${instruction["xml:id"]}`;
        const corresp = idx.get(key);
        if (!corresp) continue;

        if (instruction.type === 'dynamics' && corresp.type === 'dynamics') {
            if (typeof corresp.volume !== 'number' || typeof instruction.volume !== 'number') continue;
            if (typeof corresp["transition.to"] !== 'number' || typeof instruction["transition.to"] !== 'number') continue;

            const deltaVolume = corresp.volume - instruction.volume;
            const deltaTransition = corresp["transition.to"] - instruction["transition.to"];

            // Skip if both deltas are below their thresholds
            if (Math.abs(deltaVolume) < THRESHOLDS.volume && Math.abs(deltaTransition) < THRESHOLDS["transition.to"]) continue;

            const magnitude = Math.abs(deltaVolume) + Math.abs(deltaTransition);
            peaks.push({
                id: instruction["xml:id"],
                type: 'dynamics',
                diffs: {
                    volume: { ref: instruction.volume, student: corresp.volume, delta: deltaVolume },
                    "transition.to": { ref: instruction["transition.to"], student: corresp["transition.to"], delta: deltaTransition },
                },
                magnitude,
            });
        } else if (instruction.type === 'tempo' && corresp.type === 'tempo') {
            if (typeof corresp.bpm !== 'number' || typeof instruction.bpm !== 'number') continue;
            if (typeof corresp["transition.to"] !== 'number' || typeof instruction["transition.to"] !== 'number') continue;

            const deltaBpm = corresp.bpm - instruction.bpm;
            const deltaTransition = corresp["transition.to"] - instruction["transition.to"];

            // Skip if both deltas are below their thresholds
            if (Math.abs(deltaBpm) < THRESHOLDS.bpm && Math.abs(deltaTransition) < THRESHOLDS["transition.to"]) continue;

            const magnitude = Math.abs(deltaBpm) + Math.abs(deltaTransition);
            peaks.push({
                id: instruction["xml:id"],
                type: 'tempo',
                diffs: {
                    bpm: { ref: instruction.bpm, student: corresp.bpm, delta: deltaBpm },
                    "transition.to": { ref: instruction["transition.to"], student: corresp["transition.to"], delta: deltaTransition },
                },
                magnitude,
            });
        }
    }

    // Sort by magnitude descending, take top N
    peaks.sort((a, b) => b.magnitude - a.magnitude);
    const topPeaks = peaks.slice(0, topN);

    if (topPeaks.length === 0) {
        return "No significant differences found.";
    }

    // Format compactly for prompt consumption
    const lines = topPeaks.map((p) => {
        const diffParts = Object.entries(p.diffs)
            .map(([attr, { ref, student, delta }]) => {
                const sign = delta > 0 ? '+' : '';
                return `${attr}: ${ref.toFixed(1)}→${student.toFixed(1)} (${sign}${delta.toFixed(1)})`;
            })
            .join(', ');
        return `[${p.type}] ${p.id}: ${diffParts}`;
    });

    return `Top ${topPeaks.length} differences (ref→student):\n${lines.join('\n')}`;
};

const explainDiff = async (
    mpm1: MPM,
    mpm2: MPM,
    onDelta: (text: string) => void
): Promise<void> => {
    const diffSummary = diff(mpm1, mpm2);
    if (diffSummary === "No significant differences found.") {
        onDelta(diffSummary);
        return;
    }

    const response = await fetch('/explain/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diff: diffSummary }),
    });
    await assertOk(response);

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    let done = false;
    while (!done) {
        const result = await reader.read();
        done = result.done;
        const value = result.value;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

        let eventType = '';
        for (const line of lines) {
            if (line.startsWith('event: ')) {
                eventType = line.slice(7);
            } else if (line.startsWith('data: ') && eventType === 'delta') {
                onDelta(line.slice(6));
            }
        }
    }
};

const exaggerate = (mpm1: MPM, mpm2: MPM, aggressiveness: number = 1, log: (msg: string) => void) => {
    const allInstructions = mpm1.getInstructions();

    // Pre-index mpm2 instructions by xml:id+type for speed and determinism
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idx = new Map<string, any>();
    for (const i of mpm2.getInstructions()) {
        const key = `${i.type}::${i["xml:id"]}`;
        idx.set(key, i);
    }

    for (const instruction of allInstructions) {
        const key = `${instruction.type}::${instruction["xml:id"]}`;
        const corresp = idx.get(key);
        if (!corresp) continue;

        if (instruction.type === 'dynamics' && corresp.type === 'dynamics') {
            if (typeof corresp.volume !== 'number' || typeof instruction.volume !== 'number') continue;
            if (typeof corresp["transition.to"] !== 'number' || typeof instruction["transition.to"] !== 'number') continue;

            const diffStart = corresp.volume - instruction.volume;
            const diffEnd = corresp["transition.to"] - instruction["transition.to"];

            // exaggerate reference away from student (so contrast is clearer)
            instruction.volume -= diffStart * aggressiveness;
            instruction["transition.to"] -= diffEnd * aggressiveness;
            log(`exaggerate dynamics ${instruction["xml:id"]} ${JSON.stringify({ diffStart, diffEnd, newVolume: instruction.volume, newTransitionTo: instruction["transition.to"] })}`);
        } else if (instruction.type === 'tempo' && corresp.type === 'tempo') {
            if (typeof corresp.bpm !== 'number' || typeof instruction.bpm !== 'number') continue;
            if (typeof corresp["transition.to"] !== 'number' || typeof instruction["transition.to"] !== 'number') continue;

            const diffStart = corresp.bpm - instruction.bpm;
            const diffEnd = corresp["transition.to"] - instruction["transition.to"];

            instruction.bpm -= diffStart * aggressiveness;
            instruction["transition.to"] -= diffEnd * aggressiveness;
            log(`exaggerate tempo ${instruction["xml:id"]} ${JSON.stringify({ diffStart, diffEnd, newBpm: instruction.bpm, newTransitionTo: instruction["transition.to"] })}`);
        }
    }
};

export const Dialog = () => {
    const [explanation, setExplanation] = useState<string>('');

    const [debugLines, setDebugLines] = useState<string[]>([]);
    const seqRef = useRef(0);

    const { play } = usePiano();

    // stable logger; keeps last N lines; also prints to console
    const log = useMemo(() => {
        const MAX_LINES = 500;

        return (msg: string) => {
            const n = ++seqRef.current;
            const ts = new Date().toISOString();
            const line = `${n.toString().padStart(4, '0')} ${ts} ${msg}`;

            // Console (still useful)
            console.log(line);

            // UI stream
            setDebugLines((prev) => {
                const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev.slice();
                next.push(line);
                return next;
            });
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        let disposeMidi: null | (() => void) = null;

        const fetchData = async () => {
            try {
                log('APP: boot');

                log('FETCH: info.json');
                let response = await fetch('info.json');
                await assertOk(response);
                const transformations = await response.text();
                log(`FETCH: info.json ok (bytes=${transformations.length})`);

                log('FETCH: score.mei');
                response = await fetch('score.mei');
                await assertOk(response);
                const mei = await response.text();
                log(`FETCH: score.mei ok (bytes=${mei.length})`);

                log('MSM: asMSM(score.mei)…');
                const base = await asMSM(mei);
                log(`MSM: ready (notes=${JSON.stringify(base.allNotes[0]) ?? 'unknown'})`);

                log('MPM: building referenceMpm…');
                const referenceMpm = mpmify(base, transformations);
                log(`MPM: referenceMpm ready (instructions=${referenceMpm.getInstructions().length})`);

                log('MIDI: starting listener…');
                const res = await waitForPlayingSafe(base, async (studentMsm: MSM, range) => {
                    if (cancelled) return;

                    log(`CALLBACK: take implanted -> range=[${range.from}, ${range.to}]`);

                    log('MPM: building studentMpm…');
                    const studentMpm = mpmify(studentMsm, transformations);
                    log(`MPM: studentMpm ready (instructions=${studentMpm.getInstructions().length})`);

                    const ref = referenceMpm.clone(); // original performance characteristics
                    setExplanation('');
                    explainDiff(ref, studentMpm, (delta) => {
                        if (cancelled) return;
                        setExplanation((prev) => prev + delta);
                    });
                    if (cancelled) return;

                    exaggerate(ref, studentMpm, 1.2, log);

                    if (cancelled) return;
                    const midi = await performAsMIDI(mei, ref, range);
                    if (midi) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        play(midi as any);
                        log('PLAY: done');
                    }
                }, log);

                if (!res.ok) {
                    setExplanation(res.error);
                    log(`MIDI: failed -> ${res.error}`);
                    return;
                }

                disposeMidi = res.dispose;
                log('APP: ready');
            } catch (err) {
                const msg = `APP ERROR: ${String(err)}`;
                setExplanation(msg);
                log(msg);
            }
        };

        void fetchData();

        return () => {
            cancelled = true;
            log('APP: unmount -> disposing MIDI');
            if (disposeMidi) disposeMidi();
        };
    }, [log, play]);

    return (
        <div style={{ display: 'grid', gap: 12 }}>
            <div>{explanation}</div>

            <div style={{ border: '1px solid #ccc', borderRadius: 8, padding: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <strong>Debug</strong>
                    <button
                        onClick={() => setDebugLines([])}
                        style={{ padding: '4px 8px', cursor: 'pointer' }}
                    >
                        Clear
                    </button>
                    <span style={{ opacity: 0.7, fontSize: 12 }}>{debugLines.length} lines</span>
                </div>

                <pre
                    style={{
                        margin: 0,
                        maxHeight: 260,
                        overflow: 'auto',
                        fontSize: 12,
                        lineHeight: 1.35,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                    }}
                >
                    {debugLines.join('\n')}
                </pre>
            </div>
        </div>
    );
};
