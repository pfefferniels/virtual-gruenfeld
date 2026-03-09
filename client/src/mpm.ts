import { MPM } from "mpm-ts";
import { importWork, MSM } from "mpmify";

export type Range = { from: number; to: number };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inRange = (i: any, range: Range) => {
    const date = i.date ?? i["date"];
    return typeof date === 'number' && date >= range.from && date <= range.to;
};

const indexInstructions = (mpm: MPM) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idx = new Map<string, any>();
    for (const i of mpm.getInstructions()) {
        idx.set(`${i.type}::${i["xml:id"]}`, i);
    }
    return idx;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mpmify = (msm: MSM, infoJson: any): MPM => {
    const mpm = new MPM();
    const { transformers } = importWork(infoJson);
    transformers.forEach(transformer => {
        transformer.run(msm, mpm);
    });
    return mpm;
};

const THRESHOLDS: Record<string, number> = {
    volume: 4,
    bpm: 4,
    "transition.to": 4,
    relativeDuration: 0.05,
    relativeVelocity: 0.05,
    intensity: 0.1,
    scale: 0.1,
    "milliseconds.offset": 5,
    frameLength: 50,
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

const PPQ = 720;
const BEATS_PER_MEASURE = 4;
const TICKS_PER_MEASURE = PPQ * BEATS_PER_MEASURE;

const tickToPos = (tick: number): string => {
    const m = Math.floor(tick / TICKS_PER_MEASURE) + 1;
    const b = Math.floor((tick % TICKS_PER_MEASURE) / PPQ) + 1;
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

/** Severity based on how far the primary attribute exceeds its threshold */
const SEVERITY_THRESHOLDS: Record<string, [number, number]> = {
    // [moderate, large] as multiples of THRESHOLDS
    bpm: [15, 40],
    volume: [12, 30],
    'transition.to': [15, 40],
    relativeDuration: [0.15, 0.4],
    relativeVelocity: [0.15, 0.4],
    intensity: [0.3, 0.8],
    scale: [0.5, 2],
    'milliseconds.offset': [15, 40],
    frameLength: [150, 400],
};

const severity = (attr: string, delta: number): string => {
    const abs = Math.abs(delta);
    const [mod, large] = SEVERITY_THRESHOLDS[attr] ?? [0, 0];
    if (abs >= large) return '!!';   // large
    if (abs >= mod) return '!';      // moderate
    return '~';                       // slight
};

type InstructionDiff = {
    date: number;
    type: string;
    diffs: Record<string, { ref: number; student: number; delta: number }>;
    magnitude: number;
};

const collectDiffs = (mpm1: MPM, mpm2: MPM, range: Range): InstructionDiff[] => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allInstructions: any[] = mpm1.getInstructions().filter(i => inRange(i, range));
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
    tempo: 'TEMPO',
    dynamics: 'DYNAMICS',
    articulation: 'ARTICULATION',
    rubato: 'RUBATO',
    ornament: 'ORNAMENTS (arpeggio)',
    accentuationPattern: 'METRIC ACCENTS',
    asynchrony: 'VOICE ASYNCHRONY',
};

const groupDirection = (items: InstructionDiff[], primaryAttr: string): string => {
    const deltas = items.map(i => i.diffs[primaryAttr]?.delta).filter((d): d is number => d != null);
    if (deltas.length === 0) return '';
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const allSameDir = deltas.every(d => d > 0) || deltas.every(d => d < 0);
    const qualifier = allSameDir ? 'consistently' : 'generally';
    if (primaryAttr === 'bpm') return avg > 0 ? `student ${qualifier} faster` : `student ${qualifier} slower`;
    if (primaryAttr === 'volume') return avg > 0 ? `student ${qualifier} louder` : `student ${qualifier} softer`;
    if (primaryAttr === 'relativeDuration') return avg > 0 ? `student ${qualifier} more legato` : `student ${qualifier} more staccato`;
    if (primaryAttr === 'relativeVelocity') return avg > 0 ? `student ${qualifier} more accented` : `student ${qualifier} less accented`;
    if (primaryAttr === 'intensity') return avg > 0 ? `student ${qualifier} more` : `student ${qualifier} less`;
    if (primaryAttr === 'scale') return avg > 0 ? `student ${qualifier} stronger` : `student ${qualifier} weaker`;
    if (primaryAttr === 'milliseconds.offset') return avg > 0 ? `student ${qualifier} more delayed` : `student ${qualifier} more ahead`;
    return '';
};

const PRIMARY_ATTR: Record<string, string> = {
    tempo: 'bpm', dynamics: 'volume', articulation: 'relativeDuration',
    rubato: 'intensity', ornament: 'scale', accentuationPattern: 'scale',
    asynchrony: 'milliseconds.offset',
};

export const diff = (mpm1: MPM, mpm2: MPM, range: Range, topN: number = 10): string => {
    const peaks = collectDiffs(mpm1, mpm2, range);
    if (peaks.length === 0) return "No significant differences found.";

    // Group by type, keep top N overall by magnitude, then format per group
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
    const ratio = ref / student;
    return Math.max(min, Math.min(max, ref * Math.pow(ratio, aggressiveness)));
};

const EXAGGERATION_SPEC: Record<string, Array<{ attr: string; min: number; max: number }>> = {
    dynamics: [
        { attr: 'volume', min: 1, max: 127 },
        { attr: 'transition.to', min: 1, max: 127 },
    ],
    tempo: [
        { attr: 'bpm', min: 10, max: 300 },
        { attr: 'transition.to', min: 10, max: 300 },
    ],
    articulation: [
        { attr: 'relativeDuration', min: 0.1, max: 5 },
        { attr: 'relativeVelocity', min: 0.1, max: 5 },
    ],
    rubato: [
        { attr: 'intensity', min: 0.01, max: 10 },
    ],
    ornament: [
        { attr: 'scale', min: 0.1, max: 20 },
    ],
    asynchrony: [
        { attr: 'milliseconds.offset', min: -500, max: 500 },
    ],
    accentuationPattern: [
        { attr: 'scale', min: 0, max: 10 },
    ],
};

export const exaggerate = (mpm1: MPM, mpm2: MPM, range: Range, aggressiveness: number = 1, log: (msg: string) => void) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allInstructions: any[] = mpm1.getInstructions().filter(i => inRange(i, range));
    const idx = indexInstructions(mpm2);

    for (const instruction of allInstructions) {
        const corresp = idx.get(`${instruction.type}::${instruction["xml:id"]}`);
        if (!corresp) continue;

        const specs = EXAGGERATION_SPEC[instruction.type];
        if (!specs) continue;

        const changes: string[] = [];
        for (const { attr, min, max } of specs) {
            const refVal = instruction[attr];
            const studentVal = corresp[attr];
            if (typeof refVal !== 'number' || typeof studentVal !== 'number') continue;

            const old = refVal;
            if (instruction.type === 'asynchrony') {
                const delta = studentVal - refVal;
                instruction[attr] = Math.max(min, Math.min(max, refVal - delta * aggressiveness));
            } else {
                instruction[attr] = logExaggerate(refVal, studentVal, aggressiveness, min, max);
            }
            changes.push(`${attr}: ${old.toFixed(1)}→${instruction[attr].toFixed(1)} (student=${studentVal.toFixed(1)})`);
        }
        if (changes.length > 0) {
            log(`exaggerate ${instruction.type} ${instruction["xml:id"]} ${changes.join(', ')}`);
        }
    }
};
