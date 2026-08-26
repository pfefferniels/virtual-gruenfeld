/**
 * generate_test.ts — Full dialogic teaching pipeline test
 *
 * Generates MP3s: student playing → teacher playing with unified vocal stream.
 * Uses the /teacher-stream endpoint for a single LLM + TTS call.
 *
 * Requires:
 *   - virtual-gruenfeld server (/teacher-stream)
 *   - timidity or fluidsynth + SF2_PATH (MIDI → WAV)
 *   - ffmpeg (audio concat + MP3 encoding)
 *
 * Run:  npx tsx generate_test.ts
 */

import * as fs from 'fs';
import { execSync } from 'child_process';
import 'dotenv/config';
import { read as readMidi, write as writeMidi } from 'midifile-ts';
import { implantLocal } from './client/src/matcher';
import { measuredNotesFromMsm } from './client/src/score/measured';
import { fallbackImmediateJudgement, summarizeImmediateJudgement, type ImmediateJudgementPayload } from './client/src/judgement';
import { buildTimingMap, secAtDate, cueDelay } from './client/src/teacherCues';
import { layoutCues } from './client/src/pipeline/teacherVocalStream';
import { appendMidiWithOffset, delayMidi, millisecondsToMidiTicks } from './client/src/pianosound/midiSequence';
import {
    buildJudgementMoodRenderPlan,
} from './client/src/pipeline/judgementMood';
import { convert, render } from './client/src/services/mpmRenderer';

/** Extra sustain-pedal hold after the correction entry point (ms). */
const JUDGEMENT_MOOD_PEDAL_BUFFER_MS = 3000;

// Import from TypeScript source directly — the compiled lib has a CJS/ESM
// mismatch (ESM syntax without "type":"module" in package.json) that breaks
// Node's ESM loader. Importing source lets tsx compile on the fly.
const { MPM } = await import('../mpm-ts/src/MPM.ts');
const { exportMPM } = await import('../mpm-ts/src/Serialization.ts');
const { MSM, importWork } = await import('../mpmify/src/index.ts');

type MPM = InstanceType<typeof MPM>;
type MSM = InstanceType<typeof MSM>;

// ── Config ──

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';
const PPQ = 720;
const BEAT = PPQ;
const MEASURE = 4 * BEAT;
const AGGRESSIVENESS = 0.2;
const OUT_DIR = 'test_output';
const STRICT_LLM_CUES = process.env.ALLOW_FALLBACK_CUES !== '1';
const CUE_PREP_MODE = 'balanced';
const SCENARIO_FILTER = process.env.SCENARIO?.trim();

// ── Helpers ──

const assertOk = async (r: Response, label: string) => {
    if (r.ok) return;
    let text = '';
    try { text = await r.text(); } catch { /* ignore */ }
    throw new Error(`${label}: HTTP ${r.status} ${r.statusText}${text ? `: ${text}` : ''}`);
};

function parseMsmNotes(msmXml: string): any[] {
    const notes: any[] = [];
    const partRegex = /<part\b[^>]*number="(\d+)"[^>]*>([\s\S]*?)<\/part>/g;
    let pm;
    while ((pm = partRegex.exec(msmXml)) !== null) {
        const partNum = parseInt(pm[1], 10);
        const noteRegex = /<note\b([^>]*)\/?>/g;
        let nm;
        while ((nm = noteRegex.exec(pm[2])) !== null) {
            const a = nm[1];
            const attr = (n: string) => {
                const re = n === 'xml:id'
                    ? /xml:id="([^"]*)"/
                    : new RegExp(`${n.replace('.', '\\.')}="([^"]*)"`);
                return a.match(re)?.[1] ?? '';
            };
            notes.push({
                'xml:id': attr('xml:id'),
                date: parseFloat(attr('date') || '0'),
                duration: parseFloat(attr('duration') || '0'),
                pitchname: attr('pitchname'),
                octave: parseInt(attr('octave') || '0', 10),
                accidentals: parseFloat(attr('accidentals') || '0'),
                'midi.pitch': parseInt(attr('midi.pitch') || '0', 10),
                part: partNum,
            });
        }
    }

    // Deduplicate: same date + pitch → keep longest duration (mirrors asMSM)
    return notes.reduce((acc: any[], curr: any) => {
        const existing = acc.find(
            (n: any) => n.date === curr.date && n['midi.pitch'] === curr['midi.pitch'],
        );
        if (existing) {
            if (curr.duration > existing.duration) {
                acc[acc.indexOf(existing)] = curr;
            }
        } else {
            acc.push(curr);
        }
        return acc;
    }, []);
}

function enrichWithPerformanceData(notes: any[], mei: string): number {
    const recRegex = /<recording\b[^>]*source="([^"]*)"[^>]*>([\s\S]*?)<\/recording>/g;
    let matched = 0;
    let rm;
    while ((rm = recRegex.exec(mei)) !== null) {
        const wR = /<when\b([^>]*)>([\s\S]*?)<\/when>/g;
        let wm;
        while ((wm = wR.exec(rm[2])) !== null) {
            const da = wm[1].match(/data="([^"]*)"/);
            const ab = wm[1].match(/absolute="(\d+)ms"/);
            if (!da || !ab) continue;
            const ids = da[1].split(/\s+/).map(d => d.replace('#', ''));
            const onset = parseInt(ab[1], 10);
            const vel = wm[2].match(/<extData type="velocity">(\d+)<\/extData>/);
            const dur = wm[2].match(/<extData type="duration">(\d+)ms<\/extData>/);
            if (!vel || !dur) continue;
            for (const id of ids) {
                const note = notes.find((x: any) => x['xml:id'] === id);
                if (note) {
                    note['midi.onset'] = onset / 1000;
                    note['midi.duration'] = parseInt(dur[1], 10) / 1000;
                    note['midi.velocity'] = parseInt(vel[1], 10);
                    note.source = rm[1];
                    matched++;
                }
            }
        }
    }
    return matched;
}

// ── Teacher Stream (unified vocal) ──

type TeacherStreamAnchor = { marker: string; charOffset: number; text: string };
type TeacherStreamAlignment = {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
};
type TeacherStreamResponse = {
    rawText: string;
    anchors: TeacherStreamAnchor[];
    cleanedText: string;
    audioBase64: string;
    alignment: TeacherStreamAlignment;
    model: string;
    stats: { llmMs: number; ttsMs: number; totalMs: number };
};

