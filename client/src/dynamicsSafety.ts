import { Scope } from "mpm-ts";
import { MSM, MsmNote } from "mpmify";

export type DynamicsTransformerOptions = {
    from: number;
    to: number;
    scope?: Scope;
    phantomVelocities?: Map<number, number>;
};

type VelocitySample = {
    date: number;
    velocity: number;
};

const MIN_VELOCITY = 1;
const MAX_VELOCITY = 127;

const clampVelocity = (value: number): number =>
    Math.max(MIN_VELOCITY, Math.min(MAX_VELOCITY, value));

const averageVelocity = (notes: MsmNote[], implantedOnly: boolean): number | null => {
    const notesWithVelocity = notes.filter(note => {
        if (implantedOnly && note.source !== 'implanted') return false;
        return typeof note["midi.velocity"] === 'number' && Number.isFinite(note["midi.velocity"]);
    });

    if (notesWithVelocity.length === 0) return null;

    const sum = notesWithVelocity.reduce((acc, note) => acc + note["midi.velocity"], 0);
    return sum / notesWithVelocity.length;
};

const buildVelocitySamples = (
    msm: MSM,
    options: Pick<DynamicsTransformerOptions, 'from' | 'to' | 'scope'>,
    implantedOnly: boolean,
): VelocitySample[] => {
    const samples: VelocitySample[] = [];

    for (const [date, notes] of msm.asChords(options.scope)) {
        if (date < options.from || date > options.to) continue;

        const velocity = averageVelocity(notes, implantedOnly);
        if (velocity == null) continue;

        samples.push({ date, velocity });
    }

    return samples.sort((a, b) => a.date - b.date);
};

const velocityAtDate = (date: number, samples: VelocitySample[]): number | null => {
    if (samples.length === 0) return null;

    const exact = samples.find(sample => sample.date === date);
    if (exact) return exact.velocity;

    const upperIndex = samples.findIndex(sample => sample.date > date);
    if (upperIndex <= 0) return null;

    const lower = samples[upperIndex - 1];
    const upper = samples[upperIndex];
    if (!upper) return null;

    const span = upper.date - lower.date;
    if (span <= 0) return null;

    const t = (date - lower.date) / span;
    return lower.velocity + t * (upper.velocity - lower.velocity);
};

export const reprojectPhantomVelocities = (
    options: DynamicsTransformerOptions,
    referenceMsm: MSM,
    studentMsm: MSM,
    log?: (msg: string) => void,
): Map<number, number> => {
    const anchors = options.phantomVelocities ?? new Map<number, number>();
    if (anchors.size === 0) return new Map();

    const referenceSamples = buildVelocitySamples(referenceMsm, options, false);
    const studentSamples = buildVelocitySamples(studentMsm, options, true);

    const projected = new Map<number, number>();
    let invalid = 0;
    let missingReferenceSupport = 0;
    let missingStudentSupport = 0;

    for (const [date, phantomVelocity] of Array.from(anchors.entries()).sort((a, b) => a[0] - b[0])) {
        if (!Number.isFinite(phantomVelocity)) {
            invalid += 1;
            continue;
        }

        const referenceBaseline = velocityAtDate(date, referenceSamples);
        if (referenceBaseline == null) {
            missingReferenceSupport += 1;
            continue;
        }

        const studentBaseline = velocityAtDate(date, studentSamples);
        if (studentBaseline == null) {
            missingStudentSupport += 1;
            continue;
        }

        const delta = phantomVelocity - referenceBaseline;
        projected.set(date, clampVelocity(studentBaseline + delta));
    }

    if (projected.size !== anchors.size) {
        log?.(
            `DYNAMICS: adapted phantomVelocities in [${options.from}, ${options.to}] ` +
            `${anchors.size} -> ${projected.size}` +
            ` (invalid=${invalid}, ref=${missingReferenceSupport}, student=${missingStudentSupport})`
        );
    }

    return projected;
};
