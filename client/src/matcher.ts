/**
 * Subsequence matcher for aligning a student's expressive piano performance
 * (MIDI) to a reference score (MSM).
 *
 * Two-stage algorithm:
 *   1. Semi-global Smith-Waterman with affine gaps on pitch-sorted note
 *      sequences — finds WHERE the student phrase matches in the reference
 *      and establishes note-to-note correspondence.
 *   2. Post-alignment cleanup with monotonicity enforcement and chord-aware
 *      local refinement via the Hungarian algorithm.
 *
 * Handles: extra notes (insertions), missing notes (deletions),
 * large timing/dynamic differences, arpeggiated chords.
 */

import type { MidiFile } from "midifile-ts";
import type { MSM } from "mpmify";
import { IMPLANTED, measuredNotesFromMsm, msToSeconds, type MeasuredNote } from "./score/measured";

// ---------------------------------------------------------------------------
//  Types
// ---------------------------------------------------------------------------

/** A note extracted from the student's MIDI performance. */
export type StudentNote = {
    id: string;
    pitch: number;          // MIDI pitch 0-127
    onset: number;          // seconds
    duration: number;       // seconds
    velocity: number;       // 0-127
};

/** A reference note extracted from the MSM. */
export type RefNote = {
    id: string;             // xml:id
    pitch: number;          // midi.pitch
    date: number;           // score ticks
    onset: number;          // midi.onset (seconds)
    duration: number;       // midi.duration (seconds)
    velocity: number;       // midi.velocity
    index: number;          // original index in allNotes
};

/** A matched pair: reference note <-> student note */
type Match = {
    ref: RefNote;
    stu: StudentNote;
};

/** Result of the subsequence matching. */
type MatchResult = {
    matches: Match[];
    /** Reference notes in the matched region that have no student match. */
    deletions: RefNote[];
    /** Student notes that don't match any reference note. */
    insertions: StudentNote[];
    /** Score-date range of the matched region. */
    range: { from: number; to: number };
};

// ---------------------------------------------------------------------------
//  MIDI parsing
// ---------------------------------------------------------------------------

/**
 * Extract note events from a parsed MidiFile.
 * Computes absolute onset times in seconds using tempo meta-events.
 */
export function extractNotesFromMidi(midi: MidiFile): StudentNote[] {
    const tpb = midi.header.ticksPerBeat;
    const notes: StudentNote[] = [];

    for (const track of midi.tracks) {
        let tickCursor = 0;
        let usPQ = 500_000; // default 120 BPM
        let secCursor = 0;

        // Pending note-ons: pitch -> { onset, velocity }
        const pending = new Map<number, { onset: number; velocity: number }>();

        for (const event of track) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const e = event as any;
            const deltaTicks: number = e.deltaTime ?? 0;
            const deltaSec = (deltaTicks / tpb) * (usPQ / 1_000_000);
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            tickCursor += deltaTicks;
            secCursor += deltaSec;

            // midifile-ts uses type='meta' + subtype='setTempo', etc.
            const subtype: string | undefined = e.subtype;
            const type: string = e.type;

            // Tempo change
            if (type === 'meta' && subtype === 'setTempo') {
                usPQ = e.microsecondsPerBeat;
                continue;
            }

            if (type === 'channel' && subtype === 'noteOn') {
                if (e.velocity > 0) {
                    pending.set(e.noteNumber, { onset: secCursor, velocity: e.velocity });
                } else {
                    // velocity 0 note-on = note-off
                    const on = pending.get(e.noteNumber);
                    if (on) {
                        notes.push({
                            id: `s${notes.length}`,
                            pitch: e.noteNumber,
                            onset: on.onset,
                            duration: Math.max(0.01, secCursor - on.onset),
                            velocity: on.velocity,
                        });
                        pending.delete(e.noteNumber);
                    }
                }
            } else if (type === 'channel' && subtype === 'noteOff') {
                const on = pending.get(e.noteNumber);
                if (on) {
                    notes.push({
                        id: `s${notes.length}`,
                        pitch: e.noteNumber,
                        onset: on.onset,
                        duration: Math.max(0.01, secCursor - on.onset),
                        velocity: on.velocity,
                    });
                    pending.delete(e.noteNumber);
                }
            }
        }

        // Close any remaining pending notes
        for (const [pitch, on] of pending) {
            notes.push({
                id: `s${notes.length}`,
                pitch,
                onset: on.onset,
                duration: 0.1,
                velocity: on.velocity,
            });
        }
    }

    notes.sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
    // Re-assign IDs after sort
    for (let i = 0; i < notes.length; i++) notes[i].id = `s${i}`;
    return notes;
}

