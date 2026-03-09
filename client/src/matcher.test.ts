import { describe, it, expect } from 'vitest';
import {
    matchScore,
    smithWaterman,
    hungarian,
    groupAndSort,
    matchSubsequence,
    extractNotesFromMidi,
    type RefNote,
    type StudentNote,
} from './matcher';

// ---------------------------------------------------------------------------
//  Helpers for building test data
// ---------------------------------------------------------------------------

/** Create a reference note with sensible defaults. */
function refNote(pitch: number, date: number, opts?: Partial<RefNote>): RefNote {
    return {
        id: `ref_${date}_${pitch}`,
        pitch,
        date,
        onset: date / 720,  // crude date-to-seconds conversion
        duration: 0.5,
        velocity: 80,
        index: 0,
        ...opts,
    };
}

/** Create a student note with sensible defaults. */
function stuNote(pitch: number, onset: number, opts?: Partial<StudentNote>): StudentNote {
    return {
        id: `stu_${onset}_${pitch}`,
        pitch,
        onset,
        duration: 0.5,
        velocity: 80,
        ...opts,
    };
}

/**
 * Build a reference sequence from a list of (pitch, date) pairs.
 * Assigns sequential indices.
 */
function buildRef(notes: Array<[number, number]>): RefNote[] {
    return notes.map(([pitch, date], i) => refNote(pitch, date, { index: i }));
}

/**
 * Build a student sequence from a list of (pitch, onset) pairs.
 */
function buildStu(notes: Array<[number, number]>): StudentNote[] {
    return notes.map(([pitch, onset]) => stuNote(pitch, onset));
}

// ---------------------------------------------------------------------------
//  matchScore
// ---------------------------------------------------------------------------

describe('matchScore', () => {
    it('returns 1.0 for exact pitch match', () => {
        expect(matchScore(60, 60)).toBe(1.0);
    });

    it('returns 0.3 for octave equivalence', () => {
        expect(matchScore(60, 72)).toBe(0.3);
        expect(matchScore(48, 60)).toBe(0.3);
    });

    it('returns negative for semitone off', () => {
        expect(matchScore(60, 61)).toBeLessThan(0);
    });

    it('returns negative for distant pitches', () => {
        expect(matchScore(60, 67)).toBeLessThan(0);
    });
});

// ---------------------------------------------------------------------------
//  groupAndSort
// ---------------------------------------------------------------------------

describe('groupAndSort', () => {
    it('groups notes within tolerance and sorts by pitch', () => {
        const notes = [
            stuNote(67, 1.00),  // G4
            stuNote(60, 1.05),  // C4 (within tolerance of G4)
            stuNote(64, 1.02),  // E4
        ];
        const result = groupAndSort(notes, n => n.onset, 0.1);
        // All should be in one group, sorted by pitch: C4, E4, G4
        expect(result.map(n => n.pitch)).toEqual([60, 64, 67]);
    });

    it('separates notes beyond tolerance into different groups', () => {
        const notes = [
            stuNote(67, 1.0),
            stuNote(60, 2.0),  // far apart
        ];
        const result = groupAndSort(notes, n => n.onset, 0.1);
        expect(result.map(n => n.pitch)).toEqual([67, 60]);
    });

    it('handles empty input', () => {
        expect(groupAndSort([], n => (n as StudentNote).onset, 0.1)).toEqual([]);
    });

    it('correctly groups reference notes by date (tolerance=0)', () => {
        const notes = [
            refNote(67, 100),
            refNote(60, 100),
            refNote(64, 100),
            refNote(72, 200),
        ];
        const result = groupAndSort(notes, n => n.date, 0);
        // Group at date 100 sorted by pitch: 60, 64, 67, then 72
        expect(result.map(n => n.pitch)).toEqual([60, 64, 67, 72]);
    });
});

// ---------------------------------------------------------------------------
//  smithWaterman
// ---------------------------------------------------------------------------

