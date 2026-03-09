/**
 * generate_test.ts — Full dialogic teaching pipeline test
 *
 * Generates MP3s: student playing → spoken explanation → teacher playing
 * Uses the same infrastructure as the frontend (local matcher, /explain-and-speak).
 *
 * Requires:
 *   - meico server at http://localhost:8080 (/convert, /perform)
 *   - virtual-gruenfeld server (/explain-and-speak) — optional, skips speech if unavailable
 *   - timidity or fluidsynth + SF2_PATH (MIDI → WAV)
 *   - ffmpeg (audio concat + MP3 encoding)
 *
 * Run:  npx tsx generate_test.ts
 */

import * as fs from 'fs';
import { execSync } from 'child_process';
import 'dotenv/config';
import { read as readMidi } from 'midifile-ts';
import { implantLocal } from './client/src/matcher';

// Import from TypeScript source directly — the compiled lib has a CJS/ESM
// mismatch (ESM syntax without "type":"module" in package.json) that breaks
// Node's ESM loader. Importing source lets tsx compile on the fly.
const { MPM } = await import('../mpm-ts/src/MPM.ts');
const { exportMPM } = await import('../mpm-ts/src/Serialization.ts');
const { MSM, importWork } = await import('../mpmify/src/index.ts');

type MPM = InstanceType<typeof MPM>;
type MSM = InstanceType<typeof MSM>;

// ── Config ──

const CONVERT_URL = 'http://localhost:8080/convert';
const PERFORM_URL = 'http://localhost:8080/perform';
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';
const PPQ = 720;
const BEAT = PPQ;
const MEASURE = 4 * BEAT;
const AGGRESSIVENESS = 0.4;
const OUT_DIR = 'test_output';

// ── Helpers ──

const assertOk = async (r: Response, label: string) => {
    if (r.ok) return;
    let text = '';
    try { text = await r.text(); } catch { /* ignore */ }
    throw new Error(`${label}: HTTP ${r.status} ${r.statusText}${text ? `: ${text}` : ''}`);
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Fetch with retry on connection errors (meico sometimes drops connections) */
async function fetchRetry(url: string, init: RequestInit, label: string, retries = 2): Promise<Response> {
    for (let i = 0; i <= retries; i++) {
        try {
            return await fetch(url, init);
        } catch (e: any) {
            if (i < retries && (e.cause?.code === 'ECONNRESET' || e.cause?.code === 'ECONNREFUSED')) {
                console.log(`    (${label}: connection error, retrying in 2s...)`);
                await sleep(2000);
                continue;
            }
            throw e;
        }
    }
    throw new Error('unreachable');
}

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

/** Fetch explanation + speech audio via SSE from /explain-and-speak */
async function explainAndSpeak(diffText: string): Promise<{ explanation: string; audio: Buffer }> {
    const res = await fetch(`${SERVER_URL}/explain-and-speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diff: diffText }),
    });
    await assertOk(res, '/explain-and-speak');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventType = '';
    let explanation = '';
    const audioChunks: Buffer[] = [];

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
                    explanation += data;
                } else if (eventType === 'audio') {
                    audioChunks.push(Buffer.from(data, 'base64'));
                }
            }
        }
    }

    return { explanation, audio: Buffer.concat(audioChunks) };
}

/** Convert MIDI file to WAV using timidity or fluidsynth */
function midiToWav(midiPath: string, wavPath: string) {
    try {
        execSync(`timidity "${midiPath}" -Ow -o "${wavPath}"`, { stdio: 'pipe' });
        return;
    } catch { /* timidity not found, try fluidsynth */ }

    const sf2 = process.env.SF2_PATH;
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

/** Combine student WAV + speech MP3 + teacher WAV → output MP3 */
function combineToMp3(studentWav: string, speechMp3: string | null, teacherWav: string, outputMp3: string) {
    if (speechMp3 && fs.existsSync(speechMp3)) {
        execSync(
            `ffmpeg -y -i "${studentWav}" -i "${speechMp3}" -i "${teacherWav}" ` +
            `-filter_complex "` +
            `[0:a]apad=pad_dur=1.5[s];` +
            `[1:a]apad=pad_dur=1[sp];` +
            `[s][sp][2:a]concat=n=3:v=0:a=1[out]" ` +
            `-map "[out]" -codec:a libmp3lame -b:a 192k "${outputMp3}"`,
            { stdio: 'pipe' },
        );
    } else {
        execSync(
            `ffmpeg -y -i "${studentWav}" -i "${teacherWav}" ` +
            `-filter_complex "` +
            `[0:a]apad=pad_dur=2[s];` +
            `[s][1:a]concat=n=2:v=0:a=1[out]" ` +
            `-map "[out]" -codec:a libmp3lame -b:a 192k "${outputMp3}"`,
            { stdio: 'pipe' },
        );
    }
}

