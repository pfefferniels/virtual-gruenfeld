/**
 * The two readers that replaced `asMSM.ts`, against the real score.
 *
 * `asMSM` did three things: it converted the MEI, it enriched the notes with the roll's
 * `<when>` timings, and it folded simultaneous unisons. The first is
 * `services/mpmRenderer.convert`, the second is a render of `performance.mpm` over the score
 * (`pipeline/boot.ts`), and the third is {@link withoutUnisons} — kept, because MIDI cannot
 * carry what it folds.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { convert } from '../services/mpmRenderer';
import { measuredNotesFromMsmText, withoutUnisons, type MeasuredNote } from './measured';

const load = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const scoreMsm = convert(load('../../public/score.mei'));
const reductionMsm = convert(load('../../public/harmonic_reduction.mei'));

const note = (over: Partial<MeasuredNote>): MeasuredNote => ({
    'xml:id': 'n', part: 1, date: 0, duration: 720, 'midi.pitch': 60,
    'milliseconds.date': 0, 'milliseconds.date.end': 0, velocity: 0, ...over,
});

describe('measuredNotesFromMsmText', () => {
    it('reads every note of the score, with its id, part, date and pitch', () => {
        const notes = measuredNotesFromMsmText(scoreMsm);

        expect(notes.length).toBe(476);
        expect(new Set(notes.map((n) => n['xml:id'])).size).toBe(notes.length);
        expect(notes.every((n) => n['xml:id'] !== '')).toBe(true);
        expect(new Set(notes.map((n) => n.part))).toEqual(new Set([1, 2]));

        const first = notes.reduce((earliest, n) => (n.date < earliest.date ? n : earliest));
        expect(first.date).toBe(0);
        expect(first['midi.pitch']).toBe(60);
        expect(first.duration).toBe(720);
    });

    it('states no sounding time, because the document states none', () => {
        // A score MSM is not a performance. The mood chord, its only consumer, asks for dates
        // and pitches; anything that needs milliseconds renders first.
        const notes = measuredNotesFromMsmText(reductionMsm);
        expect(notes.length).toBe(216);
        expect(notes.every((n) => n['milliseconds.date'] === 0)).toBe(true);
        expect(notes.every((n) => n['milliseconds.date.end'] === 0)).toBe(true);
        expect(notes.every((n) => n.velocity === 0)).toBe(true);
    });

    it('is empty rather than broken for a document with no notes in it', () => {
        expect(measuredNotesFromMsmText('<msm/>')).toEqual([]);
    });
});

describe('withoutUnisons', () => {
    it('folds the score’s simultaneous unisons and keeps the longer note', () => {
        const notes = measuredNotesFromMsmText(scoreMsm);
        const folded = withoutUnisons(notes);

        expect(folded.length).toBe(458);
        const keys = folded.map((n) => `${n.date}:${n['midi.pitch']}`);
        expect(new Set(keys).size).toBe(folded.length);
    });

    it('keeps the longest of a pair, and the earlier one on a tie', () => {
        const short = note({ 'xml:id': 'short', duration: 360 });
        const long = note({ 'xml:id': 'long', duration: 1440 });
        expect(withoutUnisons([short, long]).map((n) => n['xml:id'])).toEqual(['long']);
        expect(withoutUnisons([long, short]).map((n) => n['xml:id'])).toEqual(['long']);

        const tieA = note({ 'xml:id': 'a' });
        const tieB = note({ 'xml:id': 'b' });
        expect(withoutUnisons([tieA, tieB]).map((n) => n['xml:id'])).toEqual(['a']);
    });

    it('leaves a chord of different pitches, and one pitch at different dates, alone', () => {
        const chord = [
            note({ 'xml:id': 'a', 'midi.pitch': 60 }),
            note({ 'xml:id': 'b', 'midi.pitch': 64 }),
            note({ 'xml:id': 'c', 'midi.pitch': 60, date: 720 }),
        ];
        expect(withoutUnisons(chord).map((n) => n['xml:id'])).toEqual(['a', 'b', 'c']);
    });
});
