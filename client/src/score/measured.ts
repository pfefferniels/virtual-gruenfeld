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
 *
 * Two readers fill the shape, and between them they replace `asMSM.ts`:
 * {@link measuredNotesFromPerformanceData} for a *performed* score (the take's
 * scaffold — the score under Grünfeld's own document, which is where the roll's
 * timings now come from) and {@link measuredNotesFromMsmText} for a score with
 * no performance attached (the harmonic reduction, which only ever needed dates
 * and pitches).
 */
import { Msm, getAllDescendantsByName, type Element } from 'espressivo';

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

export const msToSeconds = (ms: number): number => ms / 1000;

/** Milliseconds from seconds — the matcher's boundary, in the other direction. */
export const secondsToMs = (seconds: number): number => seconds * 1000;

const numberOr = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

const attribute = (element: Element, name: string, fallback: number): number =>
    numberOr(Number(element.getAttributeValue(name)), fallback);

/**
 * One note per (date, pitch): the score as a MIDI keyboard can possibly report it.
 *
 * A piano score notates the same pitch twice at the same moment whenever two voices meet on it
 * — 18 times in Träumerei. MIDI has no way to say that: one key goes down and one note-on
 * arrives, so the matcher would be looking for a note the student *cannot* have played, would
 * count it a deletion, and would drag the alignment around it. `asMSM` deduplicated for
 * exactly this reason ("keep the longest"), and the rule outlives it: the longest note is the
 * one that sounds the pitch for as long as the ear hears it.
 *
 * Ties keep the earlier note, so the result is a deterministic function of the input order.
 */
export const withoutUnisons = (notes: readonly MeasuredNote[]): MeasuredNote[] => {
    const kept = new Map<string, MeasuredNote>();
    for (const note of notes) {
        const key = `${note.date}:${note['midi.pitch']}`;
        const existing = kept.get(key);
        if (!existing || note.duration > existing.duration) kept.set(key, note);
    }
    return [...kept.values()];
};

/**
 * An MSM document's notes, read straight off the XML — the score as written, with no
 * performance attached and therefore no sounding times.
 *
 * This is what `asMSMBasic` did: `<note>` elements out of `convert(mei)`, with `xml:id`,
 * `@date`, `@duration` and `@midi.pitch`, and the part number off the enclosing `<part>`.
 * `milliseconds.date`, `milliseconds.date.end` and `velocity` are `0` because the document
 * states none; the one consumer — the mood chord's harmonic reduction — asks only for dates
 * and pitches.
 *
 * It reads the document as it stands: **`(date, pitch)` is not made unique here.** The one
 * consumer needs it to be — `pickReductionChord` groups by date, and a unison would change the
 * chord's `noteCount`, its `arpeggioSpanMs` and every `note.order` under it — so `boot.ts`
 * folds the reduction through {@link withoutUnisons}, which is where that rule lives for the
 * score too. The reduction has no such pair today (216 notes, 0 duplicates); the fold is what
 * keeps the mood chord indifferent to whether it ever gains one.
 *
 * espressivo's own parser rather than `DOMParser`, so this module also loads in a Web Worker
 * and under vitest.
 */
export const measuredNotesFromMsmText = (msmXml: string): MeasuredNote[] => {
    const root = new Msm(msmXml).getRootElement();
    if (!root) return [];

    const notes: MeasuredNote[] = [];
    for (const part of getAllDescendantsByName('part', root) ?? []) {
        const number = attribute(part, 'number', 0);
        for (const note of getAllDescendantsByName('note', part) ?? []) {
            notes.push({
                'xml:id': note.getAttributeValue('id', XML_NS) ?? '',
                part: number,
                date: attribute(note, 'date', 0),
                duration: attribute(note, 'duration', 0),
                'midi.pitch': attribute(note, 'midi.pitch', 0),
                'milliseconds.date': 0,
                'milliseconds.date.end': 0,
                velocity: 0,
            });
        }
    }
    return notes;
};

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
