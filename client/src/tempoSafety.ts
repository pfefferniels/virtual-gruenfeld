import { MPM, Scope, Tempo } from "mpm-ts";
import { MSM } from "mpmify";

export type SilentOnset = {
    date: number;
    onset: number;
};

export type TempoTransformerOptions = {
    from: number;
    to: number;
    scope?: Scope;
    silentOnsets?: SilentOnset[];
};

type ProjectionSample = {
    date: number;
    refOnset: number;
    studentOnset: number;
};

const MIN_TEMPO_BPM = 10;
const TEMPO_EPSILON = 0.01;
const TIME_EPSILON = 1e-6;

const getMinimumOnset = (msm: MSM): number => {
    let min = Infinity;
    for (const note of msm.allNotes) {
        if (typeof note["midi.onset"] !== 'number') continue;
        min = Math.min(min, note["midi.onset"]);
    }
    return Number.isFinite(min) ? min : 0;
};

const buildProjectionSamples = (
    options: TempoTransformerOptions,
    referenceMsm: MSM,
    studentMsm: MSM,
): ProjectionSample[] => {
    const refById = new Map<string, number>();
    for (const note of referenceMsm.allNotes) {
        if (typeof note["midi.onset"] !== 'number') continue;
        refById.set(note["xml:id"], note["midi.onset"]);
    }

    const studentShift = getMinimumOnset(studentMsm);
    const byDate = new Map<number, ProjectionSample>();

    for (const note of studentMsm.allNotes) {
        if (note.source !== 'implanted') continue;
        if (note.date < options.from || note.date > options.to) continue;
        if (typeof note["midi.onset"] !== 'number') continue;

        const refOnset = refById.get(note["xml:id"]);
        if (typeof refOnset !== 'number') continue;

        const sample: ProjectionSample = {
            date: note.date,
            refOnset,
            studentOnset: note["midi.onset"] - studentShift,
        };
        const existing = byDate.get(sample.date);
        if (!existing || sample.studentOnset < existing.studentOnset) {
            byDate.set(sample.date, sample);
        }
    }

    const samples = Array.from(byDate.values())
        .sort((a, b) => a.refOnset - b.refOnset || a.date - b.date);

    const monotonic: ProjectionSample[] = [];
    let lastStudentOnset = -Infinity;
    for (const sample of samples) {
        if (sample.studentOnset + TIME_EPSILON < lastStudentOnset) continue;
        monotonic.push(sample);
        lastStudentOnset = sample.studentOnset;
    }
    return monotonic;
};

const projectByReferenceOnset = (anchorOnset: number, samples: ProjectionSample[]): number | null => {
    if (samples.length < 2) return null;

    for (const sample of samples) {
        if (Math.abs(sample.refOnset - anchorOnset) <= TIME_EPSILON) {
            return sample.studentOnset;
        }
    }

    let upperIndex = samples.findIndex(sample => sample.refOnset > anchorOnset);
    if (upperIndex === -1) upperIndex = samples.length - 1;

    let lowerIndex = upperIndex - 1;
    if (upperIndex === 0) {
        lowerIndex = 0;
        upperIndex = 1;
    } else if (upperIndex === samples.length - 1 && samples[upperIndex].refOnset <= anchorOnset) {
        lowerIndex = samples.length - 2;
    }

    const lower = samples[lowerIndex];
    const upper = samples[upperIndex];
    const span = upper.refOnset - lower.refOnset;
    if (span <= TIME_EPSILON) return null;

    const t = (anchorOnset - lower.refOnset) / span;
    return lower.studentOnset + t * (upper.studentOnset - lower.studentOnset);
};

const preservesDateMonotonicity = (
    date: number,
    onset: number,
    samplesByDate: ProjectionSample[],
): boolean => {
    let prev: ProjectionSample | null = null;
    let next: ProjectionSample | null = null;

    for (const sample of samplesByDate) {
        if (sample.date < date) prev = sample;
        if (sample.date > date) {
            next = sample;
            break;
        }
    }

    if (prev && onset + TIME_EPSILON < prev.studentOnset) return false;
    if (next && onset - TIME_EPSILON > next.studentOnset) return false;
    return true;
};