/**
 * Input projection: measured notes (milliseconds) into the matcher's own
 * seconds domain. The mirror of the output projection in `implantLocal`.
 */
export function refNotesFrom(notes: readonly MeasuredNote[]): RefNote[] {
    return notes.map((n, i) => ({
        id: n['xml:id'],
        pitch: n['midi.pitch'],
        date: n.date,
        onset: msToSeconds(n['milliseconds.date']),
        duration: msToSeconds(n['milliseconds.date.end'] - n['milliseconds.date']),
        velocity: n.velocity,
        index: i,
    }));
}

/**
 * Extract reference notes from MSM. Legacy entry point for the callers that
 * still hold an `MSM`; it goes when the MSM path does.
 */
export function extractRefNotes(msm: MSM): RefNote[] {
    return refNotesFrom(measuredNotesFromMsm(msm));
}

// ---------------------------------------------------------------------------
//  Onset grouping & pitch sorting
// ---------------------------------------------------------------------------

/**
 * Group notes by onset time (with tolerance) and sort within groups by pitch.
 * Returns a flat array with consistent within-chord ordering.
 *
 * For reference notes, use date (exact integer ticks) — no tolerance needed.
 * For student notes, use onset (seconds) with a tolerance threshold.
 */
export function groupAndSort<T extends { pitch: number }>(
    notes: T[],
    getOnset: (n: T) => number,
    tolerance: number,
): T[] {
    if (notes.length === 0) return [];

    // Notes should already be sorted by onset
    const sorted = [...notes].sort((a, b) => getOnset(a) - getOnset(b) || a.pitch - b.pitch);

    const groups: T[][] = [];
    let currentGroup: T[] = [sorted[0]];
    let groupStart = getOnset(sorted[0]);

    for (let i = 1; i < sorted.length; i++) {
        const onset = getOnset(sorted[i]);
        if (onset - groupStart <= tolerance) {
            currentGroup.push(sorted[i]);
        } else {
            groups.push(currentGroup);
            currentGroup = [sorted[i]];
            groupStart = onset;
        }
    }
    groups.push(currentGroup);

    // Sort within each group by pitch, then flatten
    return groups.flatMap(g => g.sort((a, b) => a.pitch - b.pitch));
}

// ---------------------------------------------------------------------------
//  Scoring
// ---------------------------------------------------------------------------

/** Score for aligning reference note r with student note s. */
export function matchScore(rPitch: number, sPitch: number): number {
    if (rPitch === sPitch) return 1.0;
    // Same pitch class (octave error)
    if (rPitch % 12 === sPitch % 12) return 0.3;
    // Semitone off (common mistake)
    if (Math.abs(rPitch - sPitch) === 1) return -0.2;
    // Everything else
    return -0.8;
}

// ---------------------------------------------------------------------------
//  Smith-Waterman with affine gaps (semi-global / fitting alignment)
// ---------------------------------------------------------------------------

const enum TraceOp { STOP, DIAG, UP, LEFT }

type AlignmentParams = {
    gapOpen: number;
    gapExtend: number;
};

const DEFAULT_PARAMS: AlignmentParams = {
    gapOpen: -0.6,
    gapExtend: -0.15,
};

type AlignmentResult = {
    /** Pairs of (refIndex, stuIndex). -1 means gap. */
    path: Array<[number, number]>;
    score: number;
    refStart: number;
    refEnd: number;
};

/**
 * Semi-global Smith-Waterman with affine gap penalties.
 *
 * The student (query) must be fully consumed.
 * The reference (database) can have free start and end.
 *
 * We use three DP matrices:
 *   M[i][j] = best score ending with a match (ref j aligned to stu i)
 *   Ix[i][j] = best score ending with a gap in student (ref j skipped)
 *   Iy[i][j] = best score ending with a gap in reference (extra student note i)
 */
