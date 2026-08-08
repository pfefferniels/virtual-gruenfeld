/**
 * visualize_implant.ts — Extract implantation data and render a piano roll PNG.
 *
 * Uses the same real pipeline as generate_test.ts:
 *   MEI → /convert → MSM → enrich → implantLocal(MSM, studentMIDI)
 *
 * Student scenario: realistic amateur — close to Grünfeld's tempo (~50 BPM)
 * but with local timing jitter, missed notes, and accidental wrong notes.
 *
 * Requires: meico at localhost:8080, python3 with matplotlib
 * Run:  npx tsx visualize_implant.ts
 */

import * as fs from 'fs';
import { execSync } from 'child_process';
import { read as readMidi, write as writeMidi } from 'midifile-ts';
import type { MidiFile } from 'midifile-ts';
import {
    implantLocal,
    extractNotesFromMidi,
    extractRefNotes,
    matchSubsequence,
    type StudentNote,
} from './client/src/matcher';

const { MSM } = await import('../mpmify/src/index.ts');

const CONVERT_URL = 'http://localhost:8080/convert';
const PERFORM_URL = 'http://localhost:8080/perform';
const PPQ = 720;
const BEAT = PPQ;
const MEASURE = 4 * BEAT;
const OUT_DIR = 'test_output';

// ── Helpers (from generate_test.ts) ──

function parseMsmNotes(msmXml: string): any[] {
    const notes: any[] = [];
    const partRegex = /<part\b[^>]*number="(\d+)"[^>]*>([\s\S]*?)<\/part>/g;
    let pm;
    while ((pm = partRegex.exec(msmXml)) !== null) {
        const partNum = parseInt(pm[1], 10);
        const noteRegex = /<note\b([^>]*)\/?>/g;
        let nm;
        while ((nm = noteRegex.exec(pm[2])) !== null) {
            const a = nm[1];
            const attr = (n: string) => {
                const re = n === 'xml:id'
                    ? /xml:id="([^"]*)"/
                    : new RegExp(`${n.replace('.', '\\.')}="([^"]*)"`);
                return a.match(re)?.[1] ?? '';
            };
            notes.push({
                'xml:id': attr('xml:id'),
                date: parseFloat(attr('date') || '0'),
                duration: parseFloat(attr('duration') || '0'),
                pitchname: attr('pitchname'),
                octave: parseInt(attr('octave') || '0', 10),
                accidentals: parseFloat(attr('accidentals') || '0'),
                'midi.pitch': parseInt(attr('midi.pitch') || '0', 10),
                part: partNum,
            });
        }
    }
    return notes.reduce((acc: any[], curr: any) => {
        const existing = acc.find(
            (n: any) => n.date === curr.date && n['midi.pitch'] === curr['midi.pitch'],
        );
        if (existing) {
            if (curr.duration > existing.duration) acc[acc.indexOf(existing)] = curr;
        } else {
            acc.push(curr);
        }
        return acc;
    }, []);
}

function enrichWithPerformanceData(notes: any[], mei: string): number {
    const recRegex = /<recording\b[^>]*source="([^"]*)"[^>]*>([\s\S]*?)<\/recording>/g;
    let matched = 0;
    let rm;
    while ((rm = recRegex.exec(mei)) !== null) {
        const wR = /<when\b([^>]*)>([\s\S]*?)<\/when>/g;
        let wm;
        while ((wm = wR.exec(rm[2])) !== null) {
            const da = wm[1].match(/data="([^"]*)"/);
            const ab = wm[1].match(/absolute="(\d+)ms"/);
            if (!da || !ab) continue;
            const ids = da[1].split(/\s+/).map(d => d.replace('#', ''));
            const onset = parseInt(ab[1], 10);
            const vel = wm[2].match(/<extData type="velocity">(\d+)<\/extData>/);
            const dur = wm[2].match(/<extData type="duration">(\d+)ms<\/extData>/);
            if (!vel || !dur) continue;
            for (const id of ids) {
                const note = notes.find((x: any) => x['xml:id'] === id);
                if (note) {
                    note['midi.onset'] = onset / 1000;
                    note['midi.duration'] = parseInt(dur[1], 10) / 1000;
                    note['midi.velocity'] = parseInt(vel[1], 10);
                    note.source = rm[1];
                    matched++;
                }
            }
        }
    }
    return matched;
}

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

console.log('Loading MEI...');
const mei = fs.readFileSync('client/public/score.mei', 'utf8');

console.log('Converting MEI → MSM via /convert...');
const convertResp = await fetch(CONVERT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mei }),
});
if (!convertResp.ok) throw new Error(`/convert: ${convertResp.status}`);
const msmXml = (await convertResp.json()).msm;

const msmNotes = parseMsmNotes(msmXml);
enrichWithPerformanceData(msmNotes, mei);
const enrichedNotes = msmNotes.filter((n: any) => typeof n['midi.onset'] === 'number');
console.log(`  ${enrichedNotes.length} enriched notes`);

const savedLog = console.log;
console.log = () => {};
const baseMsm = new MSM(enrichedNotes, { numerator: 4, denominator: 4 });
console.log = savedLog;

// Render clean student MIDI via /perform
console.log('Rendering student MIDI via /perform...');
const studentPerformResp = await fetch(PERFORM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        mei, mpm: scenario.mpm,
        from: scenario.startDate, to: scenario.endDate, ppq: PPQ,
    }),
});
if (!studentPerformResp.ok) throw new Error(`/perform: ${studentPerformResp.status}`);
const cleanMidiBytes = Buffer.from((await studentPerformResp.json()).midi_b64, 'base64');

// Parse clean MIDI → notes
const cleanMidi = readMidi(
    cleanMidiBytes.buffer.slice(
        cleanMidiBytes.byteOffset,
        cleanMidiBytes.byteOffset + cleanMidiBytes.byteLength,
    ),
);
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

// Extract ref notes and run matching
const refNotes = extractRefNotes(baseMsm);
const dateHint = (scenario.startDate + scenario.endDate) / 2;
const matchResult = matchSubsequence(refNotes, messyNotes, { dateHint });

console.log(`Match: ${matchResult.matches.length} pairs, ${matchResult.deletions.length} deletions, ${matchResult.insertions.length} insertions`);
console.log(`Range: [${matchResult.range.from}, ${matchResult.range.to}]`);

// Run implantation
const { studentMsm, range } = implantLocal(baseMsm, messyMidi, dateHint);

// Extract implanted notes
const implantedNotes = (studentMsm as any).allNotes;

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

    implantedNotes: implantedNotes.map((n: any) => ({
        id: n['xml:id'],
        pitch: n['midi.pitch'],
        date: n['date'],
        onset: n['midi.onset'],
        duration: n['midi.duration'],
        velocity: n['midi.velocity'],
        source: n['source'] || 'reference',
    })),
};

const jsonPath = `${OUT_DIR}/implant_viz_data.json`;
fs.writeFileSync(jsonPath, JSON.stringify(vizData, null, 2));
console.log(`Wrote visualization data to ${jsonPath}`);

console.log('Rendering piano roll with matplotlib...');
execSync(`python3 render_implant_pianoroll.py`, { stdio: 'inherit' });
console.log('Done!');
