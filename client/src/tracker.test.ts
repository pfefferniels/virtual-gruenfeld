/**
 * The tracker against the real score and the real reconstruction. The "student" is Grünfeld's own
 * playing, cut and rearranged — which makes these tests about the tracking policy alone, with the
 * matching itself known to be exact.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performMsmToData } from 'espressivo';
import { describe, expect, it } from 'vitest';
import type { StudentNote } from './matcher';
import { measuredNotesFromPerformanceData, withoutUnisons, type MeasuredNote } from './score/measured';
import { createTracker, TRAEUMEREI, type SectionSpan, type TrackerOptions } from './tracker';

const load = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const scoreNotes = withoutUnisons(measuredNotesFromPerformanceData(performMsmToData(
    { msm: load('../public/score.msm'), mpm: load('../public/performance.mpm') },
    { expandOrnaments: false },
)));

const A2: SectionSpan = TRAEUMEREI[1];
const BA: SectionSpan = TRAEUMEREI[2];

/** In time order: the score's own list runs part by part, which is not how anyone plays it. */
const inTicks = (from: number, to: number): MeasuredNote[] =>
    scoreNotes
        .filter((note) => note.date >= from && note.date < to)
        .sort((a, b) => a['milliseconds.date'] - b['milliseconds.date']);

/** Score notes replayed as if a student had played them, on a clock starting at `offsetSec`. */
const asPlayed = (notes: readonly MeasuredNote[], offsetSec = 0): StudentNote[] => {
    const zero = notes.length ? notes[0]['milliseconds.date'] : 0;
    return notes.map((note, index) => ({
        id: `s${index}`,
        pitch: note['midi.pitch'],
        onset: offsetSec + (note['milliseconds.date'] - zero) / 1000,
        duration: Math.max(0.05, (note['milliseconds.date.end'] - note['milliseconds.date']) / 1000),
        velocity: note.velocity,
    }));
};

/** Feed the take a note at a time, as the live loop does, and keep the last position. */
const playThrough = (played: readonly StudentNote[], every = 4, options: Partial<TrackerOptions> = {}) => {
    const tracker = createTracker(scoreNotes, options);
    const readings = [];
    for (let heard = every; heard <= played.length; heard += every) {
        readings.push(tracker.advance(played.slice(0, heard)));
    }
    return { tracker, readings, last: readings[readings.length - 1] };
};

describe('finding the student', () => {
    it('says nothing before it has heard anything', () => {
        expect(createTracker(scoreNotes).advance([])).toBeNull();
    });

    it('finds someone who starts at the beginning, within a few notes', () => {
        const { readings } = playThrough(asPlayed(inTicks(0, 12000)));
        const found = readings.findIndex((r) => r !== null);
        expect(found).toBeGreaterThanOrEqual(0);
        expect(readings[found]!.section).toBe('A1');
    });

    it('follows forward: the position only grows', () => {
        const { readings } = playThrough(asPlayed(inTicks(0, 23000)));
        const ticks = readings.filter((r) => r !== null).map((r) => r!.tick);
        expect(ticks.length).toBeGreaterThan(3);
        expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
    });
});

describe('the written-out repeat', () => {
    it('follows from A1 into A2 rather than sticking on the first pass', () => {
        // Playing straight through the repeat: the dates differ, so a tight window resolves them.
        const { last } = playThrough(asPlayed(inTicks(0, A2.from + 8000)));
        expect(last).not.toBeNull();
        expect(last!.section).toBe('A2');
        expect(last!.tick).toBeGreaterThanOrEqual(A2.from);
    });

    it('cannot tell which pass a cold start is in, and guesses the first', () => {
        // A known limit, not a defect: the two passes are pitch-identical, and with no prior
        // there is nothing to prefer. Continuity is what resolves it, and continuity needs a past.
        const { last } = playThrough(asPlayed(inTicks(A2.from, A2.from + 8000)));
        expect(last).not.toBeNull();
        expect(last!.section).toBe('A1');
    });
});

describe('the repeat the score does not write out', () => {
    it('counts a second pass through B A′, which shares one set of dates', () => {
        const firstPass = asPlayed(inTicks(BA.from, BA.from + 14000));
        const secondPass = asPlayed(inTicks(BA.from, BA.from + 14000), 30);
        const { last } = playThrough([...firstPass, ...secondPass]);

        expect(last).not.toBeNull();
        expect(last!.section).toBe('BA');
        expect(last!.pass).toBe(2);
    });

    it('stays on the first pass while it is still the first pass', () => {
        const { last } = playThrough(asPlayed(inTicks(BA.from, BA.from + 14000)));
        expect(last!.pass).toBe(1);
    });
});

describe('losing the student and finding them again', () => {
    it('recovers when they break off and restart somewhere else', () => {
        const before = asPlayed(inTicks(0, 9000));
        const elsewhere = asPlayed(inTicks(BA.from, BA.from + 12000), 20);
        const { readings, last } = playThrough([...before, ...elsewhere]);

        expect(readings.some((r) => r !== null && r.section === 'A1')).toBe(true);
        expect(last).not.toBeNull();
        expect(last!.section).toBe('BA');
    });

    it('does not lose them over one bad window', () => {
        const played = asPlayed(inTicks(0, 16000));
        const tracker = createTracker(scoreNotes);
        tracker.advance(played.slice(0, 16));

        // Four notes that are nowhere in the score: a hesitation, not a departure.
        const noise: StudentNote[] = [13, 15, 17, 19].map((pitch, i) => ({
            id: `n${i}`, pitch, onset: 90 + i * 0.2, duration: 0.2, velocity: 50,
        }));
        const during = tracker.advance([...played.slice(0, 16), ...noise]);
        expect(during).not.toBeNull();

        const after = tracker.advance(played.slice(0, 28));
        expect(after).not.toBeNull();
        expect(after!.section).toBe('A1');
    });

    it('forgets where it was when asked to', () => {
        const played = asPlayed(inTicks(0, 12000));
        const tracker = createTracker(scoreNotes);
        expect(tracker.advance(played)).not.toBeNull();
        tracker.reset();
        expect(tracker.advance([])).toBeNull();
    });
});