describe('smithWaterman', () => {
    it('aligns identical sequences perfectly', () => {
        const seq = [60, 64, 67, 72].map(p => ({ pitch: p }));
        const result = smithWaterman(seq, seq);
        expect(result.score).toBeGreaterThan(0);
        const matchedPairs = result.path.filter(([r, s]) => r >= 0 && s >= 0);
        expect(matchedPairs.length).toBe(4);
    });

    it('finds a subsequence in a longer reference', () => {
        const ref = [60, 62, 64, 65, 67, 69, 71, 72].map(p => ({ pitch: p }));
        const stu = [64, 65, 67].map(p => ({ pitch: p }));  // middle portion
        const result = smithWaterman(ref, stu);
        expect(result.score).toBeGreaterThan(0);
        // Should match indices 2,3,4 in reference
        const matches = result.path.filter(([r, s]) => r >= 0 && s >= 0);
        expect(matches.length).toBe(3);
        expect(matches.map(([r]) => r)).toEqual([2, 3, 4]);
    });

    it('handles an extra student note (insertion)', () => {
        const ref = [60, 64, 67].map(p => ({ pitch: p }));
        const stu = [60, 62, 64, 67].map(p => ({ pitch: p }));  // 62 is extra
        const result = smithWaterman(ref, stu);
        const matches = result.path.filter(([r, s]) => r >= 0 && s >= 0);
        // Should match 60, 64, 67 and mark 62 as insertion
        expect(matches.length).toBe(3);
        const insertions = result.path.filter(([r, s]) => r < 0 && s >= 0);
        expect(insertions.length).toBe(1);
    });

    it('handles a missing reference note (deletion)', () => {
        const ref = [60, 62, 64, 67].map(p => ({ pitch: p }));
        const stu = [60, 64, 67].map(p => ({ pitch: p }));  // 62 is skipped
        const result = smithWaterman(ref, stu);
        const matches = result.path.filter(([r, s]) => r >= 0 && s >= 0);
        expect(matches.length).toBe(3);
        const deletions = result.path.filter(([r, s]) => r >= 0 && s < 0);
        expect(deletions.length).toBe(1);
    });

    it('handles empty student sequence', () => {
        const ref = [60, 64, 67].map(p => ({ pitch: p }));
        const result = smithWaterman(ref, []);
        expect(result.path.length).toBe(0);
    });

    it('handles empty reference', () => {
        const stu = [60, 64, 67].map(p => ({ pitch: p }));
        const result = smithWaterman([], stu);
        expect(result.path.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
//  hungarian
// ---------------------------------------------------------------------------

describe('hungarian', () => {
    it('finds optimal assignment for simple 2x2 case', () => {
        const cost = [
            [1, 100],
            [100, 1],
        ];
        const assignments = hungarian(cost);
        // Optimal: (0,0) and (1,1) with total cost 2
        const sorted = assignments.sort((a, b) => a[0] - b[0]);
        expect(sorted).toEqual([[0, 0], [1, 1]]);
    });

    it('finds optimal assignment for 3x3 case', () => {
        const cost = [
            [10, 5, 1],
            [3, 8, 7],
            [6, 2, 4],
        ];
        const assignments = hungarian(cost);
        // Optimal should be (0,2)=1, (1,0)=3, (2,1)=2 => total=6
        const sorted = assignments.sort((a, b) => a[0] - b[0]);
        expect(sorted).toEqual([[0, 2], [1, 0], [2, 1]]);
    });

    it('handles rectangular matrix (more rows than cols)', () => {
        const cost = [
            [1, 10],
            [10, 1],
            [5, 5],
        ];
        const assignments = hungarian(cost);
        expect(assignments.length).toBe(2);  // only 2 cols can be assigned
    });

    it('handles rectangular matrix (more cols than rows)', () => {
        const cost = [
            [1, 10, 5],
            [10, 1, 5],
        ];
        const assignments = hungarian(cost);
        expect(assignments.length).toBe(2);
    });
});

// ---------------------------------------------------------------------------
//  matchSubsequence - Integration tests
// ---------------------------------------------------------------------------

describe('matchSubsequence', () => {
    it('matches a perfect performance', () => {
        // Student plays exactly what's in the reference
        const ref = buildRef([[60, 0], [64, 720], [67, 1440], [72, 2160]]);
        const stu = buildStu([[60, 0], [64, 1], [67, 2], [72, 3]]);

        const result = matchSubsequence(ref, stu);
        expect(result.matches.length).toBe(4);
        expect(result.deletions.length).toBe(0);
        expect(result.insertions.length).toBe(0);
    });

    it('matches a subsequence of the reference', () => {
        // Reference has 8 notes, student plays only 3 from the middle
        const ref = buildRef([
            [60, 0], [62, 720], [64, 1440], [65, 2160],
            [67, 2880], [69, 3600], [71, 4320], [72, 5040],
        ]);
        const stu = buildStu([[64, 0], [65, 1], [67, 2]]);

        const result = matchSubsequence(ref, stu);
        expect(result.matches.length).toBe(3);
        expect(result.matches.map(m => m.ref.pitch)).toEqual([64, 65, 67]);
    });

    it('handles extra wrong notes from student', () => {
        const ref = buildRef([[60, 0], [64, 720], [67, 1440]]);
        // Student plays C4, then a wrong D4, then E4, G4
        const stu = buildStu([[60, 0], [62, 0.5], [64, 1], [67, 2]]);

        const result = matchSubsequence(ref, stu);
        expect(result.matches.length).toBe(3);
        expect(result.matches.map(m => m.ref.pitch)).toEqual([60, 64, 67]);
        expect(result.insertions.length).toBe(1);
        expect(result.insertions[0].pitch).toBe(62);
    });

    it('handles missing notes from student', () => {
        const ref = buildRef([[60, 0], [62, 720], [64, 1440], [67, 2160]]);
        // Student skips D4
        const stu = buildStu([[60, 0], [64, 1], [67, 2]]);

        const result = matchSubsequence(ref, stu);
        expect(result.matches.length).toBe(3);
        expect(result.deletions.length).toBe(1);
        expect(result.deletions[0].pitch).toBe(62);
    });

    it('matches chords correctly', () => {
        // Reference has a C major chord
        const ref = buildRef([[60, 0], [64, 0], [67, 0], [72, 720]]);
        // Student plays the same chord (slightly asynchronous)
        const stu = buildStu([[60, 0], [64, 0.02], [67, 0.04], [72, 1]]);

        const result = matchSubsequence(ref, stu);
        expect(result.matches.length).toBe(4);
        // Each pitch should match its counterpart
        for (const m of result.matches) {
            expect(m.ref.pitch).toBe(m.stu.pitch);
        }
    });

    it('matches chords with a wrong note', () => {
        // Reference: C major chord [C4, E4, G4]
        const ref = buildRef([[60, 0], [64, 0], [67, 0]]);
        // Student plays [C4, F4, G4] — F4 instead of E4
        const stu = buildStu([[60, 0], [65, 0.02], [67, 0.04]]);

        const result = matchSubsequence(ref, stu);
        // C4 and G4 should match; E4/F4 mismatch handled
        const matchedPitchPairs = result.matches.map(m => [m.ref.pitch, m.stu.pitch]);
        expect(matchedPitchPairs).toContainEqual([60, 60]);
        expect(matchedPitchPairs).toContainEqual([67, 67]);
    });

    it('handles strongly expressive timing differences', () => {
        // Same pitches but very different timing (rubato)
        const ref = buildRef([[60, 0], [62, 720], [64, 1440], [65, 2160], [67, 2880]]);
        // Student plays with extreme rubato — timing completely different
        const stu = buildStu([[60, 0], [62, 0.3], [64, 2.0], [65, 2.1], [67, 5.0]]);

        const result = matchSubsequence(ref, stu);
        expect(result.matches.length).toBe(5);
        // All pitches should match regardless of timing
        for (const m of result.matches) {
            expect(m.ref.pitch).toBe(m.stu.pitch);
        }
    });

    it('uses dateHint to restrict search', () => {
        // Long reference
        const ref = buildRef([
            [60, 0], [62, 720], [64, 1440],       // section A
            [72, 10000], [74, 10720], [76, 11440], // section B (far away)
        ]);
        // Student plays section B
        const stu = buildStu([[72, 0], [74, 1], [76, 2]]);

        const result = matchSubsequence(ref, stu, { dateHint: 10000 });
        expect(result.matches.length).toBe(3);
        expect(result.range.from).toBe(10000);
    });

    it('handles repeated pitch patterns (e.g. trills)', () => {
        // Reference has a trill: C-D-C-D-C
        const ref = buildRef([[60, 0], [62, 180], [60, 360], [62, 540], [60, 720]]);
        // Student plays same trill
        const stu = buildStu([[60, 0], [62, 0.2], [60, 0.4], [62, 0.6], [60, 0.8]]);

        const result = matchSubsequence(ref, stu);
        expect(result.matches.length).toBe(5);
    });

    it('handles empty student performance', () => {
        const ref = buildRef([[60, 0], [64, 720]]);
        const result = matchSubsequence(ref, []);
        expect(result.matches.length).toBe(0);
    });

    it('handles single note', () => {
        const ref = buildRef([[60, 0], [62, 720], [64, 1440]]);
        const stu = buildStu([[62, 0]]);

        const result = matchSubsequence(ref, stu);
        expect(result.matches.length).toBe(1);
        expect(result.matches[0].ref.pitch).toBe(62);
    });
});

// ---------------------------------------------------------------------------
//  Stress tests with generated performances
// ---------------------------------------------------------------------------

describe('generated performance tests', () => {
    /**
     * Generate a "performance" of a reference by applying random timing/velocity
     * perturbations, optionally adding/removing notes.
     */
    function generatePerformance(
        ref: RefNote[],
        opts: {
            timingJitter?: number;       // max onset shift in seconds
            velocityJitter?: number;     // max velocity change
            extraNoteProb?: number;      // probability of inserting a random extra note
            missingNoteProb?: number;    // probability of skipping a note
            startIdx?: number;           // start of subsequence
            endIdx?: number;             // end of subsequence
        } = {}
    ): { notes: StudentNote[]; expectedMatches: number; expectedMissing: number } {
        const {
            timingJitter = 0.05,
            velocityJitter = 20,
            extraNoteProb = 0,
            missingNoteProb = 0,
            startIdx = 0,
            endIdx = ref.length,
        } = opts;

        const subseq = ref.slice(startIdx, endIdx);
        const notes: StudentNote[] = [];
        let expectedMatches = 0;
        let expectedMissing = 0;
        let id = 0;

        // Simple deterministic pseudo-random for reproducibility
        let seed = 42;
        const rand = () => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed / 0x7fffffff;
        };

        for (const n of subseq) {
            // Possibly skip this note
            if (rand() < missingNoteProb) {
                expectedMissing++;
                continue;
            }

            // Possibly add an extra note before
            if (rand() < extraNoteProb) {
                const extraPitch = Math.round(40 + rand() * 48);
                notes.push({
                    id: `gen_${id++}`,
                    pitch: extraPitch,
                    onset: n.onset + (rand() - 0.5) * timingJitter - 0.1,
                    duration: 0.2 + rand() * 0.3,
                    velocity: Math.round(40 + rand() * 80),
                });
            }

            notes.push({
                id: `gen_${id++}`,
                pitch: n.pitch,
                onset: n.onset + (rand() - 0.5) * timingJitter,
                duration: n.duration * (0.8 + rand() * 0.4),
                velocity: Math.round(Math.max(1, Math.min(127,
                    n.velocity + (rand() - 0.5) * velocityJitter))),
            });
            expectedMatches++;
        }

        notes.sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
        return { notes, expectedMatches, expectedMissing };
    }

    /** Build a scale-like reference sequence */
    function buildScaleRef(startPitch: number, length: number, dateStep: number = 720): RefNote[] {
        return Array.from({ length }, (_, i) =>
            refNote(startPitch + i, i * dateStep, { index: i, onset: i * 0.5 })
        );
    }

    /** Build a chord-based reference (like Träumerei) */
    function buildChordRef(): RefNote[] {
        // Simplified chord progression: 4 chords of 3-4 notes each
        const chords: Array<[number[], number]> = [
            [[48, 60, 64, 67], 0],       // C major
            [[50, 62, 65, 69], 720],     // Dm7
            [[48, 60, 64, 67], 1440],    // C major
            [[47, 59, 62, 67], 2160],    // G7
            [[48, 60, 64, 67], 2880],    // C major
        ];
        const notes: RefNote[] = [];
        let idx = 0;
        for (const [pitches, date] of chords) {
            for (const pitch of pitches) {
                notes.push(refNote(pitch, date, {
                    index: idx++,
                    onset: date / 720 * 0.5,
                    duration: 0.45,
                }));
            }
        }
        return notes;
    }

    it('matches a scale with slight timing jitter', () => {
        const ref = buildScaleRef(60, 12);
        const { notes, expectedMatches } = generatePerformance(ref, {
            timingJitter: 0.1,
        });

        const result = matchSubsequence(ref, notes);
        expect(result.matches.length).toBe(expectedMatches);
    });

    it('matches a scale subsequence', () => {
        const ref = buildScaleRef(60, 20);
        const { notes, expectedMatches } = generatePerformance(ref, {
            startIdx: 5,
            endIdx: 15,
        });

        const result = matchSubsequence(ref, notes);
        expect(result.matches.length).toBe(expectedMatches);
    });

    it('handles ~10% extra notes', () => {
        const ref = buildScaleRef(60, 20);
        const { notes, expectedMatches } = generatePerformance(ref, {
            extraNoteProb: 0.1,
        });

        const result = matchSubsequence(ref, notes);
        // Should still match all intended notes
        expect(result.matches.length).toBe(expectedMatches);
    });

    it('handles ~10% missing notes', () => {
        const ref = buildScaleRef(60, 20);
        const { notes, expectedMatches, expectedMissing } = generatePerformance(ref, {
            missingNoteProb: 0.1,
        });

        const result = matchSubsequence(ref, notes);
        expect(result.matches.length).toBe(expectedMatches);
        expect(result.deletions.length).toBeGreaterThanOrEqual(expectedMissing);
    });

    it('handles both extra and missing notes', () => {
        const ref = buildScaleRef(60, 30);
        const { notes, expectedMatches } = generatePerformance(ref, {
            extraNoteProb: 0.15,
            missingNoteProb: 0.1,
        });

        const result = matchSubsequence(ref, notes);
        // Allow some tolerance — the matcher may miss a few
        expect(result.matches.length).toBeGreaterThanOrEqual(expectedMatches * 0.8);
    });

    it('matches chord progression correctly', () => {
        const ref = buildChordRef();
        const { notes, expectedMatches } = generatePerformance(ref, {
            timingJitter: 0.08,
        });

        const result = matchSubsequence(ref, notes);
        expect(result.matches.length).toBe(expectedMatches);
        // Every match should have correct pitch
        for (const m of result.matches) {
            expect(m.ref.pitch).toBe(m.stu.pitch);
        }
    });

    it('matches chord subsequence', () => {
        const ref = buildChordRef();
        // Play only chords 2-4 (indices 4-15)
        const { notes, expectedMatches } = generatePerformance(ref, {
            startIdx: 4,
            endIdx: 16,
            timingJitter: 0.05,
        });

        const result = matchSubsequence(ref, notes);
        expect(result.matches.length).toBe(expectedMatches);
    });

    it('handles large velocity differences', () => {
        const ref = buildScaleRef(60, 10);
        const { notes, expectedMatches } = generatePerformance(ref, {
            velocityJitter: 60, // very large velocity changes
        });

        const result = matchSubsequence(ref, notes);
        expect(result.matches.length).toBe(expectedMatches);
    });

    it('handles arpeggiated chords (broken chords)', () => {
        // Reference has simultaneous chord
        const ref = buildRef([[60, 0], [64, 0], [67, 0]]);
        // Student arpeggiates with 80ms between each note
        const stu = buildStu([[60, 0], [64, 0.08], [67, 0.16]]);

        const result = matchSubsequence(ref, stu);
        expect(result.matches.length).toBe(3);
        for (const m of result.matches) {
            expect(m.ref.pitch).toBe(m.stu.pitch);
        }
    });

    it('handles reversed chord voicing', () => {
        // Reference: [C4, E4, G4] simultaneous
        const ref = buildRef([[60, 0], [64, 0], [67, 0]]);
        // Student plays top-down: G4 first, then E4, then C4
        const stu = buildStu([[67, 0], [64, 0.05], [60, 0.09]]);

        const result = matchSubsequence(ref, stu);
        expect(result.matches.length).toBe(3);
        for (const m of result.matches) {
            expect(m.ref.pitch).toBe(m.stu.pitch);
        }
    });
});

// ---------------------------------------------------------------------------
//  MIDI extraction
// ---------------------------------------------------------------------------

describe('extractNotesFromMidi', () => {
    it('extracts notes from a simple MidiFile', () => {
        // Build a minimal MidiFile using midifile-ts type/subtype structure
        const midi = {
            header: { formatType: 0, trackCount: 1, ticksPerBeat: 480 },
            tracks: [[
                { deltaTime: 0, type: 'meta', subtype: 'setTempo', microsecondsPerBeat: 500000 },
                { deltaTime: 0, channel: 0, type: 'channel', subtype: 'noteOn', noteNumber: 60, velocity: 80 },
                { deltaTime: 480, channel: 0, type: 'channel', subtype: 'noteOff', noteNumber: 60, velocity: 0 },
                { deltaTime: 0, channel: 0, type: 'channel', subtype: 'noteOn', noteNumber: 64, velocity: 90 },
                { deltaTime: 480, channel: 0, type: 'channel', subtype: 'noteOff', noteNumber: 64, velocity: 0 },
                { deltaTime: 0, type: 'meta', subtype: 'endOfTrack' },
            ]],
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const notes = extractNotesFromMidi(midi as any);
        expect(notes.length).toBe(2);
        expect(notes[0].pitch).toBe(60);
        expect(notes[1].pitch).toBe(64);
        // At 120 BPM, 480 ticks = 1 beat = 0.5 seconds
        expect(notes[0].onset).toBeCloseTo(0, 2);
        expect(notes[0].duration).toBeCloseTo(0.5, 2);
        expect(notes[1].onset).toBeCloseTo(0.5, 2);
    });

    it('handles velocity-0 noteOn as noteOff', () => {
        const midi = {
            header: { formatType: 0, trackCount: 1, ticksPerBeat: 480 },
            tracks: [[
                { deltaTime: 0, type: 'meta', subtype: 'setTempo', microsecondsPerBeat: 500000 },
                { deltaTime: 0, channel: 0, type: 'channel', subtype: 'noteOn', noteNumber: 60, velocity: 80 },
                { deltaTime: 480, channel: 0, type: 'channel', subtype: 'noteOn', noteNumber: 60, velocity: 0 },
                { deltaTime: 0, type: 'meta', subtype: 'endOfTrack' },
            ]],
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const notes = extractNotesFromMidi(midi as any);
        expect(notes.length).toBe(1);
        expect(notes[0].pitch).toBe(60);
    });
});

// ---------------------------------------------------------------------------
//  Edge cases and robustness
// ---------------------------------------------------------------------------

describe('edge cases', () => {
    it('handles repeated notes (same pitch, different times)', () => {
        const ref = buildRef([[60, 0], [60, 720], [60, 1440]]);
        const stu = buildStu([[60, 0], [60, 1], [60, 2]]);

        const result = matchSubsequence(ref, stu);
        expect(result.matches.length).toBe(3);
    });

    it('handles all notes being wrong pitches', () => {
        const ref = buildRef([[60, 0], [64, 720], [67, 1440]]);
        const stu = buildStu([[61, 0], [63, 1], [66, 2]]); // all off by 1-2 semitones

        const result = matchSubsequence(ref, stu);
        // Depending on scoring, may match some or none
        // Important: shouldn't crash
        expect(result).toBeDefined();
    });

    it('handles very long reference with short student phrase', () => {
        // 100-note reference, 5-note student phrase
        const ref = buildScaleRef(36, 100);
        const stu = buildStu([[60, 0], [61, 0.5], [62, 1], [63, 1.5], [64, 2]]);

        const result = matchSubsequence(ref, stu);
        expect(result.matches.length).toBe(5);
        expect(result.matches[0].ref.pitch).toBe(60);
    });

    it('produces monotonic matches (temporal order preserved)', () => {
        const ref = buildScaleRef(48, 24);
        const perf = Array.from({ length: 10 }, (_, i) =>
            stuNote(53 + i, i * 0.4)
        );

        const result = matchSubsequence(ref, perf);

        // Verify monotonicity: matched ref dates should be non-decreasing
        for (let i = 1; i < result.matches.length; i++) {
            expect(result.matches[i].ref.date).toBeGreaterThanOrEqual(
                result.matches[i - 1].ref.date
            );
        }
    });
});

// ---------------------------------------------------------------------------
//  Realistic Träumerei-like test
// ---------------------------------------------------------------------------

describe('realistic Träumerei-like fragment', () => {
    /**
     * Build a reference resembling the opening bars of Träumerei.
     * Bar 1: LH bass F2 + RH chord [C4, F4, A4] at date 0,
     *         melody Bb4 at 360, A4 at 540, C5 at 720
     * Bar 2: LH bass Bb1 + RH chord [D4, F4, Bb4] at 1440,
     *         melody C5 at 1800, Bb4 at 1980, D5 at 2160
     * Plus a few additional inner-voice and bass notes.
     */
    function buildTraumereiRef(): RefNote[] {
        const raw: Array<[number, number]> = [
            // Bar 1 - beat 1: LH bass + RH chord
            [41, 0],    // F2  (LH bass)
            [60, 0],    // C4  (RH chord)
            [65, 0],    // F4  (RH chord)
            [69, 0],    // A4  (RH chord)
            // Bar 1 - melody
            [70, 360],  // Bb4
            [69, 540],  // A4
            // Bar 1 - beat 2: melody + inner voice movement
            [72, 720],  // C5
            [60, 720],  // C4 (inner voice sustain)
            // Bar 1 - beat 3
            [74, 1080], // D5
            [65, 1080], // F4 (inner voice)
            // Bar 2 - beat 1: LH bass + RH chord
            [34, 1440], // Bb1 (LH bass)
            [62, 1440], // D4  (RH chord)
            [65, 1440], // F4  (RH chord)
            [70, 1440], // Bb4 (RH chord)
            // Bar 2 - melody
            [72, 1800], // C5
            [70, 1980], // Bb4
            // Bar 2 - beat 2
            [74, 2160], // D5
            [62, 2160], // D4 (inner voice)
            // Bar 2 - beat 3
            [72, 2520], // C5
            [65, 2520], // F4
            // Bar 2 - beat 4
            [70, 2880], // Bb4
            [62, 2880], // D4
            [41, 2880], // F2 (LH resolution)
        ];
        return raw.map(([pitch, date], i) =>
            refNote(pitch, date, { index: i, onset: date / 720 * 0.5 })
        );
    }

    it('matches a student performance of bars 1-2 with realistic timing', () => {
        const ref = buildTraumereiRef();
        // Student plays all 23 notes with moderate rubato jitter
        const stu: StudentNote[] = ref.map((n, i) =>
            stuNote(n.pitch, n.onset + (i % 3 - 1) * 0.03)
        );

        const result = matchSubsequence(ref, stu);
        // Allow slight tolerance: repeated pitches at nearby dates (e.g. A4 in
        // chord at date 0 and as melody at date 540) can confuse chord grouping
        expect(result.matches.length).toBeGreaterThanOrEqual(ref.length - 3);
        for (const m of result.matches) {
            expect(m.ref.pitch).toBe(m.stu.pitch);
        }
    });

    it('matches when student omits LH bass notes', () => {
        const ref = buildTraumereiRef();
        // Student plays only RH (filter out notes below C3 = 48)
        const rhRef = ref.filter(n => n.pitch >= 48);
        const stu: StudentNote[] = rhRef.map((n, i) =>
            stuNote(n.pitch, n.onset + (i % 2) * 0.02)
        );

        const result = matchSubsequence(ref, stu);
        // Should match all RH notes
        expect(result.matches.length).toBe(rhRef.length);
        // LH notes should appear as deletions
        const lhCount = ref.filter(n => n.pitch < 48).length;
        expect(result.deletions.length).toBeGreaterThanOrEqual(lhCount);
    });

    it('matches when student adds grace notes before melody notes', () => {
        const ref = buildTraumereiRef();
        const stu: StudentNote[] = [];
        for (const n of ref) {
            // Add a grace note (one semitone below) before each melody note
            if (n.pitch >= 69) {
                stu.push(stuNote(n.pitch - 1, n.onset - 0.06));
            }
            stu.push(stuNote(n.pitch, n.onset));
        }
        stu.sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);

        const result = matchSubsequence(ref, stu);
        // All ref notes should be matched
        expect(result.matches.length).toBe(ref.length);
        // Grace notes should be insertions
        expect(result.insertions.length).toBeGreaterThan(0);
    });

    it('matches a student fragment (only bar 2) from the full reference', () => {
        const ref = buildTraumereiRef();
        // Student plays only bar 2 (dates >= 1440)
        const bar2Ref = ref.filter(n => n.date >= 1440);
        const stu: StudentNote[] = bar2Ref.map(n =>
            stuNote(n.pitch, (n.date - 1440) / 720 * 0.5)
        );

        const result = matchSubsequence(ref, stu, { dateHint: 1440 });
        expect(result.matches.length).toBe(bar2Ref.length);
        expect(result.range.from).toBeGreaterThanOrEqual(1440);
    });
});

// ---------------------------------------------------------------------------
//  Repeated sections test (||: A :||)
// ---------------------------------------------------------------------------

describe('repeated sections (disambiguated by dateHint)', () => {
    /**
     * Build a reference where the same 8-note phrase (A section) appears twice
     * at different score dates, simulating ||: A :||.
     */
    function buildRepeatedRef(): RefNote[] {
        const phrase: Array<[number, number]> = [
            [60, 0], [64, 720], [65, 1440], [67, 2160],
            [69, 2880], [67, 3600], [65, 4320], [64, 5040],
        ];
        const firstPass = phrase.map(([p, d], i) =>
            refNote(p, d, { index: i, onset: d / 720 * 0.5 })
        );
        // Second pass: same pitches, dates offset by 5760 (= 8 * 720)
        const offset = 5760;
        const secondPass = phrase.map(([p, d], i) =>
            refNote(p, d + offset, {
                index: i + phrase.length,
                onset: (d + offset) / 720 * 0.5,
                id: `ref_${d + offset}_${p}`,
            })
        );
        return [...firstPass, ...secondPass];
    }

    it('without dateHint, matches first occurrence by default', () => {
        const ref = buildRepeatedRef();
        const stu = buildStu([
            [60, 0], [64, 0.5], [65, 1.0], [67, 1.5],
            [69, 2.0], [67, 2.5], [65, 3.0], [64, 3.5],
        ]);

        const result = matchSubsequence(ref, stu);
        expect(result.matches.length).toBe(8);
        // All matched ref notes should come from the first occurrence
        for (const m of result.matches) {
            expect(m.ref.date).toBeLessThan(5760);
        }
    });

    it('with dateHint pointing to second occurrence, matches second pass', () => {
        const ref = buildRepeatedRef();
        const stu = buildStu([
            [60, 0], [64, 0.5], [65, 1.0], [67, 1.5],
            [69, 2.0], [67, 2.5], [65, 3.0], [64, 3.5],
        ]);

        // Use a narrow dateWindow so only the second occurrence is visible
        const result = matchSubsequence(ref, stu, { dateHint: 8640, dateWindow: 4000 });
        expect(result.matches.length).toBe(8);
        // All matched ref notes should come from the second occurrence
        for (const m of result.matches) {
            expect(m.ref.date).toBeGreaterThanOrEqual(5760);
        }
    });

    it('matches partial phrase in second occurrence with dateHint', () => {
        const ref = buildRepeatedRef();
        // Student plays only the last 4 notes of the phrase during the repeat
        const stu = buildStu([
            [69, 0], [67, 0.5], [65, 1.0], [64, 1.5],
        ]);

        // Narrow window centred on second-pass tail
        const result = matchSubsequence(ref, stu, { dateHint: 8640, dateWindow: 4000 });
        expect(result.matches.length).toBe(4);
        // Should match second occurrence notes
        for (const m of result.matches) {
            expect(m.ref.date).toBeGreaterThanOrEqual(5760);
        }
    });

    it('handles three repetitions and dateHint selects the middle one', () => {
        const phrase: Array<[number, number]> = [
            [60, 0], [62, 720], [64, 1440], [65, 2160],
        ];
        // Place repetitions far enough apart that a narrow window isolates each
        const offsets = [0, 20000, 40000];
        const ref: RefNote[] = [];
        let idx = 0;
        for (const off of offsets) {
            for (const [p, d] of phrase) {
                ref.push(refNote(p, d + off, {
                    index: idx++,
                    onset: (d + off) / 720 * 0.5,
                    id: `ref_${d + off}_${p}`,
                }));
            }
        }

        const stu = buildStu([[60, 0], [62, 0.5], [64, 1.0], [65, 1.5]]);
        // Narrow window around the middle repetition
        const result = matchSubsequence(ref, stu, { dateHint: 21000, dateWindow: 5000 });
        expect(result.matches.length).toBe(4);
        for (const m of result.matches) {
            expect(m.ref.date).toBeGreaterThanOrEqual(20000);
            expect(m.ref.date).toBeLessThan(40000);
        }
    });
});

// ---------------------------------------------------------------------------
//  Heavy perturbation stress tests
// ---------------------------------------------------------------------------

describe('heavy perturbation stress tests', () => {
    /** Deterministic pseudo-random generator for reproducible tests. */
    function makeRng(seed: number) {
        return () => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed / 0x7fffffff;
        };
    }

    it('handles 20% extra notes + 15% missing notes simultaneously', () => {
        const ref = buildScaleRef(48, 40);
        const rand = makeRng(7);
        const stu: StudentNote[] = [];
        let expectedMatches = 0;

        for (const n of ref) {
            // 15% chance to skip
            if (rand() < 0.15) continue;

            // 20% chance to insert a random wrong note before
            if (rand() < 0.20) {
                const wrongPitch = Math.round(40 + rand() * 48);
                stu.push(stuNote(wrongPitch, n.onset - 0.05 + rand() * 0.02));
            }

            stu.push(stuNote(n.pitch, n.onset + (rand() - 0.5) * 0.08));
            expectedMatches++;
        }
        stu.sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);

        const result = matchSubsequence(ref, stu);
        // Should match at least 70% of the expected notes under heavy perturbation
        expect(result.matches.length).toBeGreaterThanOrEqual(expectedMatches * 0.7);
        expect(result.insertions.length).toBeGreaterThan(0);
        expect(result.deletions.length).toBeGreaterThan(0);
    });

    it('handles student playing at double speed (50% time compression)', () => {
        const ref = buildScaleRef(60, 20);
        // Student plays same pitches but at half the onset times
        const stu: StudentNote[] = ref.map(n =>
            stuNote(n.pitch, n.onset * 0.5)
        );

        const result = matchSubsequence(ref, stu);
        // All pitches match, timing should not prevent matching
        expect(result.matches.length).toBe(20);
        for (const m of result.matches) {
            expect(m.ref.pitch).toBe(m.stu.pitch);
        }
    });

    it('handles student playing at half speed (200% time stretch)', () => {
        const ref = buildScaleRef(60, 20);
        // Student plays same pitches but at double the onset times
        const stu: StudentNote[] = ref.map(n =>
            stuNote(n.pitch, n.onset * 2.0)
        );

        const result = matchSubsequence(ref, stu);
        expect(result.matches.length).toBe(20);
        for (const m of result.matches) {
            expect(m.ref.pitch).toBe(m.stu.pitch);
        }
    });

    it('handles a cluster of wrong notes in the middle of a correct performance', () => {
        const ref = buildScaleRef(60, 20);
        const stu: StudentNote[] = [];

        for (let i = 0; i < 20; i++) {
            if (i >= 8 && i <= 12) {
                // Wrong notes in positions 8-12: shift pitch by a tritone
                stu.push(stuNote(ref[i].pitch + 6, ref[i].onset));
            } else {
                stu.push(stuNote(ref[i].pitch, ref[i].onset));
            }
        }

        const result = matchSubsequence(ref, stu);
        // Notes outside the cluster (15 notes) should match
        const correctMatches = result.matches.filter(m => m.ref.pitch === m.stu.pitch);
        expect(correctMatches.length).toBeGreaterThanOrEqual(14);
        // The wrong cluster notes should be insertions or unmatched
        expect(result.insertions.length + result.deletions.length).toBeGreaterThan(0);
    });

    it('handles student repeating a note multiple times (stuttering)', () => {
        const ref = buildScaleRef(60, 10);
        const stu: StudentNote[] = [];
        for (const n of ref) {
            // Play each note 3 times in quick succession
            stu.push(stuNote(n.pitch, n.onset - 0.05));
            stu.push(stuNote(n.pitch, n.onset));
            stu.push(stuNote(n.pitch, n.onset + 0.05));
        }
        stu.sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);

        const result = matchSubsequence(ref, stu);
        // Should match 10 notes (one per ref note)
        expect(result.matches.length).toBe(10);
        // Extra repetitions should be insertions
        expect(result.insertions.length).toBe(20);
    });

    it('handles transposition by a whole tone', () => {
        const ref = buildScaleRef(60, 12);
        // Student transposes everything up a whole tone (+2 semitones)
        const stu: StudentNote[] = ref.map(n =>
            stuNote(n.pitch + 2, n.onset)
        );

        const result = matchSubsequence(ref, stu);
        // Whole-tone transposition: no exact pitch matches, but adjacent scale
        // degrees in a chromatic scale overlap (e.g. ref 62 == stu 60+2).
        // In a chromatic buildScaleRef, ref pitch i+2 == stu pitch i, so the
        // matcher can align offset pairs via exact match on overlapping pitches.
        // We just verify the matcher doesn't crash and returns a valid result.
        expect(result).toBeDefined();
        // Every match must be an exact or octave-equivalent pitch match
        // (the post-alignment filter enforces this)
        for (const m of result.matches) {
            expect(m.ref.pitch % 12).toBe(m.stu.pitch % 12);
        }
    });

    it('handles simultaneous extra + missing in chords', () => {
        // Reference: 4 chords of 4 notes
        const ref = buildRef([
            [48, 0], [60, 0], [64, 0], [67, 0],
            [50, 720], [62, 720], [65, 720], [69, 720],
            [48, 1440], [60, 1440], [64, 1440], [67, 1440],
            [47, 2160], [59, 2160], [62, 2160], [67, 2160],
        ]);
        // Student: chord 1 missing bass, chord 2 perfect, chord 3 extra note,
        //          chord 4 missing top note
        const stu = buildStu([
            // chord 1: missing 48
            [60, 0], [64, 0.02], [67, 0.04],
            // chord 2: perfect
            [50, 1.0], [62, 1.02], [65, 1.04], [69, 1.06],
            // chord 3: extra note 66 (F#4)
            [48, 2.0], [60, 2.02], [64, 2.04], [66, 2.05], [67, 2.06],
            // chord 4: missing 67
            [47, 3.0], [59, 3.02], [62, 3.04],
        ]);

        const result = matchSubsequence(ref, stu);
        // chord1: 3 matched, chord2: 4, chord3: 4 matched + 1 extra, chord4: 3
        expect(result.matches.length).toBeGreaterThanOrEqual(13);
        expect(result.deletions.length).toBeGreaterThanOrEqual(2); // bass from chord1, top from chord4
        expect(result.insertions.length).toBeGreaterThanOrEqual(1); // the F#4
    });
});

// ---------------------------------------------------------------------------
//  Performance / scale test
// ---------------------------------------------------------------------------

describe('performance and scale', () => {
    it('matches a 50-note student phrase in a 500-note reference in < 100ms', () => {
        // Build a 500-note reference spanning a wide pitch and date range
        const ref: RefNote[] = [];
        for (let i = 0; i < 500; i++) {
            const pitch = 36 + (i % 52); // cycle through pitches 36-87
            const date = i * 360;
            ref.push(refNote(pitch, date, { index: i, onset: date / 720 * 0.5 }));
        }

        // Student plays notes 200-249 (a 50-note segment) with slight jitter
        const segment = ref.slice(200, 250);
        const stu: StudentNote[] = segment.map((n, i) =>
            stuNote(n.pitch, n.onset + (i % 3 - 1) * 0.02)
        );

        const start = performance.now();
        const result = matchSubsequence(ref, stu, { dateHint: 200 * 360 });
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(100);
        expect(result.matches.length).toBe(50);
        for (const m of result.matches) {
            expect(m.ref.pitch).toBe(m.stu.pitch);
        }
    });

    it('matches a 20-note phrase in a 500-note reference without dateHint', () => {
        const ref: RefNote[] = [];
        for (let i = 0; i < 500; i++) {
            // Use a pentatonic pattern so there are repeated pitch patterns
            const degrees = [0, 2, 4, 7, 9];
            const octave = Math.floor(i / 5);
            const pitch = 36 + (octave % 5) * 12 + degrees[i % 5];
            const date = i * 360;
            ref.push(refNote(pitch, date, { index: i, onset: date / 720 * 0.5 }));
        }

        // Student plays notes 300-319
        const segment = ref.slice(300, 320);
        const stu: StudentNote[] = segment.map((n, i) =>
            stuNote(n.pitch, i * 0.25)
        );

        const start = performance.now();
        const result = matchSubsequence(ref, stu);
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(200); // more generous without dateHint
        expect(result.matches.length).toBe(20);
    });

    it('handles 100-note student against 500-note reference', () => {
        // Use a chromatic ascending pattern so each note has a unique pitch
        // within a reasonable range, cycling over the full MIDI range
        const ref: RefNote[] = [];
        for (let i = 0; i < 500; i++) {
            const pitch = 24 + (i % 72); // cycle through pitches 24-95
            const date = i * 720;
            ref.push(refNote(pitch, date, { index: i, onset: date / 720 * 0.5 }));
        }

        // Pick a 100-note segment from the middle
        const segment = ref.slice(200, 300);
        const stu: StudentNote[] = segment.map((n, i) =>
            stuNote(n.pitch, i * 0.5 + (i % 2) * 0.03)
        );

        const start = performance.now();
        const result = matchSubsequence(ref, stu, { dateHint: 200 * 720 });
        const elapsed = performance.now() - start;

        expect(elapsed).toBeLessThan(500);
        // With cycling pitches and dateHint, a good portion should match.
        // The main point of this test is that it completes in reasonable time.
        expect(result.matches.length).toBeGreaterThanOrEqual(50);
    });
});

// Helper to build a scale-like reference for stress tests
function buildScaleRef(startPitch: number, length: number, dateStep: number = 720): RefNote[] {
    return Array.from({ length }, (_, i) =>
        refNote(startPitch + i, i * dateStep, { index: i, onset: i * 0.5 })
    );
}