export function smithWaterman(
    ref: { pitch: number }[],
    stu: { pitch: number }[],
    params: AlignmentParams = DEFAULT_PARAMS,
): AlignmentResult {
    const n = stu.length;  // rows (query)
    const m = ref.length;  // cols (database)

    if (n === 0 || m === 0) {
        return { path: [], score: 0, refStart: 0, refEnd: 0 };
    }

    const { gapOpen, gapExtend } = params;

    // Allocate DP matrices (n+1) x (m+1)
    // Using flat arrays for performance
    const size = (n + 1) * (m + 1);
    const M = new Float64Array(size);
    const Ix = new Float64Array(size); // gap in student (skip ref note)
    const Iy = new Float64Array(size); // gap in ref (extra student note)
    const traceM = new Uint8Array(size);
    const traceIx = new Uint8Array(size);
    const traceIy = new Uint8Array(size);

    const idx = (i: number, j: number) => i * (m + 1) + j;

    const NEG_INF = -1e9;

    // Initialize
    // Free start in reference: M[0][j] = 0, no penalty for skipping
    // Student must be consumed: Iy[i][0] = gapOpen + (i-1)*gapExtend
    for (let j = 0; j <= m; j++) {
        M[idx(0, j)] = 0;
        Ix[idx(0, j)] = NEG_INF;
        Iy[idx(0, j)] = NEG_INF;
    }
    for (let i = 1; i <= n; i++) {
        M[idx(i, 0)] = NEG_INF;
        Ix[idx(i, 0)] = NEG_INF;
        Iy[idx(i, 0)] = gapOpen + (i - 1) * gapExtend;
        traceIy[idx(i, 0)] = i === 1 ? TraceOp.STOP : TraceOp.LEFT;
    }

    // Fill DP
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            const k = idx(i, j);
            const kDiag = idx(i - 1, j - 1);
            const kUp = idx(i - 1, j);
            const kLeft = idx(i, j - 1);

            const score = matchScore(ref[j - 1].pitch, stu[i - 1].pitch);

            // M[i][j] = max(M[i-1][j-1], Ix[i-1][j-1], Iy[i-1][j-1]) + score
            const mFromM = M[kDiag];
            const mFromIx = Ix[kDiag];
            const mFromIy = Iy[kDiag];
            if (mFromM >= mFromIx && mFromM >= mFromIy) {
                M[k] = mFromM + score;
                traceM[k] = TraceOp.DIAG; // came from M
            } else if (mFromIx >= mFromIy) {
                M[k] = mFromIx + score;
                traceM[k] = TraceOp.UP; // came from Ix
            } else {
                M[k] = mFromIy + score;
                traceM[k] = TraceOp.LEFT; // came from Iy
            }

            // Ix[i][j] = max(M[i][j-1] + gapOpen, Ix[i][j-1] + gapExtend)
            // gap in student = skip reference note j
            const ixFromM = M[kLeft] + gapOpen;
            const ixFromIx = Ix[kLeft] + gapExtend;
            if (ixFromM >= ixFromIx) {
                Ix[k] = ixFromM;
                traceIx[k] = TraceOp.DIAG; // gap opened from M
            } else {
                Ix[k] = ixFromIx;
                traceIx[k] = TraceOp.LEFT; // gap extended
            }

            // Iy[i][j] = max(M[i-1][j] + gapOpen, Iy[i-1][j] + gapExtend)
            // gap in reference = extra student note i
            const iyFromM = M[kUp] + gapOpen;
            const iyFromIy = Iy[kUp] + gapExtend;
            if (iyFromM >= iyFromIy) {
                Iy[k] = iyFromM;
                traceIy[k] = TraceOp.DIAG; // gap opened from M
            } else {
                Iy[k] = iyFromIy;
                traceIy[k] = TraceOp.UP; // gap extended
            }
        }
    }

    // Find best endpoint: max over last row (i = n, all j)
    // This ensures all student notes are consumed.
    let bestScore = NEG_INF;
    let bestJ = 0;
    let bestMatrix = 0; // 0=M, 1=Ix, 2=Iy

    for (let j = 1; j <= m; j++) {
        const k = idx(n, j);
        if (M[k] > bestScore) { bestScore = M[k]; bestJ = j; bestMatrix = 0; }
        if (Ix[k] > bestScore) { bestScore = Ix[k]; bestJ = j; bestMatrix = 1; }
        if (Iy[k] > bestScore) { bestScore = Iy[k]; bestJ = j; bestMatrix = 2; }
    }

    // Traceback
    const path: Array<[number, number]> = [];
    let i = n, j = bestJ;
    let currentMatrix = bestMatrix;

    while (i > 0 || j > 0) {
        const k = idx(i, j);

        if (i === 0) break; // Free start: stop when student is consumed

        if (currentMatrix === 0) {
            // In M: this is a match (diag move)
            const trace = traceM[k];
            path.push([j - 1, i - 1]); // (refIdx, stuIdx)
            if (trace === TraceOp.DIAG) currentMatrix = 0;
            else if (trace === TraceOp.UP) currentMatrix = 1;
            else if (trace === TraceOp.LEFT) currentMatrix = 2;
            else break; // STOP
            i--; j--;
        } else if (currentMatrix === 1) {
            // In Ix: gap in student (skip ref note)
            const trace = traceIx[k];
            path.push([j - 1, -1]); // ref note with no student match
            if (trace === TraceOp.DIAG) currentMatrix = 0;
            else currentMatrix = 1;
            j--;
        } else {
            // In Iy: gap in ref (extra student note)
            const trace = traceIy[k];
            path.push([-1, i - 1]); // student note with no ref match
            if (trace === TraceOp.DIAG) currentMatrix = 0;
            else currentMatrix = 2;
            i--;
        }
    }

    path.reverse();

    // Find the reference range
    let refStart = m, refEnd = 0;
    for (const [ri] of path) {
        if (ri >= 0) {
            refStart = Math.min(refStart, ri);
            refEnd = Math.max(refEnd, ri);
        }
    }

    return { path, score: bestScore, refStart, refEnd };
}

