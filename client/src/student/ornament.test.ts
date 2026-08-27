/**
 * The rolled chord.
 *
 * The first three cases are mpm-desk's own `InsertTemporalSpread.test.ts`, brought over with
 * the code they test (risk R11): the same two-note fixture struck a second apart, the same
 * expected frame, the same threshold behaviour. What changed is only where the answer goes —
 * mpm-desk writes the collapsed onset back onto the notes and parks the frame on the element;
 * here both are *reported* and the caller applies them.
 */
import { describe, expect, it } from 'vitest';
import type { MeasuredNote } from '../score/measured';
import {
    DEFAULT_ROLL_THRESHOLD_MS,
    detectArpeggio,
    determineIntensity,
    gradientScale,
    type GradientRange,
} from './ornament';

/**
 * Quickly generates a simple measured note.
 * @note Example for duration and position: 0.25 = quarter note etc.
 */
const note = (
    position: number,
    duration: number,
    pitch: number,
    measured: { onset: number; end: number; velocity?: number },
    part = 1,
): MeasuredNote => ({
    'xml:id': `n_${part}_${pitch}`,
    part,
    date: position * 4 * 720,
    duration: duration * 4 * 720,
    'midi.pitch': pitch,
    'milliseconds.date': measured.onset,
    'milliseconds.date.end': measured.end,
    velocity: measured.velocity ?? 50,
});

/** Two notes of one chord, struck a second apart — a rolled chord, seen from the recording. */
const rolledChord = (): MeasuredNote[] => [
    note(0, 0.25, 60, { onset: 500, end: 1500 }),
    note(0, 0.25, 67, { onset: 1500, end: 2500 }),
];

describe('detectArpeggio', () => {
    it('describes the roll in milliseconds around the estimated onset', () => {
        const arpeggio = detectArpeggio(0, rolledChord());

        expect(arpeggio).not.toBeNull();
        expect(arpeggio?.noteOrder).toEqual('ascending pitch');
        expect(arpeggio?.frameStartMs).toEqual(-500);
        expect(arpeggio?.frameLengthMs).toEqual(1000);
    });

    it('collapses the rolled chord onto one onset, so a tempo can be read off it', () => {
        const arpeggio = detectArpeggio(0, rolledChord());

        // The roll is explained, then removed, and only then is the onset clean enough to
        // measure a tempo from (semantics 1).
        expect(arpeggio?.onsetMs).toEqual(1000);
        expect([...(arpeggio?.shiftMs.entries() ?? [])]).toEqual([
            ['n_1_60', 500],
            ['n_1_67', -500],
        ]);
    });

    it('leaves a roll shorter than the threshold alone', () => {
        // the same chord, the second note struck 10 ms after the first rather than a second
        const chord = rolledChord();
        chord[1]['milliseconds.date'] = 510;
        chord[1]['milliseconds.date.end'] = 1510;

        expect(detectArpeggio(0, chord)).toBeNull();
        expect(DEFAULT_ROLL_THRESHOLD_MS).toBe(35);
    });

    it('cannot arpeggiate fewer than two notes', () => {
        expect(detectArpeggio(0, rolledChord().slice(0, 1))).toBeNull();
        expect(detectArpeggio(0, [])).toBeNull();
    });

    it('names the notes when the roll follows neither pitch direction', () => {
        const chord = [
            note(0, 0.25, 60, { onset: 500, end: 1500 }),
            note(0, 0.25, 72, { onset: 900, end: 1900 }),
            note(0, 0.25, 67, { onset: 1500, end: 2500 }),
        ];
        expect(detectArpeggio(0, chord)?.noteOrder).toEqual('#n_1_60 #n_1_72 #n_1_67');
    });

    it('reads a descending roll as one', () => {
        const chord = [
            note(0, 0.25, 72, { onset: 500, end: 1500 }),
            note(0, 0.25, 60, { onset: 1500, end: 2500 }),
        ];
        expect(detectArpeggio(0, chord)?.noteOrder).toEqual('descending pitch');
    });

    it('marks the releases as shifted when they travel with the onsets', () => {
        // Releases 1000 ms apart — more than 0.8 of the 1000 ms span — and in the same order,
        // but held past the next onset, so this is a spread chord and not a monophonic line.
        const chord = [
            note(0, 0.25, 60, { onset: 500, end: 2000 }),
            note(0, 0.25, 67, { onset: 1500, end: 3000 }),
        ];
        expect(detectArpeggio(0, chord)?.noteOffShift).toEqual('true');
    });

    it('reads a chord whose releases stay put as unshifted', () => {
        const chord = [
            note(0, 0.25, 60, { onset: 500, end: 3000 }),
            note(0, 0.25, 67, { onset: 1500, end: 3050 }),
        ];
        expect(detectArpeggio(0, chord)?.noteOffShift).toEqual('false');
    });

    it('takes a line where each note gives way to the next as monophonic', () => {
        // the fixture the other cases use: the first release meets the second onset, within
        // the 20 ms that counts as one note handing over to the next
        expect(detectArpeggio(0, rolledChord())?.noteOffShift).toEqual('monophonic');
        const nearly = [
            note(0, 0.25, 60, { onset: 500, end: 1490 }),
            note(0, 0.25, 67, { onset: 1500, end: 2500 }),
        ];
        expect(detectArpeggio(0, nearly)?.noteOffShift).toEqual('monophonic');
    });

    it('does not touch the notes it was handed', () => {
        const chord = rolledChord();
        const before = JSON.stringify(chord);
        detectArpeggio(0, chord);
        expect(JSON.stringify(chord)).toEqual(before);
    });
});

