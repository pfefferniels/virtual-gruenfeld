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

/**
 * The other direction across the same boundary: espressivo's own `PerformanceData` — what
 * `performMsm` / `performMsmToData` hand back — read as measured notes.
 *
 * Its note record is *nested* (`{ id, pitch, date, duration, velocity, milliseconds: { date,
 * end } }`) where {@link MeasuredNote} is flat in MSM's attribute names, and its parts are
 * indexed from 0 where MSM numbers them from 1; this is the one place either difference is
 * spelled out. Everything is already in milliseconds, so nothing is scaled.
 *
 * It is what makes a rendered performance usable as a take: the round-trip test plays
 * Grünfeld's own document back at the fitter, and a synthetic student is a render with one
 * dimension altered.
 */
export const measuredNotesFromPerformanceData = (
    data: {
        parts?: readonly {
            index?: number;
            notes?: readonly {
                id?: string | null;
                date?: number;
                duration?: number;
                pitch?: number;
                velocity?: number;
                milliseconds?: { date?: number; end?: number };
            }[];
        }[];
    } | null | undefined,
): MeasuredNote[] =>
    (data?.parts ?? []).flatMap((part, position) =>
        (part.notes ?? []).map((note) => ({
            'xml:id': typeof note.id === 'string' ? note.id : '',
            part: numberOr(part.index, position) + 1,
            date: numberOr(note.date, 0),
            duration: numberOr(note.duration, 0),
            'midi.pitch': numberOr(note.pitch, 0),
            'milliseconds.date': numberOr(note.milliseconds?.date, 0),
            'milliseconds.date.end': numberOr(note.milliseconds?.end, 0),
            velocity: numberOr(note.velocity, 0),
        })),
    );