// ---------------------------------------------------------------------------
//  Hungarian algorithm for local chord matching
// ---------------------------------------------------------------------------

/**
 * Solve the assignment problem using the Hungarian algorithm.
 * Cost matrix is n x m. Returns optimal assignment as pairs [row, col].
 * Handles rectangular matrices (n != m) by padding.
 */
export function hungarian(cost: number[][]): Array<[number, number]> {
    const n = cost.length;
    if (n === 0) return [];
    const m = cost[0].length;
    if (m === 0) return [];

    // Pad to square
    const sz = Math.max(n, m);
    const c: number[][] = Array.from({ length: sz }, (_, i) =>
        Array.from({ length: sz }, (_, j) =>
            i < n && j < m ? cost[i][j] : 0
        )
    );

    // Hungarian (Kuhn-Munkres) algorithm
    const u = new Float64Array(sz + 1);
    const v = new Float64Array(sz + 1);
    const p = new Int32Array(sz + 1);  // p[j] = row assigned to col j
    const way = new Int32Array(sz + 1);

    for (let i = 1; i <= sz; i++) {
        p[0] = i;
        let j0 = 0;
        const minv = new Float64Array(sz + 1).fill(Infinity);
        const used = new Uint8Array(sz + 1);

        do {
            used[j0] = 1;
            const i0 = p[j0];
            let delta = Infinity;
            let j1 = 0;

            for (let j = 1; j <= sz; j++) {
                if (used[j]) continue;
                const cur = c[i0 - 1][j - 1] - u[i0] - v[j];
                if (cur < minv[j]) {
                    minv[j] = cur;
                    way[j] = j0;
                }
                if (minv[j] < delta) {
                    delta = minv[j];
                    j1 = j;
                }
            }

            for (let j = 0; j <= sz; j++) {
                if (used[j]) {
                    u[p[j]] += delta;
                    v[j] -= delta;
                } else {
                    minv[j] -= delta;
                }
            }

            j0 = j1;
        } while (p[j0] !== 0);

        do {
            const j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
        } while (j0 !== 0);
    }

    // Extract assignments (only for real rows/cols)
    const result: Array<[number, number]> = [];
    for (let j = 1; j <= sz; j++) {
        const row = p[j] - 1;
        const col = j - 1;
        if (row < n && col < m) {
            result.push([row, col]);
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
//  Chord-aware local refinement
// ---------------------------------------------------------------------------

/**
 * Within aligned chord groups, use Hungarian algorithm to refine
 * pitch-to-pitch matching.
 *
 * Groups matched notes by their reference date, then for each group
 * re-solves the assignment problem considering pitch distances.
 */
function refineChordMatching(
    matches: Array<{ refIdx: number; stuIdx: number }>,
    ref: RefNote[],
    stu: StudentNote[],
): Array<{ refIdx: number; stuIdx: number }> {
    // Group by reference date
    const byDate = new Map<number, Array<{ refIdx: number; stuIdx: number }>>();
    for (const m of matches) {
        const date = ref[m.refIdx].date;
        if (!byDate.has(date)) byDate.set(date, []);
        byDate.get(date)!.push(m);
    }

    const refined: Array<{ refIdx: number; stuIdx: number }> = [];

    for (const group of byDate.values()) {
        if (group.length <= 1) {
            refined.push(...group);
            continue;
        }

        // Build cost matrix for this chord group
        const refIndices = group.map(g => g.refIdx);
        const stuIndices = group.map(g => g.stuIdx);

        const cost = refIndices.map(ri =>
            stuIndices.map(si => {
                const pitchDiff = Math.abs(ref[ri].pitch - stu[si].pitch);
                return pitchDiff === 0 ? 0 : pitchDiff === 1 ? 5 : pitchDiff * 10;
            })
        );

        const assignments = hungarian(cost);
        for (const [rLocal, sLocal] of assignments) {
            refined.push({
                refIdx: refIndices[rLocal],
                stuIdx: stuIndices[sLocal],
            });
        }
    }

    return refined;
}

// ---------------------------------------------------------------------------
//  Main matching function
// ---------------------------------------------------------------------------

type MatcherOptions = {
    /** Onset grouping tolerance for student notes (seconds). Default: 0.1 */
    chordTolerance?: number;
    /** Gap open penalty. Default: -0.6 */
    gapOpen?: number;
    /** Gap extend penalty. Default: -0.15 */
    gapExtend?: number;
    /** If provided, restrict search to this score-date window. */
    dateHint?: number;
    /** Size of the date window around dateHint. Default: 30000 */
    dateWindow?: number;
};

/**
 * Match a student MIDI performance to a reference MSM.
 *
 * Returns matched note pairs, unmatched reference notes (deletions),
 * unmatched student notes (insertions), and the matched score-date range.
 */
export function matchSubsequence(
    refNotes: RefNote[],
    studentNotes: StudentNote[],
    options: MatcherOptions = {},
): MatchResult {
    const {
        chordTolerance = 0.1,
        gapOpen = -0.6,
        gapExtend = -0.15,
        dateHint,
        dateWindow = 30000,
    } = options;

    if (studentNotes.length === 0 || refNotes.length === 0) {
        return { matches: [], deletions: [], insertions: studentNotes.map(s => s), range: { from: 0, to: 0 } };
    }

    // Optionally restrict reference to a date window
    let workingRef = refNotes;
    if (dateHint != null) {
        const lo = dateHint - dateWindow;
        const hi = dateHint + dateWindow;
        workingRef = refNotes.filter(n => n.date >= lo && n.date <= hi);
        if (workingRef.length === 0) workingRef = refNotes; // fallback
    }

    // Group and sort: reference by date (tolerance=0), student by onset
    const sortedRef = groupAndSort(workingRef, n => n.date, 0);
    const sortedStu = groupAndSort(studentNotes, n => n.onset, chordTolerance);

    // Run Smith-Waterman
    const alignment = smithWaterman(sortedRef, sortedStu, { gapOpen, gapExtend });

    // Extract raw matches and gaps from alignment path
    const rawMatches: Array<{ refIdx: number; stuIdx: number }> = [];
    const insertionIndices: number[] = [];
    const deletionIndices: number[] = [];

    for (const [refIdx, stuIdx] of alignment.path) {
        if (refIdx >= 0 && stuIdx >= 0) {
            rawMatches.push({ refIdx, stuIdx });
        } else if (refIdx >= 0) {
            deletionIndices.push(refIdx);
        } else if (stuIdx >= 0) {
            insertionIndices.push(stuIdx);
        }
    }

    // Refine chord matching using Hungarian algorithm
    const refinedMatches = refineChordMatching(rawMatches, sortedRef, sortedStu);

    // Filter out bad matches (pitch mismatch that slipped through)
    const goodMatches = refinedMatches.filter(m => {
        const rp = sortedRef[m.refIdx].pitch;
        const sp = sortedStu[m.stuIdx].pitch;
        // Accept exact pitch match or octave error
        return rp === sp || rp % 12 === sp % 12;
    });

    // Notes from refinedMatches that were filtered out become deletions/insertions
    const matchedRefSet = new Set(goodMatches.map(m => m.refIdx));
    const matchedStuSet = new Set(goodMatches.map(m => m.stuIdx));

    for (const m of refinedMatches) {
        if (!matchedRefSet.has(m.refIdx)) deletionIndices.push(m.refIdx);
        if (!matchedStuSet.has(m.stuIdx)) insertionIndices.push(m.stuIdx);
    }

    // Build result
    const matches: Match[] = goodMatches.map(m => ({
        ref: sortedRef[m.refIdx],
        stu: sortedStu[m.stuIdx],
    }));

    // Determine range from matched reference notes
    let rangeFrom = Infinity, rangeTo = -Infinity;
    for (const m of matches) {
        rangeFrom = Math.min(rangeFrom, m.ref.date);
        rangeTo = Math.max(rangeTo, m.ref.date);
    }
    if (!isFinite(rangeFrom)) {
        rangeFrom = 0; rangeTo = 0;
    }

    // Deletions: reference notes in the matched range that weren't matched
    const deletions: RefNote[] = [];
    const allDeletionIdxSet = new Set(deletionIndices);
    // Also find unmatched ref notes within the date range
    for (let i = 0; i < sortedRef.length; i++) {
        if (matchedRefSet.has(i)) continue;
        const n = sortedRef[i];
        if (n.date >= rangeFrom && n.date <= rangeTo) {
            deletions.push(n);
        } else if (allDeletionIdxSet.has(i)) {
            deletions.push(n);
        }
    }

    const insertions = [...new Set(insertionIndices)]
        .filter(i => !matchedStuSet.has(i))
        .map(i => sortedStu[i]);

    return { matches, deletions, insertions, range: { from: rangeFrom, to: rangeTo } };
}

// ---------------------------------------------------------------------------
//  Implant: replace reference timings with student timings
// ---------------------------------------------------------------------------

/**
 * Perform subsequence matching and implant student timings into the MSM.
 * This replaces the Python parangonar /implant endpoint.
 *
 * The take leaves here as `notes`: one `MeasuredNote` per surviving note, in
 * milliseconds (`score/measured.ts`). `studentMsm` is the same measurement in
 * the old seconds-based MSM shape, kept while the mpmify path is still wired up.
 */
export function implantLocal(
    msm: MSM,
    midi: MidiFile,
    dateHint?: number,
): { studentMsm: MSM; notes: MeasuredNote[]; range: { from: number; to: number } } {
    const studentNotes = extractNotesFromMidi(midi);
    const refNotes = extractRefNotes(msm);

    const result = matchSubsequence(refNotes, studentNotes, { dateHint });

    // Build the modified MSM
    const studentMsm = msm.deepClone();

    // Create a map from ref note id -> student note for fast lookup
    const matchMap = new Map<string, StudentNote>();
    for (const m of result.matches) {
        matchMap.set(m.ref.id, m.stu);
    }

    // Set of deleted note IDs
    const deletedIds = new Set(result.deletions.map(d => d.id));

    const { from, to } = result.range;

    // Compute time mapping at boundaries for shifting
    // Find the onset of the first and last matched notes
    let firstRefOnset = Infinity, firstStuOnset = Infinity;
    let lastRefEnd = 0, lastStuEnd = 0;
    for (const m of result.matches) {
        if (m.ref.onset < firstRefOnset) {
            firstRefOnset = m.ref.onset;
            firstStuOnset = m.stu.onset;
        }
        const refEnd = m.ref.onset + m.ref.duration;
        const stuEnd = m.stu.onset + m.stu.duration;
        if (refEnd > lastRefEnd) {
            lastRefEnd = refEnd;
            lastStuEnd = stuEnd;
        }
    }

    const headShift = firstStuOnset - firstRefOnset;
    const tailShift = lastStuEnd - lastRefEnd;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newNotes: any[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const note of studentMsm.allNotes as any[]) {
        const date = note['date'] as number;

        // Skip deleted notes in the matched range
        if (deletedIds.has(note['xml:id'])) continue;

        const stuMatch = matchMap.get(note['xml:id']);
        if (stuMatch) {
            // Implant student timings
            const implanted = { ...note };
            implanted['midi.onset'] = stuMatch.onset;
            implanted['midi.duration'] = stuMatch.duration;
            implanted['midi.velocity'] = stuMatch.velocity;
            implanted['source'] = IMPLANTED;
            newNotes.push(implanted);
        } else if (date < from) {
            // Before matched region: shift by headShift
            const shifted = { ...note };
            shifted['midi.onset'] = note['midi.onset'] + headShift;
            newNotes.push(shifted);
        } else if (date > to) {
            // After matched region: shift by tailShift
            const shifted = { ...note };
            shifted['midi.onset'] = note['midi.onset'] + tailShift;
            newNotes.push(shifted);
        } else {
            // In matched region but not matched and not deleted — keep as is
            // (This shouldn't happen often; the note might be in overlapping chords)
            newNotes.push({ ...note });
        }
    }

    studentMsm.allNotes = newNotes;
    // Output projection: seconds -> milliseconds, midi.onset/midi.duration/
    // midi.velocity -> milliseconds.date/milliseconds.date.end/velocity.
    return { studentMsm, notes: measuredNotesFromMsm({ allNotes: newNotes }), range: result.range };
}
