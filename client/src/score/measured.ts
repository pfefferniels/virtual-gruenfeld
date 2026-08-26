/**
 * The measurement boundary.
 *
 * One note shape crosses every part of a take: what the score prescribes
 * (`xml:id`, part, date, duration, pitch) and what was actually measured — the
 * sounding onset and end, and the velocity it was struck with.
 *
 * The unit is **milliseconds**, and the attribute names are espressivo's own
 * (`milliseconds.date` / `milliseconds.date.end` / `velocity` on an MSM note),
 * so a fitted student performance can be handed to `performMsm` /
 * `extractPerformanceData` without a second conversion and without a private
 * vocabulary in between. The matcher keeps seconds internally — MIDI is a
 * seconds domain — and projects here at its boundary; the cue timing map keeps
 * seconds too, because it schedules audio.
 *
 * `source` is the marker `implantLocal` writes on the notes the student really
 * played, as opposed to reference notes merely shifted around the take.
 */

export type MeasuredNote = {
    'xml:id': string;
    /** MSM part index. */
    part: number;
    /** Symbolic score onset, ticks @ 720 ppq. */
    date: number;
    /** Symbolic score duration, ticks. */
    duration: number;
    'midi.pitch': number;
    /** Measured onset, milliseconds. */
    'milliseconds.date': number;
    /** Measured end, milliseconds. */
    'milliseconds.date.end': number;
    /** Measured velocity, 0–127. */
    velocity: number;
    /** `'implanted'` on a note the student actually played. */
    source?: string;
};

/** The marker distinguishing a played note from a merely shifted reference note. */
export const IMPLANTED = 'implanted';

export const isImplanted = (note: MeasuredNote): boolean => note.source === IMPLANTED;

const secondsToMs = (seconds: number): number => seconds * 1000;

export const msToSeconds = (ms: number): number => ms / 1000;

/**
 * The legacy MSM note shape: the same note, timed in **seconds**, as `mpmify`'s
 * `MSM` carries it. This bridge is the single place the old unit is converted;
 * it goes when the MSM path does.
 */
type MsmNoteLike = {
    'xml:id'?: string;
    part?: number;
    date?: number;
    duration?: number;
    'midi.pitch'?: number;
    'midi.onset'?: number;
    'midi.duration'?: number;
    'midi.velocity'?: number;
    source?: string;
};

const numberOr = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const measuredNoteFromMsmNote = (note: MsmNoteLike): MeasuredNote => {
    const onsetMs = secondsToMs(numberOr(note['midi.onset'], 0));
    const measured: MeasuredNote = {
        'xml:id': typeof note['xml:id'] === 'string' ? note['xml:id'] : '',
        part: numberOr(note.part, 0),
        date: numberOr(note.date, 0),
        duration: numberOr(note.duration, 0),
        'midi.pitch': numberOr(note['midi.pitch'], 0),
        'milliseconds.date': onsetMs,
        'milliseconds.date.end': onsetMs + secondsToMs(numberOr(note['midi.duration'], 0)),
        velocity: numberOr(note['midi.velocity'], 0),
    };
    if (note.source != null) measured.source = note.source;
    return measured;
};

/** Project an `MSM`-shaped document (seconds) onto measured notes (milliseconds). */
export const measuredNotesFromMsm = (
    msm: { allNotes?: readonly MsmNoteLike[] } | null | undefined,
): MeasuredNote[] => (msm?.allNotes ?? []).map(measuredNoteFromMsmNote);