async function requestTeacherStream(
    judgement: ImmediateJudgementPayload,
    diff: string,
    candidates: Array<Record<string, unknown>>,
    mode: string,
): Promise<TeacherStreamResponse> {
    const res = await fetch(`${SERVER_URL}/teacher-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ judgement, diff, candidates, mode }),
    });
    await assertOk(res, '/teacher-stream');
    return res.json() as Promise<TeacherStreamResponse>;
}

type VocalChunkFile = {
    marker: string;
    text: string;
    audioPath: string;
    startSec: number;
    endSec: number;
    durationSec: number;
};

function sliceVocalStream(
    fullAudioPath: string,
    anchors: TeacherStreamAnchor[],
    alignment: TeacherStreamAlignment,
    scenarioName: string,
): VocalChunkFile[] {
    const starts = alignment.character_start_times_seconds;
    const ends = alignment.character_end_times_seconds;

    if (anchors.length === 0 || starts.length === 0) {
        // No alignment → single chunk from full audio
        const dur = audioDurationSec(fullAudioPath);
        return [{
            marker: anchors[0]?.marker ?? 'JUDGE',
            text: anchors[0]?.text ?? '',
            audioPath: fullAudioPath,
            startSec: 0,
            endSec: dur,
            durationSec: dur,
        }];
    }

    const boundaries: number[] = [];
    for (const anchor of anchors) {
        const offset = anchor.charOffset;
        if (offset < starts.length) {
            boundaries.push(starts[offset]);
        } else if (ends.length > 0) {
            boundaries.push(ends[ends.length - 1]);
        } else {
            boundaries.push(0);
        }
    }
    boundaries.push(ends.length > 0 ? ends[ends.length - 1] : 0);

    const chunks: VocalChunkFile[] = [];
    for (let i = 0; i < anchors.length; i++) {
        const startSec = boundaries[i];
        const endSec = boundaries[i + 1];
        if (endSec <= startSec) continue;

        const safeMarker = anchors[i].marker.replace(/\./g, '_');
        const audioPath = `${OUT_DIR}/${scenarioName}_chunk_${i}_${safeMarker}.mp3`;
        execSync(
            `ffmpeg -y -i "${fullAudioPath}" -ss ${startSec.toFixed(3)} -to ${endSec.toFixed(3)} -c copy "${audioPath}"`,
            { stdio: 'pipe' },
        );

        chunks.push({
            marker: anchors[i].marker,
            text: anchors[i].text,
            audioPath,
            startSec,
            endSec,
            durationSec: audioDurationSec(audioPath),
        });
    }

    return chunks;
}

const audioDurationSec = (audioPath: string): number => {
    const output = execSync(
        `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${audioPath}"`,
        { stdio: 'pipe' },
    ).toString().trim();
    const duration = Number(output);
    if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error(`Invalid duration from ffprobe for ${audioPath}`);
    }
    return duration;
};

// ── MIDI extraction for visualization ──

function buildTickToSecFn(midi: any): (tick: number) => number {
    const ppq = midi.header.ticksPerBeat;
    const tempos: Array<{ tick: number; usPerBeat: number }> = [];
    for (const track of midi.tracks) {
        let tick = 0;
        for (const event of track) {
            tick += event.deltaTime;
            if (event.type === 'meta' && event.subtype === 'setTempo') {
                tempos.push({ tick, usPerBeat: event.microsecondsPerBeat });
            }
        }
    }
    tempos.sort((a, b) => a.tick - b.tick);
    if (tempos.length === 0 || tempos[0].tick > 0) tempos.unshift({ tick: 0, usPerBeat: 500000 });

    return (target: number): number => {
        let sec = 0, prev = 0, tempo = tempos[0].usPerBeat;
        for (const tc of tempos) {
            if (tc.tick > target) break;
            if (tc.tick > prev) sec += (tc.tick - prev) * tempo / ppq / 1_000_000;
            prev = tc.tick;
            tempo = tc.usPerBeat;
        }
        return sec + (target - prev) * tempo / ppq / 1_000_000;
    };
}

function extractMidiNoteEvents(midi: any): Array<{ pitch: number; onset: number; duration: number; velocity: number }> {
    const tickToSec = buildTickToSecFn(midi);
    const notes: Array<{ pitch: number; onset: number; duration: number; velocity: number }> = [];
    for (const track of midi.tracks) {
        const pending = new Map<string, { tick: number; vel: number }>();
        let tick = 0;
        for (const event of track) {
            tick += event.deltaTime;
            if (event.type !== 'channel') continue;
            const key = `${event.channel}-${event.noteNumber}`;
            if (event.subtype === 'noteOn' && (event.velocity ?? 0) > 0) {
                pending.set(key, { tick, vel: event.velocity });
            } else if (event.subtype === 'noteOff' || (event.subtype === 'noteOn' && (event.velocity ?? 0) === 0)) {
                const on = pending.get(key);
                if (on) {
                    notes.push({
                        pitch: event.noteNumber,
                        onset: tickToSec(on.tick),
                        duration: Math.max(0.001, tickToSec(tick) - tickToSec(on.tick)),
                        velocity: on.vel,
                    });
                    pending.delete(key);
                }
            }
        }
    }
    return notes.sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
}

function extractPedalEvents(midi: any): Array<{ time: number; value: number }> {
    const tickToSec = buildTickToSecFn(midi);
    const events: Array<{ time: number; value: number }> = [];
    for (const track of midi.tracks) {
        let tick = 0;
        for (const event of track) {
            tick += event.deltaTime;
            if (event.type === 'channel' && event.subtype === 'controller' && (event.controllerType ?? 0) === 64) {
                events.push({ time: tickToSec(tick), value: event.value ?? 0 });
            }
        }
    }
    return events.sort((a, b) => a.time - b.time);
}

