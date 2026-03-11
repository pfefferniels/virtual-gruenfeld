import { MPM, OrnamentDef } from "mpm-ts";
import { importWork, MSM } from "mpmify";
import { DynamicsTransformerOptions, reprojectPhantomVelocities } from "./dynamicsSafety";
import { reprojectSilentOnsets, sanitizeTempoInstructions, TempoTransformerOptions } from "./tempoSafety";

export type Range = { from: number; to: number };

type MpmifyOptions = {
    referenceMsm?: MSM;
    log?: (msg: string) => void;
};

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
export const mpmify = (msm: MSM, infoJson: any, options: MpmifyOptions = {}): MPM => {
    const mpm = new MPM();
    const { transformers } = importWork(infoJson);
    transformers.forEach(transformer => {
        if (options.referenceMsm && transformer.name === 'InsertDynamicsInstructions') {
            const dynamicsOptions = transformer.options as DynamicsTransformerOptions | undefined;
            if (dynamicsOptions?.phantomVelocities instanceof Map && dynamicsOptions.phantomVelocities.size > 0) {
                dynamicsOptions.phantomVelocities = reprojectPhantomVelocities(
                    dynamicsOptions,
                    options.referenceMsm,
                    msm,
                    options.log,
                );
            }
        }

        if (options.referenceMsm && transformer.name === 'ApproximateLogarithmicTempo') {
            const tempoOptions = transformer.options as TempoTransformerOptions | undefined;
            if (tempoOptions && Array.isArray(tempoOptions.silentOnsets) && tempoOptions.silentOnsets.length > 0) {
                tempoOptions.silentOnsets = reprojectSilentOnsets(
                    tempoOptions,
                    options.referenceMsm,
                    msm,
                    options.log,
                );
            }
        }

        transformer.run(msm, mpm);

        if (transformer.name === 'ApproximateLogarithmicTempo') {
            const tempoOptions = transformer.options as TempoTransformerOptions | undefined;
            sanitizeTempoInstructions(mpm, tempoOptions?.scope, options.log);
        }
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
    if (abs >= large) return 'large';
    if (abs >= mod) return 'mod';
    return 'slight';
};

type InstructionDiff = {
    date: number;
    type: string;
    nameRef?: string;
    diffs: Record<string, { ref: number; student: number; delta: number }>;
    magnitude: number;
};

export type DiffSeverity = 'slight' | 'mod' | 'large';

export type StructuredDiffEvent = {
    id: string;
    date: number;
    position: string;
    type: string;
    severity: DiffSeverity;
    primaryAttr: string;
    magnitude: number;
    cueText: string;
    direction: 'more' | 'less';
    refValue: number;
    studentValue: number;
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

        // For ornaments, also diff temporalSpread.frameLength from the definition
        if (instruction.type === 'ornament' && instruction['name.ref']) {
            const refDef = mpm1.getDefinition('ornamentDef', instruction['name.ref']) as OrnamentDef | null;
            const stuDef = mpm2.getDefinition('ornamentDef', corresp['name.ref'] ?? instruction['name.ref']) as OrnamentDef | null;
            const refFL = refDef?.temporalSpread?.frameLength;
            const stuFL = stuDef?.temporalSpread?.frameLength;
            if (typeof refFL === 'number' && typeof stuFL === 'number') {
                const delta = stuFL - refFL;
                if (Math.abs(delta) >= (THRESHOLDS['frameLength'] ?? 0)) hasSignificant = true;
                diffs['frameLength'] = { ref: refFL, student: stuFL, delta };
                magnitude += Math.abs(delta);
            }
        }

        if (!hasSignificant || Object.keys(diffs).length === 0) continue;
        peaks.push({ date: instruction.date, type: instruction.type, nameRef: instruction['name.ref'], diffs, magnitude });
    }

    return peaks;
};

// Human-readable attribute labels per instruction type (for LLM clarity)
const ATTR_LABELS: Record<string, Record<string, string>> = {
    ornament: {
        scale: 'dynamicsGradient(scale)',
        intensity: 'temporalSpread(intensity)',
    },
};

const attrLabel = (type: string, attr: string): string =>
    ATTR_LABELS[type]?.[attr] ?? attr;

// ── Table formatting ──

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

const ornamentRow = (p: InstructionDiff, mpm: MPM): string[] => {
    const entries = Object.entries(p.diffs)
        .filter(([attr, { delta }]) => Math.abs(delta) >= (THRESHOLDS[attr] ?? 0));
    const maxSev = entries.reduce((s, [attr, { delta }]) => {
        const sv = severity(attr, delta);
        return sv === 'large' ? 'large' : sv === 'mod' && s !== 'large' ? 'mod' : s;
    }, 'slight' as string);
    let style = '';
    if (p.nameRef) {
        const def = mpm.getDefinition('ornamentDef', p.nameRef) as OrnamentDef | null;
        if (def) {
            const tags: string[] = [];
            if (def.temporalSpread) tags.push('arpeggio');
            if (def.dynamicsGradient) tags.push('dyn-gradient');
            style = tags.join('+');
        }
    }
    const refParts = entries.map(([attr, { ref }]) =>
        attr === 'frameLength'
            ? `${attrLabel(p.type, attr)}: ${Math.round(ref)}`
            : `${attrLabel(p.type, attr)}: ${ref.toFixed(1)}`);
    const stuParts = entries.map(([attr, { student }]) =>
        attr === 'frameLength'
            ? `${attrLabel(p.type, attr)}: ${Math.round(student)}`
            : `${attrLabel(p.type, attr)}: ${student.toFixed(1)}`);
    return [tickToPos(p.date), maxSev, style || '—', refParts.join(', '), stuParts.join(', ')];
};

const genericRow = (p: InstructionDiff): string[] => {
    const entries = Object.entries(p.diffs)
        .filter(([, { delta }]) => Math.abs(delta) >= (THRESHOLDS['intensity'] ?? 0));
    const maxSev = entries.reduce((s, [attr, { delta }]) => {
        const sv = severity(attr, delta);
        return sv === 'large' ? 'large' : sv === 'mod' && s !== 'large' ? 'mod' : s;
    }, 'slight' as string);
    const refParts = entries.map(([attr, { ref }]) =>
        `${attrLabel(p.type, attr)}: ${ref.toFixed(1)}`);
    const stuParts = entries.map(([attr, { student }]) =>
        `${attrLabel(p.type, attr)}: ${student.toFixed(1)}`);
    return [tickToPos(p.date), maxSev, refParts.join(', '), stuParts.join(', ')];
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

const PER_TYPE_TOP_N = 3;

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

const topDiffsByType = (peaks: InstructionDiff[], perTypeN: number): InstructionDiff[] => {
    const byType = new Map<string, InstructionDiff[]>();
    for (const p of peaks) {
        const group = byType.get(p.type) ?? [];
        group.push(p);
        byType.set(p.type, group);
    }

    const selected: InstructionDiff[] = [];
    for (const [type, items] of byType) {
        items.sort((a, b) => b.magnitude - a.magnitude);
        selected.push(...items.slice(0, perTypeN));
        byType.set(type, items);
    }
    return selected;
};

export const diffStructured = (
    mpm1: MPM,
    mpm2: MPM,
    range: Range,
    perTypeN: number = PER_TYPE_TOP_N,
): StructuredDiffEvent[] => {
    const peaks = collectDiffs(mpm1, mpm2, range);
    if (peaks.length === 0) return [];

    return topDiffsByType(peaks, perTypeN)
        .sort((a, b) => a.date - b.date || b.magnitude - a.magnitude)
        .map((p, index) => {
            const [primaryAttr, primary] = primaryDiffEntry(p);
            const sev = severity(primaryAttr, primary.delta) as DiffSeverity;
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

export const diff = (mpm1: MPM, mpm2: MPM, range: Range, perTypeN: number = PER_TYPE_TOP_N): string => {
    const peaks = collectDiffs(mpm1, mpm2, range);
    if (peaks.length === 0) return "No significant differences found.";

    // Group by type, keep top N per type by magnitude
    const grouped = new Map<string, InstructionDiff[]>();
    let totalCount = 0;
    for (const top of topDiffsByType(peaks, perTypeN)) {
        const items = grouped.get(top.type) ?? [];
        items.push(top);
        grouped.set(top.type, items);
    }
    for (const [, top] of grouped) {
        totalCount += top.length;
    }

    const rangeStr = `${tickToPos(range.from)}–${tickToPos(range.to)}`;
    const sections: string[] = [`${totalCount} deviations in ${rangeStr}:`];

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
        } else if (type === 'ornament') {
            headers = ['pos', 'sev', 'style', 'ref', 'student'];
            rows = items.map(p => ornamentRow(p, mpm1));
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
    const ratio = ref / student;
    return Math.max(min, Math.min(max, ref * Math.pow(ratio, aggressiveness)));
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
        intensity: { strength: 0.35, maxAbsDelta: 0.25 },
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
        { attr: 'intensity', min: 0.01, max: 10 },
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
            const tuning = EXAGGERATION_TUNING[instruction.type]?.[attr] ?? { strength: 1, maxAbsDelta: max };
            const effectiveAggressiveness = aggressiveness * tuning.strength;
            if (instruction.type === 'asynchrony') {
                const delta = studentVal - refVal;
                const exaggerated = refVal - delta * effectiveAggressiveness;
                instruction[attr] = applyExaggerationCap(refVal, exaggerated, tuning.maxAbsDelta, min, max);
            } else {
                const exaggerated = logExaggerate(refVal, studentVal, effectiveAggressiveness, min, max);
                instruction[attr] = applyExaggerationCap(refVal, exaggerated, tuning.maxAbsDelta, min, max);
            }
            changes.push(`${attr}: ${old.toFixed(1)}→${instruction[attr].toFixed(1)} (student=${studentVal.toFixed(1)})`);
        }
        if (changes.length > 0) {
            log(`exaggerate ${instruction.type} ${instruction["xml:id"]} ${changes.join(', ')}`);
        }
    }
};
