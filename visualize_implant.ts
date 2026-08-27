/**
 * visualize_implant.ts — what the matcher did with a take, as a piano roll PNG.
 *
 * The same first two steps the app runs, headless:
 *   convert(score.mei) → MSM, one render of performance.mpm over it → the reference notes
 *   render(a deliberately amateurish MPM) → MIDI → jitter, misses, wrong notes → implantLocal
 *
 * The output is `test_output/implant_viz_data.json` — reference notes, the student's messy
 * ones, the matcher's pairs, deletions and insertions, and the implanted result — which
 * `render_implant_pianoroll.py` draws. Times in that file are seconds, as the drawing expects;
 * `MeasuredNote` speaks milliseconds, and this script is the one place that converts.
 *
 * Requires: python3 with matplotlib
 * Run:  npx tsx visualize_implant.ts        (JSON only: NO_RENDER=1 npx tsx …)
 */

import * as fs from 'fs';
import { execSync } from 'child_process';
import { performMsmToData } from 'espressivo';
import { read as readMidi } from 'midifile-ts';
import type { MidiFile } from 'midifile-ts';
import {
    implantLocal,
    extractNotesFromMidi,
    refNotesFrom,
    matchSubsequence,
    type StudentNote,
} from './client/src/matcher';
import { isImplanted, measuredNotesFromPerformanceData, msToSeconds, withoutUnisons } from './client/src/score/measured';
import { convert, render } from './client/src/services/mpmRenderer';
import { PPQ } from './client/src/shared/constants';

const BEAT = PPQ;
const MEASURE = 4 * BEAT;
const OUT_DIR = 'test_output';

// ── Student MPM builder ──

function buildStudentMpm(opts: {
    tempos: Array<{ date: number; bpm: number; transitionTo: number }>;
    dynamics: Array<{ date: number; volume: number; transitionTo: number }>;
    articDef?: string;
    relativeDuration?: number;
}): string {
    const tempoEntries = opts.tempos
        .map(t =>
            `<tempo xml:id="tempo_${t.date}" date="${t.date}" bpm="${t.bpm}" ` +
            `beatLength="0.25" transition.to="${t.transitionTo}"/>`)
        .join('\n          ');
    const dynEntries = opts.dynamics
        .map(d =>
            `<dynamics xml:id="dynamics_${d.date}" date="${d.date}" ` +
            `volume="${d.volume}" transition.to="${d.transitionTo}"/>`)
        .join('\n          ');
    const artName = opts.articDef || 'legato';
    const relDur = opts.relativeDuration ?? 0.95;

    return `<mpm>
  <metadata></metadata>
  <performance name="student" pulsesPerQuarter="720">
    <global>
      <header>
        <articulationStyles>
          <styleDef name="s">
            <articulationDef name="${artName}" relativeDuration="${relDur}" relativeVelocity="1.0"/>
          </styleDef>
        </articulationStyles>
      </header>
      <dated>
        <tempoMap>
          <style date="0" name.ref="s" xml:id="st"/>
          ${tempoEntries}
        </tempoMap>
        <dynamicsMap>
          <style date="0" name.ref="s" xml:id="sd"/>
          ${dynEntries}
        </dynamicsMap>
        <articulationMap>
          <style date="0" name.ref="s" defaultArticulation="${artName}" xml:id="sa"/>
        </articulationMap>
      </dated>
    </global>
  </performance>
</mpm>`;
}

// ── MIDI post-processing: add realism ──

/** Seeded PRNG (simple xorshift) for reproducibility. */
function makeRng(seed: number) {
    let s = seed | 0 || 1;
    return () => {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;
        return (s >>> 0) / 4294967296;
    };
}

/**
 * Rebuild a MidiFile from a StudentNote[] array.
 * Single track, channel 0, TPQ = 480.
 */
function notesToMidiFile(notes: StudentNote[], tpq = 480): MidiFile {
    // Build events: tempo meta (120 BPM default), then note-on/off pairs
    const usPerBeat = 500_000; // 120 BPM
    const secToTick = (s: number) => Math.round(s * tpq * (1_000_000 / usPerBeat));

    // Collect all events with absolute tick positions
    type Ev = { tick: number; type: 'on' | 'off'; pitch: number; velocity: number };
    const events: Ev[] = [];
    for (const n of notes) {
        const onTick = secToTick(n.onset);
        const offTick = secToTick(n.onset + n.duration);
        events.push({ tick: onTick, type: 'on', pitch: n.pitch, velocity: n.velocity });
        events.push({ tick: offTick, type: 'off', pitch: n.pitch, velocity: 0 });
    }
    // Sort: by tick, then offs before ons at same tick
    events.sort((a, b) => a.tick - b.tick || (a.type === 'off' ? -1 : 1));

    // Convert to delta-time MIDI events
    const track: any[] = [];
    // Tempo meta event
    track.push({
        deltaTime: 0, type: 'meta', subtype: 'setTempo',
        microsecondsPerBeat: usPerBeat,
    });
    let lastTick = 0;
    for (const ev of events) {
        const delta = Math.max(0, ev.tick - lastTick);
        lastTick = ev.tick;
        track.push({
            deltaTime: delta,
            type: 'channel',
            channel: 0,
            subtype: ev.type === 'on' ? 'noteOn' : 'noteOff',
            noteNumber: ev.pitch,
            velocity: ev.velocity,
        });
    }
    // End-of-track
    track.push({ deltaTime: 0, type: 'meta', subtype: 'endOfTrack' });

    return {
        header: { formatType: 0, trackCount: 1, ticksPerBeat: tpq },
        tracks: [track],
    };
}