function resolveSoundfont(): string | null {
    const candidates = [
        process.env.SF2_PATH,
        '/Users/nielspfeffer/Downloads/Full Grand Piano.sf2',
        '/Users/nielspfeffer/.gervill/soundbank-emg.sf2',
        '/Users/nielspfeffer/Downloads/A320U.sf2',
        '/Users/nielspfeffer/Downloads/FluidR3_GS.sf2',
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

/** Convert MIDI file to WAV using timidity or fluidsynth */
function midiToWav(midiPath: string, wavPath: string) {
    try {
        execSync(`timidity "${midiPath}" -Ow -o "${wavPath}"`, { stdio: 'pipe' });
        return;
    } catch { /* timidity not found, try fluidsynth */ }

    const sf2 = resolveSoundfont();
    if (sf2) {
        execSync(`fluidsynth -ni -F "${wavPath}" -r 44100 "${sf2}" "${midiPath}"`, { stdio: 'pipe' });
        return;
    }

    throw new Error(
        'Cannot convert MIDI to audio.\n' +
        '  Install timidity: brew install timidity\n' +
        '  Or set SF2_PATH and install fluidsynth: brew install fluid-synth',
    );
}

/** Combine student WAV + teacher WAV → output MP3 */
function combineToMp3(studentWav: string, teacherWav: string, outputMp3: string) {
    execSync(
        `ffmpeg -y -i "${studentWav}" -i "${teacherWav}" ` +
        `-filter_complex "` +
        `[0:a]apad=pad_dur=2[s];` +
        `[s][1:a]concat=n=2:v=0:a=1[out]" ` +
        `-map "[out]" -codec:a libmp3lame -b:a 192k "${outputMp3}"`,
        { stdio: 'pipe' },
    );
}

function mixTeacherWithCues(
    teacherWav: string,
    cues: Array<{ id: string; atSec: number; audioPath: string }>,
    outputWav: string,
) {
    if (cues.length === 0) {
        fs.copyFileSync(teacherWav, outputWav);
        return;
    }

    const inputs = [`-i "${teacherWav}"`, ...cues.map((cue) => `-i "${cue.audioPath}"`)].join(' ');
    const delayed = cues
        .map((cue, index) => {
            const delayMs = Math.max(0, Math.round(cue.atSec * 1000));
            return `[${index + 1}:a]volume=0.55,adelay=${delayMs}|${delayMs}[cue${index}]`;
        })
        .join(';');
    const n = cues.length + 1;
    const mixInputs = ['[0:a]', ...cues.map((_, index) => `[cue${index}]`)].join('');
    const weights = [n, ...cues.map(() => n)].join(' ');
    const filter = `${delayed};${mixInputs}amix=inputs=${n}:duration=first:weights=${weights}:normalize=0[out]`;

    execSync(
        `ffmpeg -y ${inputs} -filter_complex "${filter}" -map "[out]" -c:a pcm_s16le "${outputWav}"`,
        { stdio: 'pipe' },
    );
}

function mixNarrationOverWav(
    narrationAudioPath: string | null,
    backgroundWav: string,
    outputWav: string,
    backgroundVolume: number,
) {
    if (!narrationAudioPath) {
        fs.copyFileSync(backgroundWav, outputWav);
        return;
    }

    execSync(
        `ffmpeg -y -i "${narrationAudioPath}" -i "${backgroundWav}" ` +
        `-filter_complex "[0:a]volume=0.35,apad[narr];[1:a]volume=${backgroundVolume},pan=mono|c0=0.5*c0+0.5*c1[bg];[narr][bg]amerge=inputs=2,pan=mono|c0=c0+c1[out]" ` +
        `-map "[out]" -c:a pcm_s16le "${outputWav}"`,
        { stdio: 'pipe' },
    );
}

/** Deep clone an MPM (the built-in clone() is shallow and shares the doc) */
function deepCloneMpm(mpm: MPM): MPM {
    const clone = new MPM();
    clone.doc = structuredClone(mpm.doc);
    return clone;
}

function clearScenarioOutputs(prefix: string) {
    if (!fs.existsSync(OUT_DIR)) return;
    for (const file of fs.readdirSync(OUT_DIR)) {
        if (!file.startsWith(`${prefix}_`) && file !== `${prefix}.mp3`) continue;
        try { fs.unlinkSync(`${OUT_DIR}/${file}`); } catch { /* ignore */ }
    }
}

// ── Pipeline functions (inlined from client/src/mpm.ts to avoid CJS import chain) ──

const buildMpm = (msm: MSM, infoJson: any): MPM => {
    const mpm = new MPM();
    const { transformers } = importWork(infoJson);
    transformers.forEach((transformer: any) => transformer.run(msm, mpm));
    return mpm;
};

type Range = { from: number; to: number };

const inRange = (i: any, range: Range) => {
    const date = i.date ?? i["date"];
    return typeof date === 'number' && date >= range.from && date <= range.to;
};

const indexInstructions = (mpm: MPM) => {
    const idx = new Map<string, any>();
    for (const i of mpm.getInstructions()) {
        idx.set(`${i.type}::${i["xml:id"]}`, i);
    }
    return idx;
};

const THRESHOLDS: Record<string, number> = {
    volume: 4, bpm: 4, "transition.to": 4,
    relativeDuration: 0.05, relativeVelocity: 0.05,
    intensity: 0.1, scale: 0.1, "milliseconds.offset": 5, frameLength: 50,
};

const ATTRS_TO_COMPARE: Record<string, string[]> = {
    dynamics: ['volume', 'transition.to'],
    tempo: ['bpm', 'transition.to'],
    articulation: ['relativeDuration', 'relativeVelocity'],
    rubato: ['intensity', 'frameLength'],
    ornament: ['scale', 'intensity'],
    asynchrony: ['milliseconds.offset'],
    accentuationPattern: ['scale'],
};

const PPQ_DIFF = 720;
const TICKS_PER_MEASURE = PPQ_DIFF * 4;

const tickToPos = (tick: number): string => {
    const m = Math.floor(tick / TICKS_PER_MEASURE) + 1;
    const b = Math.floor((tick % TICKS_PER_MEASURE) / PPQ_DIFF) + 1;
    return `m${m}.${b}`;
};

const dynLabel = (v: number): string => {
    if (v <= 20) return 'ppp';
    if (v <= 35) return 'pp';
    if (v <= 50) return 'p';
    if (v <= 65) return 'mp';
    if (v <= 80) return 'mf';
    if (v <= 95) return 'f';
    if (v <= 110) return 'ff';
    return 'fff';
};

const SEVERITY_THRESHOLDS: Record<string, [number, number]> = {
    bpm: [15, 40], volume: [12, 30], 'transition.to': [15, 40],
    relativeDuration: [0.15, 0.4], relativeVelocity: [0.15, 0.4],
    intensity: [0.3, 0.8], scale: [0.5, 2],
    'milliseconds.offset': [15, 40], frameLength: [150, 400],
};

const severity = (attr: string, delta: number): string => {
    const abs = Math.abs(delta);
    const [mod, large] = SEVERITY_THRESHOLDS[attr] ?? [0, 0];
    if (abs >= large) return 'large';
    if (abs >= mod) return 'mod';
    return 'slight';
};

type InstructionDiff = {
    date: number;
    type: string;
    diffs: Record<string, { ref: number; student: number; delta: number }>;
    magnitude: number;
};

type StructuredDiffEvent = {
    id: string;
    date: number;
    position: string;
    type: string;
    severity: 'slight' | 'mod' | 'large';
    primaryAttr: string;
    magnitude: number;
    cueText: string;
    direction: 'more' | 'less';
    refValue: number;
    studentValue: number;
};

const collectDiffs = (mpm1: MPM, mpm2: MPM, range: Range): InstructionDiff[] => {
    const allInstructions: any[] = mpm1.getInstructions().filter((i: any) => inRange(i, range));
    const idx = indexInstructions(mpm2);
    const peaks: InstructionDiff[] = [];
    for (const instruction of allInstructions) {
        const corresp = idx.get(`${instruction.type}::${instruction["xml:id"]}`);
        if (!corresp) continue;
        const attrs = ATTRS_TO_COMPARE[instruction.type];
        if (!attrs) continue;
        const diffs: Record<string, { ref: number; student: number; delta: number }> = {};
        let magnitude = 0, hasSignificant = false;
        for (const attr of attrs) {
            const refVal = instruction[attr], studentVal = corresp[attr];
            if (typeof refVal !== 'number' || typeof studentVal !== 'number') continue;
            const delta = studentVal - refVal;
            if (Math.abs(delta) >= (THRESHOLDS[attr] ?? 0)) hasSignificant = true;
            diffs[attr] = { ref: refVal, student: studentVal, delta };
            magnitude += Math.abs(delta);
        }
        if (!hasSignificant || Object.keys(diffs).length === 0) continue;
        peaks.push({ date: instruction.date, type: instruction.type, diffs, magnitude });
    }
    return peaks;
};

const formatTable = (headers: string[], rows: string[][]): string => {
    const widths = headers.map((h, i) =>
        Math.max(h.length, ...rows.map(r => (r[i] || '').length))
    );
    const fmtRow = (row: string[]) =>
        '  ' + row.map((cell, i) => (cell || '').padEnd(widths[i])).join(' | ');
    return [fmtRow(headers), ...rows.map(fmtRow)].join('\n');
};

const tempoRow = (p: InstructionDiff): string[] => {
    const bpm = p.diffs['bpm'];
    const trans = p.diffs['transition.to'];
    const sev = severity('bpm', bpm.delta);
    let transition = '';
    if (trans && Math.abs(trans.delta) >= THRESHOLDS['transition.to']) {
        const refDir = trans.ref > bpm.ref ? 'accel' : trans.ref < bpm.ref ? 'rit' : 'const';
        const stuDir = trans.student > bpm.student ? 'accel' : trans.student < bpm.student ? 'rit' : 'const';
        if (refDir === stuDir) {
            transition = `both ${refDir} (ref ${Math.round(trans.ref)}, stu ${Math.round(trans.student)})`;
        } else {
            transition = `ref ${refDir} ${Math.round(trans.ref)}, stu ${stuDir} ${Math.round(trans.student)}`;
        }
    }
    return [tickToPos(p.date), sev, `${Math.round(bpm.ref)} bpm`, `${Math.round(bpm.student)} bpm`, transition];
};

const dynamicsRow = (p: InstructionDiff): string[] => {
    const vol = p.diffs['volume'];
    const trans = p.diffs['transition.to'];
    const sev = severity('volume', vol.delta);
    let transition = '';
    if (trans && Math.abs(trans.delta) >= THRESHOLDS['transition.to']) {
        const refDir = trans.ref > vol.ref ? 'cresc' : trans.ref < vol.ref ? 'decresc' : 'const';
        const stuDir = trans.student > vol.student ? 'cresc' : trans.student < vol.student ? 'decresc' : 'const';
        if (refDir === stuDir) {
            transition = `both ${refDir} (ref ${dynLabel(trans.ref)}(${Math.round(trans.ref)}), stu ${dynLabel(trans.student)}(${Math.round(trans.student)}))`;
        } else {
            transition = `ref ${refDir} ${dynLabel(trans.ref)}(${Math.round(trans.ref)}), stu ${stuDir} ${dynLabel(trans.student)}(${Math.round(trans.student)})`;
        }
    }
    return [tickToPos(p.date), sev, `${dynLabel(vol.ref)}(${Math.round(vol.ref)})`, `${dynLabel(vol.student)}(${Math.round(vol.student)})`, transition];
};

const genericRow = (p: InstructionDiff): string[] => {
    const entries = Object.entries(p.diffs)
        .filter(([, { delta }]) => Math.abs(delta) >= (THRESHOLDS['intensity'] ?? 0));
    const maxSev = entries.reduce((s, [attr, { delta }]) => {
        const sv = severity(attr, delta);
        return sv === 'large' ? 'large' : sv === 'mod' && s !== 'large' ? 'mod' : s;
    }, 'slight' as string);
    const refParts = entries.map(([attr, { ref }]) =>
        `${attr}: ${ref.toFixed(1)}`);
    const stuParts = entries.map(([attr, { student }]) =>
        `${attr}: ${student.toFixed(1)}`);
    return [tickToPos(p.date), maxSev, refParts.join(', '), stuParts.join(', ')];
};

const TYPE_ORDER = ['tempo', 'dynamics', 'articulation', 'rubato', 'ornament', 'accentuationPattern', 'asynchrony'];
const TYPE_LABELS: Record<string, string> = {
    tempo: 'TEMPO', dynamics: 'DYNAMICS', articulation: 'ARTICULATION',
    rubato: 'RUBATO', ornament: 'ORNAMENTS (arpeggio)',
    accentuationPattern: 'METRIC ACCENTS', asynchrony: 'VOICE ASYNCHRONY',
};

const severityRank = (value: string): number =>
    value === 'large' ? 3 : value === 'mod' ? 2 : 1;

const primaryDiffEntry = (p: InstructionDiff): [string, { ref: number; student: number; delta: number }] => {
    const entries = Object.entries(p.diffs)
        .filter(([attr, { delta }]) => Math.abs(delta) >= (THRESHOLDS[attr] ?? 0));
    if (entries.length === 0) {
        return Object.entries(p.diffs)[0];
    }

    entries.sort((a, b) => {
        const sevDelta = severityRank(severity(b[0], b[1].delta)) - severityRank(severity(a[0], a[1].delta));
        if (sevDelta !== 0) return sevDelta;
        return Math.abs(b[1].delta) - Math.abs(a[1].delta);
    });
    return entries[0];
};

const cueTextForDiff = (
    type: string,
    attr: string,
    delta: number,
): { cueText: string; direction: 'more' | 'less' } => {
    if (type === 'dynamics' && attr === 'volume') {
        return delta > 0 ? { cueText: 'leiser', direction: 'less' } : { cueText: 'lauter', direction: 'more' };
    }
    if (type === 'dynamics' && attr === 'transition.to') {
        return delta > 0 ? { cueText: 'weniger Crescendo', direction: 'less' } : { cueText: 'mehr Crescendo', direction: 'more' };
    }
    if (type === 'tempo' && (attr === 'bpm' || attr === 'transition.to')) {
        return delta > 0 ? { cueText: 'ruhiger', direction: 'less' } : { cueText: 'bewegter', direction: 'more' };
    }
    if (type === 'articulation' && attr === 'relativeDuration') {
        return delta < 0 ? { cueText: 'mehr Legato', direction: 'more' } : { cueText: 'kuerzer', direction: 'less' };
    }
    if (type === 'articulation' && attr === 'relativeVelocity') {
        return delta > 0 ? { cueText: 'weniger Akzent', direction: 'less' } : { cueText: 'mehr Akzent', direction: 'more' };
    }
    if (type === 'rubato' && attr === 'intensity') {
        return delta > 0 ? { cueText: 'ruhiger im Puls', direction: 'less' } : { cueText: 'mehr atmen', direction: 'more' };
    }
    if (type === 'accentuationPattern' && attr === 'scale') {
        return delta > 0 ? { cueText: 'weniger betonen', direction: 'less' } : { cueText: 'mehr betonen', direction: 'more' };
    }
    if (type === 'ornament' && (attr === 'intensity' || attr === 'frameLength')) {
        return delta > 0 ? { cueText: 'naeher zusammen', direction: 'less' } : { cueText: 'etwas breiter', direction: 'more' };
    }
    if (type === 'ornament' && attr === 'scale') {
        return delta > 0 ? { cueText: 'gleichmaessiger', direction: 'less' } : { cueText: 'oben mehr zeigen', direction: 'more' };
    }
    if (type === 'asynchrony' && attr === 'milliseconds.offset') {
        return { cueText: 'mehr zusammen', direction: 'less' };
    }
    return delta > 0 ? { cueText: 'weniger', direction: 'less' } : { cueText: 'mehr', direction: 'more' };
};

const UNCLEAR_CUE_PATTERNS = [
    /\bstaffel/i,
    /\barpeggi/i,
    /\bagog/i,
    /\bphrasierungskurve/i,
];
const TOO_VAGUE_CUES = new Set(['mehr', 'weniger']);
const ALLOWED_V3_TAGS = new Set([
    'warmly',
    'encouragingly',
    'softly',
    'whispers',
    'slowly',
    'urgent',
    'curious',
    'excited',
    'sad',
    'gently',
]);
const V3_TAG_ALIASES: Record<string, string> = {
    inviting: 'warmly',
    leading: 'encouragingly',
    resolving: 'softly',
    releasing: 'softly',
    neutral: 'slowly',
    guiding: 'encouragingly',
    supportive: 'warmly',
    tenderly: 'gently',
};

const normalizeV3Tag = (rawTag: string): string | null => {
    const normalized = rawTag.trim().toLowerCase();
    if (!normalized) return null;
    if (ALLOWED_V3_TAGS.has(normalized)) return normalized;
    return V3_TAG_ALIASES[normalized] ?? null;
};

const normalizeCueText = (text: string, fallback: string): string => {
    const normalized = text
        .replace(/\s+/g, ' ')
        .replace(/[.!?]+$/g, '')
        .trim();
    if (!normalized) return fallback;

    const leadingTagMatch = normalized.match(/^\[([a-zA-Z][a-zA-Z ]{0,23})\]\s*/);
    const normalizedTag = leadingTagMatch ? normalizeV3Tag(leadingTagMatch[1]) : null;
    const body = normalized
        .slice(leadingTagMatch?.[0].length ?? 0)
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const words = body.split(' ').filter(Boolean);
    const shortened = words.length > 5 ? words.slice(0, 5).join(' ') : body;
    if (!shortened) return fallback;
    if (TOO_VAGUE_CUES.has(shortened.toLowerCase())) return fallback;
    if (UNCLEAR_CUE_PATTERNS.some((pattern) => pattern.test(shortened))) return fallback;
    return normalizedTag ? `[${normalizedTag}] ${shortened}` : shortened;
};

const topDiffsByType = (peaks: InstructionDiff[], perTypeN: number): InstructionDiff[] => {
    const byType = new Map<string, InstructionDiff[]>();
    for (const p of peaks) {
        const group = byType.get(p.type) ?? [];
        group.push(p);
        byType.set(p.type, group);
    }

    const selected: InstructionDiff[] = [];
    for (const [, items] of byType) {
        items.sort((a, b) => b.magnitude - a.magnitude);
        selected.push(...items.slice(0, perTypeN));
    }
    return selected;
};

const diffStructured = (
    mpm1: MPM,
    mpm2: MPM,
    range: Range,
    perTypeN: number = 3,
): StructuredDiffEvent[] => {
    const peaks = collectDiffs(mpm1, mpm2, range);
    if (peaks.length === 0) return [];

    return topDiffsByType(peaks, perTypeN)
        .sort((a, b) => a.date - b.date || b.magnitude - a.magnitude)
        .map((p, index) => {
            const [primaryAttr, primary] = primaryDiffEntry(p);
            const sev = severity(primaryAttr, primary.delta) as StructuredDiffEvent['severity'];
            const cue = cueTextForDiff(p.type, primaryAttr, primary.delta);
            return {
                id: `${p.type}_${p.date}_${index}`,
                date: p.date,
                position: tickToPos(p.date),
                type: p.type,
                severity: sev,
                primaryAttr,
                magnitude: p.magnitude,
                cueText: cue.cueText,
                direction: cue.direction,
                refValue: primary.ref,
                studentValue: primary.student,
            };
        });
};

const PPQ_POS = 720;
const BEATS_PER_MEASURE_POS = 4;

const compareEvents = (a: StructuredDiffEvent, b: StructuredDiffEvent): number => {
    const sevA = severityRank(a.severity);
    const sevB = severityRank(b.severity);
    if (sevB !== sevA) return sevB - sevA;
    return b.magnitude - a.magnitude;
};

const positionToTick = (position: string): number | null => {
    const match = /^m(\d+)\.(\d+)$/.exec(position.trim());
    if (!match) return null;

    const measure = Number(match[1]);
    const beat = Number(match[2]);
    if (!Number.isFinite(measure) || !Number.isFinite(beat) || measure < 1 || beat < 1 || beat > BEATS_PER_MEASURE_POS) {
        return null;
    }

    return ((measure - 1) * BEATS_PER_MEASURE_POS + (beat - 1)) * PPQ_POS;
};

const resolveTeacherCuePlan = (
    diffEvents: StructuredDiffEvent[],
    timingMap: Array<{ date: number; sec: number }>,
    drafts: Array<{ position: string; text: string }>,
): TeacherCue[] => {
    if (drafts.length === 0) return planTeacherCues(diffEvents, timingMap);

    const byPosition = new Map<string, StructuredDiffEvent[]>();
    for (const event of diffEvents) {
        const group = byPosition.get(event.position) ?? [];
        group.push(event);
        byPosition.set(event.position, group);
    }
    const accepted: TeacherCue[] = [];
    const used = new Set<string>();

    for (const draft of drafts) {
        const events = byPosition.get(draft.position);
        if (!events || used.has(draft.position)) continue;

        const [event] = events.slice().sort(compareEvents);
        const anchorDate = positionToTick(draft.position) ?? event.date;
        const atSec = Math.max(0, secAtDate(timingMap, anchorDate) - 0.08);
        const tooClose = accepted.some((cue) => Math.abs(cue.atSec - atSec) < 1.2);
        if (tooClose) continue;

        accepted.push({
            id: `cue_${accepted.length + 1}_${draft.position.replace(/[^\w]+/g, '_')}`,
            atSec,
            text: normalizeCueText(draft.text, event.cueText),
            anchorDate,
            severity: event.severity,
            type: event.type,
            priority: severityRank(event.severity) * 1000 + event.magnitude,
        });
        used.add(draft.position);
        if (accepted.length >= 4) break;
    }

    return accepted.length > 0 ? accepted.sort((a, b) => a.atSec - b.atSec) : planTeacherCues(diffEvents, timingMap);
};

const diff = (mpm1: MPM, mpm2: MPM, range: Range, topN: number = 10): string => {
    const peaks = collectDiffs(mpm1, mpm2, range);
    if (peaks.length === 0) return "No significant differences found.";

    peaks.sort((a, b) => b.magnitude - a.magnitude);
    const top = peaks.slice(0, topN);

    const grouped = new Map<string, InstructionDiff[]>();
    for (const p of top) {
        const group = grouped.get(p.type) ?? [];
        group.push(p);
        grouped.set(p.type, group);
    }

    const rangeStr = `${tickToPos(range.from)}–${tickToPos(range.to)}`;
    const sections: string[] = [`${top.length} deviations in ${rangeStr}:`];

    for (const type of TYPE_ORDER) {
        const items = grouped.get(type);
        if (!items) continue;
        items.sort((a, b) => a.date - b.date);

        const label = TYPE_LABELS[type] ?? type;
        let headers: string[];
        let rows: string[][];

        if (type === 'tempo') {
            headers = ['pos', 'sev', 'ref', 'student', 'transition'];
            rows = items.map(p => tempoRow(p));
        } else if (type === 'dynamics') {
            headers = ['pos', 'sev', 'ref', 'student', 'transition'];
            rows = items.map(p => dynamicsRow(p));
        } else {
            headers = ['pos', 'sev', 'ref', 'student'];
            rows = items.map(p => genericRow(p));
        }

        sections.push(`\n${label} (${items.length}):\n${formatTable(headers, rows)}`);
    }

    return sections.join('\n');
};

const logExaggerate = (ref: number, student: number, aggressiveness: number, min: number, max: number): number => {
    if (student <= 0 || ref <= 0) return ref;
    return Math.max(min, Math.min(max, ref * Math.pow(ref / student, aggressiveness)));
};

const EXAGGERATION_TUNING: Record<string, Record<string, { strength: number; maxAbsDelta: number }>> = {
    dynamics: {
        volume: { strength: 0.45, maxAbsDelta: 12 },
        'transition.to': { strength: 0.45, maxAbsDelta: 12 },
    },
    tempo: {
        bpm: { strength: 0.35, maxAbsDelta: 10 },
        'transition.to': { strength: 0.35, maxAbsDelta: 10 },
    },
    articulation: {
        relativeDuration: { strength: 0.5, maxAbsDelta: 0.2 },
        relativeVelocity: { strength: 0.45, maxAbsDelta: 0.2 },
    },
    rubato: {
        intensity: { strength: 0.25, maxAbsDelta: 0.15 },
    },
    ornament: {
        scale: { strength: 0.4, maxAbsDelta: 0.8 },
        intensity: { strength: 0.35, maxAbsDelta: 0.25 },
    },
    asynchrony: {
        'milliseconds.offset': { strength: 0.35, maxAbsDelta: 40 },
    },
    accentuationPattern: {
        scale: { strength: 0.4, maxAbsDelta: 0.6 },
    },
};

const applyExaggerationCap = (
    refVal: number,
    exaggeratedVal: number,
    maxAbsDelta: number,
    min: number,
    max: number,
): number => {
    const lower = Math.max(min, refVal - maxAbsDelta);
    const upper = Math.min(max, refVal + maxAbsDelta);
    return Math.max(lower, Math.min(upper, exaggeratedVal));
};

const EXAGGERATION_SPEC: Record<string, Array<{ attr: string; min: number; max: number }>> = {
    dynamics: [{ attr: 'volume', min: 1, max: 127 }, { attr: 'transition.to', min: 1, max: 127 }],
    tempo: [{ attr: 'bpm', min: 10, max: 300 }, { attr: 'transition.to', min: 10, max: 300 }],
    articulation: [{ attr: 'relativeDuration', min: 0.1, max: 5 }, { attr: 'relativeVelocity', min: 0.1, max: 5 }],
    rubato: [{ attr: 'intensity', min: 0.01, max: 10 }],
    ornament: [{ attr: 'scale', min: 0.1, max: 20 }],
    asynchrony: [{ attr: 'milliseconds.offset', min: -500, max: 500 }],
    accentuationPattern: [{ attr: 'scale', min: 0, max: 10 }],
};

const exaggerate = (mpm1: MPM, mpm2: MPM, range: Range, aggressiveness: number = 1) => {
    const allInstructions: any[] = mpm1.getInstructions().filter((i: any) => inRange(i, range));
    const idx = indexInstructions(mpm2);
    for (const instruction of allInstructions) {
        const corresp = idx.get(`${instruction.type}::${instruction["xml:id"]}`);
        if (!corresp) continue;
        const specs = EXAGGERATION_SPEC[instruction.type];
        if (!specs) continue;
        for (const { attr, min, max } of specs) {
            const refVal = instruction[attr], studentVal = corresp[attr];
            if (typeof refVal !== 'number' || typeof studentVal !== 'number') continue;
            const tuning = EXAGGERATION_TUNING[instruction.type]?.[attr] ?? { strength: 1, maxAbsDelta: max };
            const effectiveAggressiveness = aggressiveness * tuning.strength;
            if (instruction.type === 'asynchrony') {
                const exaggerated = refVal - (studentVal - refVal) * effectiveAggressiveness;
                instruction[attr] = applyExaggerationCap(refVal, exaggerated, tuning.maxAbsDelta, min, max);
            } else {
                const exaggerated = logExaggerate(refVal, studentVal, effectiveAggressiveness, min, max);
                instruction[attr] = applyExaggerationCap(refVal, exaggerated, tuning.maxAbsDelta, min, max);
            }
        }
    }
};

// ── Large-scale deviation detection ──

// ── Student MPM builder ──

function buildStudentMpm(opts: {
    tempos: Array<{ date: number; bpm: number; transitionTo: number }>;
    dynamics: Array<{ date: number; volume: number; transitionTo: number }>;
    articDef?: string;
    relativeDuration?: number;
}): string {
    const tempoEntries = opts.tempos
        .map(t =>
            `<tempo xml:id="tempo_${t.date}" date="${t.date}" bpm="${t.bpm}" ` +
            `beatLength="0.25" transition.to="${t.transitionTo}"/>`)
        .join('\n          ');

    const dynEntries = opts.dynamics
        .map(d =>
            `<dynamics xml:id="dynamics_${d.date}" date="${d.date}" ` +
            `volume="${d.volume}" transition.to="${d.transitionTo}"/>`)
        .join('\n          ');

    const artName = opts.articDef || 'legato';
    const relDur = opts.relativeDuration ?? 0.95;

    return `<mpm>
  <metadata></metadata>
  <performance name="student" pulsesPerQuarter="720">
    <global>
      <header>
        <articulationStyles>
          <styleDef name="s">
            <articulationDef name="${artName}" relativeDuration="${relDur}" relativeVelocity="1.0"/>
          </styleDef>
        </articulationStyles>
      </header>
      <dated>
        <tempoMap>
          <style date="0" name.ref="s" xml:id="st"/>
          ${tempoEntries}
        </tempoMap>
        <dynamicsMap>
          <style date="0" name.ref="s" xml:id="sd"/>
          ${dynEntries}
        </dynamicsMap>
        <articulationMap>
          <style date="0" name.ref="s" defaultArticulation="${artName}" xml:id="sa"/>
        </articulationMap>
      </dated>
    </global>
  </performance>
</mpm>`;
}

// ── Scenarios ──

type Scenario = {
    name: string;
    description: string;
    startDate: number;
    endDate: number;
    mpm: string;
};

const scenarios: Scenario[] = [
    {
        name: '01_robotic',
        description: 'Robotic: constant tempo 72bpm, flat mf, legato but lifeless',
        startDate: BEAT,
        endDate: 5 * MEASURE,
        mpm: buildStudentMpm({
            tempos: [0, 720, 3600, 7200, 10800].map(d => ({ date: d, bpm: 72, transitionTo: 72 })),
            dynamics: [0, 2520, 7200, 10080].map(d => ({ date: d, volume: 70, transitionTo: 70 })),
        }),
    },
    {
        name: '02_rushing_loud',
        description: 'Rushing & loud: accelerates 80→120bpm, ff, staccato',
        startDate: 4 * MEASURE,
        endDate: 9 * MEASURE,
        mpm: buildStudentMpm({
            tempos: [
                { date: 0, bpm: 80, transitionTo: 90 },
                { date: 11520, bpm: 90, transitionTo: 100 },
                { date: 14400, bpm: 100, transitionTo: 110 },
                { date: 17280, bpm: 110, transitionTo: 115 },
                { date: 20160, bpm: 115, transitionTo: 120 },
            ],
            dynamics: [
                { date: 0, volume: 90, transitionTo: 95 },
                { date: 11520, volume: 95, transitionTo: 100 },
                { date: 14400, volume: 100, transitionTo: 105 },
                { date: 17280, volume: 105, transitionTo: 110 },
            ],
            articDef: 'staccato',
            relativeDuration: 0.4,
        }),
    },
    {
        name: '03_timid',
        description: 'Timid: very slow ~35bpm, very quiet pp, lifeless (B section)',
        startDate: 17 * MEASURE,          // B section start (unfolded mm 17)
        endDate: 21 * MEASURE,             // 4 measures of B
        mpm: buildStudentMpm({
            tempos: [
                { date: 0, bpm: 35, transitionTo: 33 },
                { date: 48960, bpm: 33, transitionTo: 36 },
                { date: 51840, bpm: 36, transitionTo: 32 },
                { date: 54720, bpm: 32, transitionTo: 34 },
            ],
            dynamics: [
                { date: 0, volume: 30, transitionTo: 28 },
                { date: 48960, volume: 28, transitionTo: 32 },
                { date: 51840, volume: 32, transitionTo: 27 },
            ],
        }),
    },
];

// ── Main ──

console.log('Loading resources...');
const mei = fs.readFileSync('client/public/score.mei', 'utf8');
const infoJson = fs.readFileSync('client/public/info.json', 'utf8');

console.log('Converting MEI → MSM...');
const msmXml = convert(mei);

const msmNotes = parseMsmNotes(msmXml);
const matched = enrichWithPerformanceData(msmNotes, mei);
const enrichedNotes = msmNotes.filter((n: any) => typeof n['midi.onset'] === 'number');
console.log(`  ${enrichedNotes.length} notes with performance data (${matched} enriched)`);

console.log('Building reference MPM...');
const origLog = console.log;
console.log = () => {};
const baseMsm = new MSM(enrichedNotes, { numerator: 4, denominator: 4 });
const referenceMpm = buildMpm(baseMsm, infoJson);
console.log = origLog;
console.log(`  Reference: ${referenceMpm.getInstructions().length} instructions`);

// Load harmonic reduction (optional — enables two-pass mode)
let reductionMei: string | undefined;
let reductionMsmNotes: any[] | undefined;
try {
    reductionMei = fs.readFileSync('client/public/harmonic_reduction.mei', 'utf8');
    console.log(`  Reduction MEI: ${reductionMei.length} bytes`);

    reductionMsmNotes = parseMsmNotes(convert(reductionMei));
    // No performance enrichment — reduction has no <when> elements
    console.log(`  Reduction MSM: ${reductionMsmNotes.length} notes`);
} catch (e: any) {
    console.log(`  Harmonic reduction not available: ${e.message}`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const scenario of scenarios) {
    if (SCENARIO_FILTER && scenario.name !== SCENARIO_FILTER) continue;
    clearScenarioOutputs(scenario.name);
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  ${scenario.name}: ${scenario.description}`);
    console.log(`  Range: ${scenario.startDate}–${scenario.endDate}`);
    console.log('═'.repeat(60));

    // 1. Render student MIDI
    console.log('  [1/7] Rendering student MIDI...');
    const studentMidiBytes = render(mei, scenario.mpm, { from: scenario.startDate, to: scenario.endDate });
    if (!studentMidiBytes) throw new Error(`${scenario.name}: student render produced nothing`);
    const studentMidPath = `${OUT_DIR}/${scenario.name}_student.mid`;
    fs.writeFileSync(studentMidPath, studentMidiBytes);

    // 2. Match + implant (local matcher — same as frontend)
    console.log('  [2/7] Matching & implanting...');
    const midiFile = readMidi(studentMidiBytes);
    const dateHint = (scenario.startDate + scenario.endDate) / 2;
    const { studentMsm, range } = implantLocal(baseMsm, midiFile, dateHint);
    console.log(`    Implant range: [${range.from}, ${range.to}]`);

    // 3. Build student MPM via mpmify
    console.log('  [3/7] Building student MPM...');
    console.log = () => {};
    const studentMpm = buildMpm(studentMsm, infoJson);
    console.log = origLog;

    // 4. Diff
    console.log('  [4/8] Diffing reference vs student...');
    const diffResult = diff(referenceMpm, studentMpm, range);
    console.log(`    ${diffResult.split('\n')[0]}`);
    fs.writeFileSync(`${OUT_DIR}/${scenario.name}_diff.txt`, diffResult);

    const structuredDiffs = diffStructured(referenceMpm, studentMpm, range);
    const judgementSummary = summarizeImmediateJudgement(structuredDiffs, range);

    // 5. Exaggerate
    console.log('  [5/8] Exaggerating reference MPM...');
    const teacherMpm = deepCloneMpm(referenceMpm);
    exaggerate(teacherMpm, studentMpm, range, AGGRESSIVENESS);
    const teacherMpmXml = exportMPM(teacherMpm);

    // Helper: render a MIDI performance
    const renderMidi = async (
        passLabel: string,
        passMei: string,
        passRange: Range,
        opts?: { mpmXml?: string },
    ): Promise<Buffer> => {
        const bytes = render(passMei, opts?.mpmXml ?? teacherMpmXml, passRange);
        if (!bytes) throw new Error(`${scenario.name}/${passLabel}: render produced nothing`);
        const midiBytes = Buffer.from(bytes);
        fs.writeFileSync(`${OUT_DIR}/${scenario.name}_${passLabel}.mid`, midiBytes);
        return midiBytes;
    };

    // 6. Render teacher correction MIDI + request unified vocal stream in parallel
    console.log('  [6/8] Rendering teacher MIDI + requesting vocal stream...');

    // Build candidates for teacher-stream
    const positions = new Map<string, StructuredDiffEvent[]>();
    for (const event of structuredDiffs) {
        const group = positions.get(event.position) ?? [];
        group.push(event);
        positions.set(event.position, group);
    }
    const candidates = Array.from(positions.entries()).map(([position, events]) => ({
        position,
        issues: events.map((event) => ({
            type: event.type,
            severity: event.severity,
            direction: event.direction,
            primaryAttr: event.primaryAttr,
            refValue: event.refValue,
            studentValue: event.studentValue,
        })),
    }));

    const [correctionBytes, teacherStreamResp] = await Promise.all([
        renderMidi('teacher', mei, range),
        requestTeacherStream(judgementSummary, diffResult, candidates, CUE_PREP_MODE),
    ]);

    // Save vocal stream info
    const judgeAnchor = teacherStreamResp.anchors.find(a => a.marker === 'JUDGE');
    const judgementText = judgeAnchor?.text || fallbackImmediateJudgement(judgementSummary);
    fs.writeFileSync(`${OUT_DIR}/${scenario.name}_judgement.txt`, `${judgementText}\n`);
    fs.writeFileSync(`${OUT_DIR}/${scenario.name}_vocal_raw.txt`, teacherStreamResp.rawText);
    console.log(`    Vocal stream: ${teacherStreamResp.anchors.length} anchors, ` +
        `llm=${teacherStreamResp.stats.llmMs}ms, tts=${teacherStreamResp.stats.ttsMs}ms`);
    for (const anchor of teacherStreamResp.anchors) {
        console.log(`      ${anchor.marker.padEnd(8)} "${anchor.text}"`);
    }

    // Save + slice vocal audio
    let vocalChunks: VocalChunkFile[] = [];
    const fullVocalPath = `${OUT_DIR}/${scenario.name}_vocal_full.mp3`;
    if (teacherStreamResp.audioBase64) {
        fs.writeFileSync(fullVocalPath, Buffer.from(teacherStreamResp.audioBase64, 'base64'));
        vocalChunks = sliceVocalStream(
            fullVocalPath,
            teacherStreamResp.anchors,
            teacherStreamResp.alignment,
            scenario.name,
        );
        console.log(`    Sliced into ${vocalChunks.length} chunks`);
    }

    // Build timing map from correction MIDI
    const correctionMidi = readMidi(
        correctionBytes.buffer.slice(correctionBytes.byteOffset, correctionBytes.byteOffset + correctionBytes.byteLength),
    );
    const timingMap = buildTimingMap(measuredNotesFromMsm(baseMsm), correctionMidi, range);

    // Map vocal chunks to playback times
    const judgeChunk = vocalChunks.find(c => c.marker === 'JUDGE');
    const judgeDurationSec = judgeChunk?.durationSec ?? 0;
    const JUDGE_TO_CORRECTION_BUFFER_SEC = 0.2;
    const correctionEntrySec = judgeDurationSec + JUDGE_TO_CORRECTION_BUFFER_SEC;

    // Build mood chord from harmonic reduction (if available)
    let moodPlan: ReturnType<typeof buildJudgementMoodRenderPlan> = null;
    let moodBytes: Buffer | null = null;
    if (reductionMei && reductionMsmNotes) {
        const reductionBaseMsm = new MSM(reductionMsmNotes, { numerator: 4, denominator: 4 });
        moodPlan = buildJudgementMoodRenderPlan(
            measuredNotesFromMsm(reductionBaseMsm),
            measuredNotesFromMsm(baseMsm),
            teacherMpm,
            range.from,
            { minimumPedalHoldMs: correctionEntrySec * 1000 + JUDGEMENT_MOOD_PEDAL_BUFFER_MS },
        );
        if (moodPlan) {
            console.log(`    Mood chord at ${moodPlan.chordDate} (notes=${moodPlan.noteCount})...`);
            moodBytes = await renderMidi(
                'reduction',
                reductionMei,
                moodPlan.range,
                { mpmXml: exportMPM(moodPlan.mpm as MPM) },
            );
        }
    }

    // Schedule vocal chunks using PAVA layout (optimal non-overlapping positions)
    const CUE_DELAY_DEFAULT_REGION = 2.0;
    const MIN_CUE_GAP_SEC = 0.25;
    const END_GAP_SEC = 1.5;
    const scheduledChunks: Array<{ marker: string; atSec: number; audioPath: string }> = [];

    // JUDGE is fixed at t=0
    const judgeVocal = vocalChunks.find(c => c.marker === 'JUDGE');
    if (judgeVocal) {
        scheduledChunks.push({ marker: 'JUDGE', atSec: 0, audioPath: judgeVocal.audioPath });
        console.log(`    Schedule "JUDGE" at 0.00s`);
    }

    // Collect positional cues with ideal times
    const positional = vocalChunks
        .filter(c => c.marker !== 'JUDGE' && c.marker !== 'END')
        .map(c => {
            const tick = positionToTick(c.marker);
            if (tick === null) return null;
            return { chunk: c, ideal: secAtDate(timingMap, tick) + cueDelay(CUE_DELAY_DEFAULT_REGION) + correctionEntrySec };
        })
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .sort((a, b) => a.ideal - b.ideal);

    // Build layout items (positional + END)
    const layoutItems: { chunk: VocalChunkFile; ideal: number; gapAfter: number }[] = positional.map(
        p => ({ chunk: p.chunk, ideal: p.ideal, gapAfter: MIN_CUE_GAP_SEC }),
    );
    const endVocal = vocalChunks.find(c => c.marker === 'END');
    if (endVocal) {
        if (layoutItems.length > 0) layoutItems[layoutItems.length - 1].gapAfter = END_GAP_SEC;
        const lastPos = positional[positional.length - 1];
        const endIdeal = lastPos
            ? lastPos.ideal + lastPos.chunk.durationSec + END_GAP_SEC
            : correctionEntrySec + END_GAP_SEC;
        layoutItems.push({ chunk: endVocal, ideal: endIdeal, gapAfter: 0 });
    }

    // Run PAVA layout
    if (layoutItems.length > 0) {
        const positions = layoutCues(layoutItems.map(item => ({
            ideal: item.ideal,
            duration: item.chunk.durationSec,
            gapAfter: item.gapAfter,
        })));
        for (let i = 0; i < layoutItems.length; i++) {
            const { chunk } = layoutItems[i];
            const atSec = positions[i];
            const drift = atSec - layoutItems[i].ideal;
            scheduledChunks.push({ marker: chunk.marker, atSec, audioPath: chunk.audioPath });
            console.log(`    Schedule "${chunk.marker}" at ${atSec.toFixed(2)}s (ideal=${layoutItems[i].ideal.toFixed(2)}s, drift=${drift >= 0 ? '+' : ''}${drift.toFixed(2)}s)`);
        }
    }

    // 7. MIDI → WAV → combine → MP3
    console.log('  [7/8] Combining → MP3...');
    try {
        const studentWav = `${OUT_DIR}/${scenario.name}_student.wav`;
        const teacherMidPath = `${OUT_DIR}/${scenario.name}_teacher.mid`;
        const teacherWav = `${OUT_DIR}/${scenario.name}_teacher.wav`;
        const teacherMixedWav = `${OUT_DIR}/${scenario.name}_teacher_with_vocal.wav`;

        let finalMidPath: string;
        let finalScheduledChunks = scheduledChunks;

        if (moodBytes && moodPlan) {
            const moodMidi = readMidi(
                moodBytes.buffer.slice(moodBytes.byteOffset, moodBytes.byteOffset + moodBytes.byteLength),
            );
            const connectedMidi = appendMidiWithOffset(
                moodMidi,
                correctionMidi,
                millisecondsToMidiTicks(moodMidi, correctionEntrySec * 1000),
            );
            fs.writeFileSync(teacherMidPath, Buffer.from(writeMidi(connectedMidi.tracks, connectedMidi.header.ticksPerBeat)));
            finalMidPath = teacherMidPath;
            // JUDGE chunk already at 0, musical chunks already offset by correctionEntrySec
        } else {
            // No mood chord — delay correction MIDI so JUDGE narration finishes first
            const delayedMidi = delayMidi(correctionMidi, millisecondsToMidiTicks(correctionMidi, correctionEntrySec * 1000));
            fs.writeFileSync(teacherMidPath, Buffer.from(writeMidi(delayedMidi.tracks, delayedMidi.header.ticksPerBeat)));
            finalMidPath = teacherMidPath;
        }

        // Export visualization data for render_teacher_pianoroll.py
        const teacherVizBytes = fs.readFileSync(finalMidPath);
        const teacherVizMidi = readMidi(
            teacherVizBytes.buffer.slice(
                teacherVizBytes.byteOffset,
                teacherVizBytes.byteOffset + teacherVizBytes.byteLength,
            ),
        );
        const teacherNotes = extractMidiNoteEvents(teacherVizMidi);
        const pedalEvents = extractPedalEvents(teacherVizMidi);
        const vizData = {
            scenario: scenario.name,
            correctionEntrySec,
            hasMoodChord: !!moodPlan,
            notes: teacherNotes.map(n => ({
                ...n,
                source: n.onset < correctionEntrySec - 0.05 ? 'mood' : 'correction',
            })),
            pedal: pedalEvents,
            scheduledChunks: finalScheduledChunks.map(c => {
                const chunk = vocalChunks.find(vc => vc.marker === c.marker);
                return {
                    marker: c.marker,
                    atSec: c.atSec,
                    audioStartSec: chunk?.startSec ?? 0,
                    audioEndSec: chunk?.endSec ?? 0,
                    durationSec: chunk?.durationSec ?? 0,
                    text: chunk?.text ?? '',
                };
            }),
            vocalAudioPath: teacherStreamResp.audioBase64
                ? `${OUT_DIR}/${scenario.name}_vocal_full.mp3`
                : null,
        };
        fs.writeFileSync(
            `${OUT_DIR}/${scenario.name}_teacher_viz.json`,
            JSON.stringify(vizData, null, 2),
        );
        console.log(`    Visualization: ${scenario.name}_teacher_viz.json`);

        midiToWav(studentMidPath, studentWav);
        midiToWav(finalMidPath, teacherWav);

        // Mix vocal chunks into teacher WAV
        const vocalInputs = finalScheduledChunks.map(c => ({ id: c.marker, atSec: c.atSec, audioPath: c.audioPath }));
        mixTeacherWithCues(teacherWav, vocalInputs, teacherMixedWav);

        const mp3Path = `${OUT_DIR}/${scenario.name}.mp3`;
        combineToMp3(studentWav, teacherMixedWav, mp3Path);
        console.log(`    → ${mp3Path}`);

        for (const f of [studentWav, teacherWav, teacherMixedWav]) {
            try { fs.unlinkSync(f); } catch { /* ignore */ }
        }
    } catch (e: any) {
        console.log(`    MP3 combine failed: ${e.message}`);
        console.log('    (MIDI files are still available for manual processing)');
    }

    console.log('  [8/8] Done.');
}

// ── Summary ──

console.log(`\n${'═'.repeat(60)}`);
console.log('Done! Output files:');
const files = fs.readdirSync(OUT_DIR).sort();
for (const f of files) {
    const stat = fs.statSync(`${OUT_DIR}/${f}`);
    console.log(`  ${f} (${(stat.size / 1024).toFixed(0)} KB)`);
}