describe('determineIntensity', () => {
    it('recovers the exponent of the spacing it is shown', () => {
        for (const exponent of [0.5, 1, 2]) {
            const n = 5;
            const onsets = [...Array(n)].map((_, i) => Math.pow(i / (n - 1), exponent));
            expect(determineIntensity(onsets)).toBeCloseTo(exponent, 5);
        }
    });

    it('answers the identity where there is nothing to describe', () => {
        // "intensity only makes sense for more than 2 notes"
        expect(determineIntensity([0, 1])).toBe(1);
        expect(determineIntensity([0])).toBe(1);
        expect(determineIntensity([])).toBe(1);
    });
});

describe('gradientScale', () => {
    const shaded = (first: number, last: number): MeasuredNote[] => [
        note(0, 0.25, 60, { onset: 500, end: 1500, velocity: first }),
        note(0, 0.25, 67, { onset: 1500, end: 2500, velocity: last }),
    ];

    it('is the velocity ramp measured against the shape it is drawn on', () => {
        // 7 velocity units across a `1 → 0` ramp
        const shape: GradientRange = { from: 1, to: 0 };
        expect(gradientScale(shaded(50, 43), shape)).toBeCloseTo(7, 10);
    });

    it('states the same ramp as a different number on a different shape', () => {
        // The split between shape and scale is a convention, which is exactly why the shape is
        // copied from the reference rather than fitted: these two are one velocity ramp.
        expect(gradientScale(shaded(50, 43), { from: 1, to: -1 })).toBeCloseTo(3.5, 10);
    });

    it('refuses where there is no ramp to state', () => {
        expect(gradientScale(shaded(50, 50), { from: 1, to: 0 })).toBeNull();
        expect(gradientScale(shaded(50, 43), { from: 0, to: 0 })).toBeNull();
        expect(gradientScale(shaded(50, 43), null)).toBeNull();
        expect(gradientScale(shaded(50, 43).slice(0, 1), { from: 1, to: 0 })).toBeNull();
    });

    it('reads the chord in the order it was struck, not the order it was handed', () => {
        const reversed = [...shaded(50, 43)].reverse();
        expect(gradientScale(reversed, { from: 1, to: 0 })).toBeCloseTo(7, 10);
    });
});