/**
 * Post-process student notes to add realistic imperfections:
 * - Timing jitter (Gaussian, σ = jitterMs)
 * - Velocity jitter
 * - Random note deletions (missRate)
 * - Random wrong notes (wrongRate): shift pitch by ±1 or ±2 semitones
 * - A few extra accidental notes (extraRate)
 */
function addImperfections(
    notes: StudentNote[],
    opts: {
        seed?: number;
        jitterSec?: number;       // timing jitter σ in seconds (default 0.035)
        velJitter?: number;       // velocity jitter ± (default 15)
        missRate?: number;        // probability of missing a note (default 0.07)
        wrongRate?: number;       // probability of wrong pitch (default 0.04)
        extraRate?: number;       // probability of adding an extra note (default 0.03)
    } = {},
): StudentNote[] {
    const {
        seed = 42,
        jitterSec = 0.035,
        velJitter = 15,
        missRate = 0.07,
        wrongRate = 0.04,
        extraRate = 0.03,
    } = opts;

    const rng = makeRng(seed);
    // Box-Muller for Gaussian
    const gauss = () => {
        const u1 = rng(), u2 = rng();
        return Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
    };

    const result: StudentNote[] = [];
    let extraCount = 0;

    for (const n of notes) {
        // Miss this note?
        if (rng() < missRate) continue;

        // Wrong pitch?
        let pitch = n.pitch;
        if (rng() < wrongRate) {
            const shift = rng() < 0.5 ? -1 : (rng() < 0.7 ? 1 : 2);
            pitch = Math.max(21, Math.min(108, pitch + shift));
        }

        // Jitter timing and velocity
        const onset = Math.max(0, n.onset + gauss() * jitterSec);
        const duration = Math.max(0.03, n.duration + gauss() * jitterSec * 0.5);
        const velocity = Math.max(10, Math.min(127,
            Math.round(n.velocity + gauss() * velJitter)));

        result.push({
            id: `s${result.length}`,
            pitch,
            onset,
            duration,
            velocity,
        });

        // Occasionally add an extra accidental note
        if (rng() < extraRate) {
            const extraPitch = pitch + (rng() < 0.5 ? -2 : 2);
            if (extraPitch >= 21 && extraPitch <= 108) {
                result.push({
                    id: `s${result.length}`,
                    pitch: extraPitch,
                    onset: onset + (rng() * 0.05),
                    duration: duration * (0.3 + rng() * 0.4),
                    velocity: Math.round(velocity * (0.4 + rng() * 0.3)),
                });
                extraCount++;
            }
        }
    }

    // Sort and re-id
    result.sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
    for (let i = 0; i < result.length; i++) result[i].id = `s${i}`;

    console.log(`  Imperfections: ${notes.length - result.length + extraCount} missed, ` +
        `${extraCount} extra, timing jitter ±${(jitterSec * 1000).toFixed(0)}ms`);
    return result;
}

// ── Scenario: realistic amateur ──

const scenario = {
    name: '04_realistic',
    description: 'Realistic amateur: ~50 BPM with rubato, jitter, missed & wrong notes',
    startDate: 4 * MEASURE,
    endDate: 9 * MEASURE,
    mpm: buildStudentMpm({
        // Gentle rubato around 50-54 BPM (close to Grünfeld's ~50 BPM)
        tempos: [
            { date: 0,     bpm: 52, transitionTo: 50 },
            { date: 11520, bpm: 50, transitionTo: 54 },   // slight push
            { date: 14400, bpm: 54, transitionTo: 48 },   // pull back
            { date: 17280, bpm: 48, transitionTo: 52 },   // recover
            { date: 20160, bpm: 52, transitionTo: 50 },   // settle
        ],
        dynamics: [
            { date: 0,     volume: 60, transitionTo: 65 },
            { date: 11520, volume: 65, transitionTo: 58 },
            { date: 14400, volume: 58, transitionTo: 68 },
            { date: 17280, volume: 68, transitionTo: 62 },
        ],
        // Normal legato
        articDef: 'legato',
        relativeDuration: 0.9,
    }),
};
// ── Main pipeline ──