export const reprojectSilentOnsets = (
    options: TempoTransformerOptions,
    referenceMsm: MSM,
    studentMsm: MSM,
    log?: (msg: string) => void,
): SilentOnset[] => {
    const anchors = options.silentOnsets ?? [];
    if (anchors.length === 0) return [];

    const samples = buildProjectionSamples(options, referenceMsm, studentMsm);
    if (samples.length < 2) {
        log?.(`TEMPO: dropping ${anchors.length} silentOnsets in [${options.from}, ${options.to}] (not enough implanted notes)`);
        return [];
    }

    const samplesByDate = [...samples].sort((a, b) => a.date - b.date || a.studentOnset - b.studentOnset);
    const projected: SilentOnset[] = [];

    for (const anchor of anchors) {
        const exact = samplesByDate.find(sample => sample.date === anchor.date);
        const onset = exact
            ? exact.studentOnset
            : projectByReferenceOnset(anchor.onset, samples);

        if (onset == null || !Number.isFinite(onset) || onset < 0) continue;
        if (!preservesDateMonotonicity(anchor.date, onset, samplesByDate)) continue;
        projected.push({ date: anchor.date, onset });
    }

    projected.sort((a, b) => a.date - b.date);

    const monotonicProjected: SilentOnset[] = [];
    let lastOnset = -Infinity;
    for (const anchor of projected) {
        if (anchor.onset + TIME_EPSILON < lastOnset) continue;
        monotonicProjected.push(anchor);
        lastOnset = anchor.onset;
    }

    if (monotonicProjected.length !== anchors.length) {
        log?.(
            `TEMPO: reprojected silentOnsets in [${options.from}, ${options.to}] ` +
            `${anchors.length} -> ${monotonicProjected.length}`
        );
    }

    return monotonicProjected;
};

const clampTempoValue = (value: number): number => {
    if (!Number.isFinite(value)) return MIN_TEMPO_BPM;
    return Math.max(MIN_TEMPO_BPM, value);
};

export const sanitizeTempoInstructions = (
    mpm: MPM,
    scope?: Scope,
    log?: (msg: string) => void,
): void => {
    const scopes = scope !== undefined ? [scope] : Array.from(mpm.doc.performance.parts.keys());
    for (const currentScope of scopes) {
        const tempos = mpm.getInstructions<Tempo>('tempo', currentScope);
        for (const tempo of tempos) {
            const oldBpm = tempo.bpm;
            tempo.bpm = clampTempoValue(tempo.bpm);

            const oldTransition = tempo["transition.to"];
            if (typeof oldTransition === 'number') {
                tempo["transition.to"] = clampTempoValue(oldTransition);
                if (Math.abs(tempo["transition.to"] - tempo.bpm) < TEMPO_EPSILON) {
                    delete tempo["transition.to"];
                    delete tempo.meanTempoAt;
                }
            }

            if (typeof tempo["transition.to"] === 'number' && !Number.isFinite(tempo.meanTempoAt ?? 0.5)) {
                tempo.meanTempoAt = 0.5;
            }

            if (tempo.bpm !== oldBpm || tempo["transition.to"] !== oldTransition) {
                const next = typeof tempo["transition.to"] === 'number'
                    ? ` -> ${tempo["transition.to"].toFixed(1)}`
                    : '';
                log?.(
                    `TEMPO: sanitized ${tempo["xml:id"]} at ${tempo.date}: ` +
                    `${oldBpm.toFixed(1)}${oldTransition != null ? ` -> ${oldTransition.toFixed(1)}` : ''} ` +
                    `=> ${tempo.bpm.toFixed(1)}${next}`
                );
            }
        }
    }
};