/** Deep clone an MPM (the built-in clone() is shallow and shares the doc) */
function deepCloneMpm(mpm: MPM): MPM {
    const clone = new MPM();
    clone.doc = structuredClone(mpm.doc);
    return clone;
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

const signStr = (n: number): string => (n > 0 ? '+' : '') + Math.round(n);

const SEVERITY_THRESHOLDS: Record<string, [number, number]> = {
    bpm: [15, 40], volume: [12, 30], 'transition.to': [15, 40],
    relativeDuration: [0.15, 0.4], relativeVelocity: [0.15, 0.4],
    intensity: [0.3, 0.8], scale: [0.5, 2],
    'milliseconds.offset': [15, 40], frameLength: [150, 400],
};

const severity = (attr: string, delta: number): string => {
    const abs = Math.abs(delta);
    const [mod, large] = SEVERITY_THRESHOLDS[attr] ?? [0, 0];
    if (abs >= large) return '!!';
    if (abs >= mod) return '!';
    return '~';
};

type InstructionDiff = {
    date: number;
    type: string;
    diffs: Record<string, { ref: number; student: number; delta: number }>;
    magnitude: number;
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

const formatTempoLine = (p: InstructionDiff): string => {
    const pos = tickToPos(p.date);
    const bpm = p.diffs['bpm'];
    const trans = p.diffs['transition.to'];
    const sev = severity('bpm', bpm.delta);
    let line = `  ${sev} ${pos}: ${Math.round(bpm.ref)}→${Math.round(bpm.student)} bpm (${signStr(bpm.delta)})`;
    if (trans && Math.abs(trans.delta) >= THRESHOLDS['transition.to']) {
        const refDir = trans.ref > bpm.ref ? 'accel' : trans.ref < bpm.ref ? 'rit' : 'const';
        const stuDir = trans.student > bpm.student ? 'accel' : trans.student < bpm.student ? 'rit' : 'const';
        line += `, ${refDir}→${Math.round(trans.ref)} vs ${stuDir}→${Math.round(trans.student)}`;
    }
    return line;
};

const formatDynamicsLine = (p: InstructionDiff): string => {
    const pos = tickToPos(p.date);
    const vol = p.diffs['volume'];
    const trans = p.diffs['transition.to'];
    const sev = severity('volume', vol.delta);
    let line = `  ${sev} ${pos}: ${dynLabel(vol.ref)}(${Math.round(vol.ref)})→${dynLabel(vol.student)}(${Math.round(vol.student)}) (${signStr(vol.delta)})`;
    if (trans && Math.abs(trans.delta) >= THRESHOLDS['transition.to']) {
        const refDir = trans.ref > vol.ref ? 'cresc' : trans.ref < vol.ref ? 'decresc' : 'const';
        const stuDir = trans.student > vol.student ? 'cresc' : trans.student < vol.student ? 'decresc' : 'const';
        line += `, ${refDir}→${dynLabel(trans.ref)}(${Math.round(trans.ref)}) vs ${stuDir}→${dynLabel(trans.student)}(${Math.round(trans.student)})`;
    }
    return line;
};

const formatGenericLine = (p: InstructionDiff): string => {
    const pos = tickToPos(p.date);
    const entries = Object.entries(p.diffs)
        .filter(([, { delta }]) => Math.abs(delta) >= (THRESHOLDS['intensity'] ?? 0));
    const maxSev = entries.reduce((s, [attr, { delta }]) => {
        const sv = severity(attr, delta);
        return sv === '!!' ? '!!' : sv === '!' && s !== '!!' ? '!' : s;
    }, '~' as string);
    const parts = entries.map(([attr, { ref, student, delta }]) =>
        `${attr}: ${ref.toFixed(1)}→${student.toFixed(1)} (${signStr(delta)})`);
    return `  ${maxSev} ${pos}: ${parts.join(', ')}`;
};

const TYPE_ORDER = ['tempo', 'dynamics', 'articulation', 'rubato', 'ornament', 'accentuationPattern', 'asynchrony'];
const TYPE_LABELS: Record<string, string> = {
    tempo: 'TEMPO', dynamics: 'DYNAMICS', articulation: 'ARTICULATION',
    rubato: 'RUBATO', ornament: 'ORNAMENTS (arpeggio)',
    accentuationPattern: 'METRIC ACCENTS', asynchrony: 'VOICE ASYNCHRONY',
};
const PRIMARY_ATTR: Record<string, string> = {
    tempo: 'bpm', dynamics: 'volume', articulation: 'relativeDuration',
    rubato: 'intensity', ornament: 'scale', accentuationPattern: 'scale',
    asynchrony: 'milliseconds.offset',
};

const groupDirection = (items: InstructionDiff[], primaryAttr: string): string => {
    const deltas = items.map(i => i.diffs[primaryAttr]?.delta).filter((d): d is number => d != null);
    if (deltas.length === 0) return '';
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const allSameDir = deltas.every(d => d > 0) || deltas.every(d => d < 0);
    const q = allSameDir ? 'consistently' : 'generally';
    if (primaryAttr === 'bpm') return avg > 0 ? `student ${q} faster` : `student ${q} slower`;
    if (primaryAttr === 'volume') return avg > 0 ? `student ${q} louder` : `student ${q} softer`;
    if (primaryAttr === 'relativeDuration') return avg > 0 ? `student ${q} more legato` : `student ${q} more staccato`;
    if (primaryAttr === 'relativeVelocity') return avg > 0 ? `student ${q} more accented` : `student ${q} less accented`;
    if (primaryAttr === 'intensity') return avg > 0 ? `student ${q} more` : `student ${q} less`;
    if (primaryAttr === 'scale') return avg > 0 ? `student ${q} stronger` : `student ${q} weaker`;
    if (primaryAttr === 'milliseconds.offset') return avg > 0 ? `student ${q} more delayed` : `student ${q} more ahead`;
    return '';
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
    const sections: string[] = [`${top.length} deviations in ${rangeStr} (~ slight, ! moderate, !! large):`];

    for (const type of TYPE_ORDER) {
        const items = grouped.get(type);
        if (!items) continue;
        items.sort((a, b) => a.date - b.date);
        const label = TYPE_LABELS[type] ?? type;
        const dir = groupDirection(items, PRIMARY_ATTR[type]);
        sections.push(`\n${label}${dir ? ` — ${dir}` : ''}:`);
        for (const p of items) {
            if (type === 'tempo') sections.push(formatTempoLine(p));
            else if (type === 'dynamics') sections.push(formatDynamicsLine(p));
            else sections.push(formatGenericLine(p));
        }
    }

    return sections.join('\n');
};

const logExaggerate = (ref: number, student: number, aggressiveness: number, min: number, max: number): number => {
    if (student <= 0 || ref <= 0) return ref;
    return Math.max(min, Math.min(max, ref * Math.pow(ref / student, aggressiveness)));
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
            if (instruction.type === 'asynchrony') {
                instruction[attr] = Math.max(min, Math.min(max, refVal - (studentVal - refVal) * aggressiveness));
            } else {
                instruction[attr] = logExaggerate(refVal, studentVal, aggressiveness, min, max);
            }
        }
    }
};

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