console.log('Loading score + Grünfeld’s performance...');
const mei = fs.readFileSync('client/public/score.mei', 'utf8');
const referenceMpmText = fs.readFileSync('client/public/performance.mpm', 'utf8');

console.log('Converting MEI → MSM...');
const scoreMsm = convert(mei);

// The matcher's reference side, exactly as `pipeline/boot.ts` builds it: what Grünfeld's
// document *sounds* like over the score, with the unisons a piano score writes twice folded.
const scoreNotes = withoutUnisons(measuredNotesFromPerformanceData(
    performMsmToData({ msm: scoreMsm, mpm: referenceMpmText }, { expandOrnaments: false }),
));
console.log(`  ${scoreNotes.length} reference notes`);

// Render clean student MIDI
console.log('Rendering student MIDI...');
const cleanMidiBytes = render(mei, scenario.mpm, { from: scenario.startDate, to: scenario.endDate });
if (!cleanMidiBytes) throw new Error('render: nothing to play');

// Parse clean MIDI → notes
const cleanMidi = readMidi(cleanMidiBytes);
const cleanNotes = extractNotesFromMidi(cleanMidi);
console.log(`  Clean student notes: ${cleanNotes.length}`);

// Add realistic imperfections
console.log('Adding imperfections...');
const messyNotes = addImperfections(cleanNotes, {
    seed: 12345,
    jitterSec: 0.035,
    velJitter: 12,
    missRate: 0.07,
    wrongRate: 0.04,
    extraRate: 0.03,
});
console.log(`  Messy student notes: ${messyNotes.length}`);

// Rebuild MIDI file from messy notes
const messyMidi = notesToMidiFile(messyNotes);

// Extract ref notes and run matching. `matchSubsequence` is run separately from `implantLocal`
// only to report its pairs and gaps — the implant runs it again on the same input.
const refNotes = refNotesFrom(scoreNotes);
const dateHint = (scenario.startDate + scenario.endDate) / 2;
const matchResult = matchSubsequence(refNotes, messyNotes, { dateHint });

console.log(`Match: ${matchResult.matches.length} pairs, ${matchResult.deletions.length} deletions, ${matchResult.insertions.length} insertions`);
console.log(`Range: [${matchResult.range.from}, ${matchResult.range.to}]`);

// Run implantation
const { notes: implantedNotes, range } = implantLocal(scoreNotes, messyMidi, dateHint);

// Build visualization data
const vizData = {
    scenario: scenario.name,
    description: scenario.description,
    range: { from: range.from, to: range.to },
    ppq: PPQ,
    measure: MEASURE,

    refNotes: refNotes.map(n => ({
        id: n.id, pitch: n.pitch, date: n.date,
        onset: n.onset, duration: n.duration, velocity: n.velocity,
    })),

    studentNotes: messyNotes.map(n => ({
        id: n.id, pitch: n.pitch,
        onset: n.onset, duration: n.duration, velocity: n.velocity,
    })),

    matches: matchResult.matches.map(m => ({
        refId: m.ref.id, stuId: m.stu.id,
        refPitch: m.ref.pitch, stuPitch: m.stu.pitch,
        refDate: m.ref.date,
        refOnset: m.ref.onset, stuOnset: m.stu.onset,
        refDuration: m.ref.duration, stuDuration: m.stu.duration,
    })),

    deletions: matchResult.deletions.map(d => ({
        id: d.id, pitch: d.pitch, date: d.date, onset: d.onset, duration: d.duration,
    })),

    insertions: matchResult.insertions.map(s => ({
        id: s.id, pitch: s.pitch, onset: s.onset, duration: s.duration,
    })),

    implantedNotes: implantedNotes.map(n => ({
        id: n['xml:id'],
        pitch: n['midi.pitch'],
        date: n.date,
        onset: msToSeconds(n['milliseconds.date']),
        duration: msToSeconds(n['milliseconds.date.end'] - n['milliseconds.date']),
        velocity: n.velocity,
        source: isImplanted(n) ? 'implanted' : 'reference',
    })),
};

const jsonPath = `${OUT_DIR}/implant_viz_data.json`;
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(jsonPath, JSON.stringify(vizData, null, 2));
console.log(`Wrote visualization data to ${jsonPath}`);

if (process.env.NO_RENDER === '1') {
    console.log('NO_RENDER=1 — skipping matplotlib.');
} else {
    console.log('Rendering piano roll with matplotlib...');
    execSync(`python3 render_implant_pianoroll.py`, { stdio: 'inherit' });
    console.log('Done!');
}