console.log('Converting MEI → MSM via /convert...');
const convertResp = await fetchRetry(CONVERT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mei }),
}, 'convert');
await assertOk(convertResp, '/convert');
const msmXml = (await convertResp.json()).msm;

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

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const scenario of scenarios) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  ${scenario.name}: ${scenario.description}`);
    console.log(`  Range: ${scenario.startDate}–${scenario.endDate}`);
    console.log('═'.repeat(60));

    // 1. Render student MIDI via /perform
    console.log('  [1/7] Rendering student MIDI...');
    const studentPerformResp = await fetchRetry(PERFORM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mei, mpm: scenario.mpm,
            from: scenario.startDate, to: scenario.endDate, ppq: PPQ,
        }),
    }, 'student perform');
    await assertOk(studentPerformResp, '/perform (student)');
    const studentMidiBytes = Buffer.from((await studentPerformResp.json()).midi_b64, 'base64');
    const studentMidPath = `${OUT_DIR}/${scenario.name}_student.mid`;
    fs.writeFileSync(studentMidPath, studentMidiBytes);

    // 2. Match + implant (local matcher — same as frontend)
    console.log('  [2/7] Matching & implanting...');
    const midiFile = readMidi(
        studentMidiBytes.buffer.slice(
            studentMidiBytes.byteOffset,
            studentMidiBytes.byteOffset + studentMidiBytes.byteLength,
        ),
    );
    const dateHint = (scenario.startDate + scenario.endDate) / 2;
    const { studentMsm, range } = implantLocal(baseMsm, midiFile, dateHint);
    console.log(`    Implant range: [${range.from}, ${range.to}]`);

    // 3. Build student MPM via mpmify
    console.log('  [3/7] Building student MPM...');
    console.log = () => {};
    const studentMpm = buildMpm(studentMsm, infoJson);
    console.log = origLog;

    // 4. Diff
    console.log('  [4/7] Diffing reference vs student...');
    const diffResult = diff(referenceMpm, studentMpm, range);
    console.log(`    ${diffResult.split('\n')[0]}`);
    fs.writeFileSync(`${OUT_DIR}/${scenario.name}_diff.txt`, diffResult);

    // 5. Explain + speak (via /explain-and-speak → OpenAI + ElevenLabs)
    let speechPath: string | null = null;
    if (diffResult !== "No significant differences found.") {
        console.log('  [5/7] Explain + speak...');
        try {
            const { explanation, audio } = await explainAndSpeak(diffResult);
            console.log(`    "${explanation}"`);
            fs.writeFileSync(`${OUT_DIR}/${scenario.name}_explanation.txt`, explanation);
            if (audio.length > 0) {
                speechPath = `${OUT_DIR}/${scenario.name}_speech.mp3`;
                fs.writeFileSync(speechPath, audio);
                console.log(`    Speech: ${(audio.length / 1024).toFixed(0)} KB`);
            }
        } catch (e: any) {
            console.log(`    Explain+speak unavailable: ${e.message}`);
            console.log('    (continuing without speech)');
        }
    } else {
        console.log('  [5/7] No significant differences — skipping explanation');
    }

    // 6. Exaggerate + render teacher MIDI
    console.log('  [6/7] Exaggerating + rendering teacher MIDI...');
    const teacherMpm = deepCloneMpm(referenceMpm);
    exaggerate(teacherMpm, studentMpm, range, AGGRESSIVENESS);

    const teacherPerformResp = await fetchRetry(PERFORM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mei, mpm: exportMPM(teacherMpm),
            from: range.from, to: range.to, ppq: PPQ,
        }),
    }, 'teacher perform');
    await assertOk(teacherPerformResp, '/perform (teacher)');
    const teacherMidiBytes = Buffer.from((await teacherPerformResp.json()).midi_b64, 'base64');
    const teacherMidPath = `${OUT_DIR}/${scenario.name}_teacher.mid`;
    fs.writeFileSync(teacherMidPath, teacherMidiBytes);

    // 7. MIDI → WAV → combine → MP3
    console.log('  [7/7] Combining → MP3...');
    try {
        const studentWav = `${OUT_DIR}/${scenario.name}_student.wav`;
        const teacherWav = `${OUT_DIR}/${scenario.name}_teacher.wav`;
        midiToWav(studentMidPath, studentWav);
        midiToWav(teacherMidPath, teacherWav);

        const mp3Path = `${OUT_DIR}/${scenario.name}.mp3`;
        combineToMp3(studentWav, speechPath, teacherWav, mp3Path);
        console.log(`    → ${mp3Path}`);

        // Clean up intermediate WAV files
        for (const f of [studentWav, teacherWav]) {
            try { fs.unlinkSync(f); } catch { /* ignore */ }
        }
    } catch (e: any) {
        console.log(`    MP3 combine failed: ${e.message}`);
        console.log('    (MIDI files are still available for manual processing)');
    }
}

// ── Summary ──

console.log(`\n${'═'.repeat(60)}`);
console.log('Done! Output files:');
const files = fs.readdirSync(OUT_DIR).sort();
for (const f of files) {
    const stat = fs.statSync(`${OUT_DIR}/${f}`);
    console.log(`  ${f} (${(stat.size / 1024).toFixed(0)} KB)`);
}
