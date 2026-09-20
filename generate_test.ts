/**
 * generate_test.ts — the whole dialogic lesson, headless, as three MP3s.
 *
 * One scenario is a deliberately mis-shaped MPM: it is rendered to MIDI, that MIDI is fed back
 * in as if a student had played it, and what comes out is what the browser would produce —
 * the same modules, in the same order, with no library in between:
 *
 *   render(score.mei, scenario.mpm)          the student, played by the renderer
 *     → implantLocal(scoreNotes, midi)       matched onto the score  (client/src/matcher.ts)
 *     → evidenceForTake(...)                 fitted into Grünfeld's own slots, then compared
 *                                            against Grünfeld fitted the same way (client/src/mpm/)
 *     → counterPerformance(...)              Grünfeld pushed away from this student
 *     → render + ffmpeg                      student first, teacher answering
 *
 * Until the espressivo-only rewrite this file carried a ~530-line private copy of the diff and
 * the exaggeration, because the client's versions could not be imported outside the browser.
 * They can now: everything below `client/src` is plain TypeScript over espressivo, so the copy
 * is gone and this script exercises the modules the app actually ships.
 *
 * Requires:
 *   - timidity or fluidsynth + SF2_PATH (MIDI → WAV)
 *   - ffmpeg (audio concat + MP3 encoding)
 *
 * Run:  npx tsx generate_test.ts          (one scenario: SCENARIO=01_robotic npx tsx …)
 *       DRY_RUN=1 npx tsx generate_test.ts   everything up to the audio tools, then stop
 */

import * as fs from 'fs';
import { execSync } from 'child_process';
import 'dotenv/config';
import { performMsmToData } from 'espressivo';
import { read as readMidi } from 'midifile-ts';
import { implantLocal } from './client/src/matcher';
import { measuredNotesFromPerformanceData, withoutUnisons } from './client/src/score/measured';
import { convert, render } from './client/src/services/mpmRenderer';
import { evidenceForTake } from './client/src/mpm/evidence';
import { allDimensions, counterPerformance } from './client/src/mpm/counter';
import { PPQ } from './client/src/shared/constants';
import type { Range } from './client/src/mpm/types';

// ── Config ──

const BEAT = PPQ;
const MEASURE = 4 * BEAT;
/** The counter-performance's strength, `mpm/counter.ts`'s own default spelled out. */
const AGGRESSIVENESS = 0.2;
const OUT_DIR = 'test_output';
const SCENARIO_FILTER = process.env.SCENARIO?.trim();
/**
 * Stop after the counter-performance, before anything leaves this repo. Everything up to that
 * point is espressivo and this repo; past it are fluidsynth and ffmpeg. Useful for checking the
 * pipeline without a soundfont.
 */
const DRY_RUN = process.env.DRY_RUN === '1';

// ── MIDI extraction for visualization ──

function buildTickToSecFn(midi: any): (tick: number) => number {
    const ppq = midi.header.ticksPerBeat;
    const tempos: Array<{ tick: number; usPerBeat: number }> = [];
    for (const track of midi.tracks) {
        let tick = 0;
        for (const event of track) {
            tick += event.deltaTime;
            if (event.type === 'meta' && event.subtype === 'setTempo') {
                tempos.push({ tick, usPerBeat: event.microsecondsPerBeat });
            }
        }
    }
    tempos.sort((a, b) => a.tick - b.tick);
    if (tempos.length === 0 || tempos[0].tick > 0) tempos.unshift({ tick: 0, usPerBeat: 500000 });

    return (target: number): number => {
        let sec = 0, prev = 0, tempo = tempos[0].usPerBeat;
        for (const tc of tempos) {
            if (tc.tick > target) break;
            if (tc.tick > prev) sec += (tc.tick - prev) * tempo / ppq / 1_000_000;
            prev = tc.tick;
            tempo = tc.usPerBeat;
        }
        return sec + (target - prev) * tempo / ppq / 1_000_000;
    };
}

function extractMidiNoteEvents(midi: any): Array<{ pitch: number; onset: number; duration: number; velocity: number }> {
    const tickToSec = buildTickToSecFn(midi);
    const notes: Array<{ pitch: number; onset: number; duration: number; velocity: number }> = [];
    for (const track of midi.tracks) {
        const pending = new Map<string, { tick: number; vel: number }>();
        let tick = 0;
        for (const event of track) {
            tick += event.deltaTime;
            if (event.type !== 'channel') continue;
            const key = `${event.channel}-${event.noteNumber}`;
            if (event.subtype === 'noteOn' && (event.velocity ?? 0) > 0) {
                pending.set(key, { tick, vel: event.velocity });
            } else if (event.subtype === 'noteOff' || (event.subtype === 'noteOn' && (event.velocity ?? 0) === 0)) {
                const on = pending.get(key);
                if (on) {
                    notes.push({
                        pitch: event.noteNumber,
                        onset: tickToSec(on.tick),
                        duration: Math.max(0.001, tickToSec(tick) - tickToSec(on.tick)),
                        velocity: on.vel,
                    });
                    pending.delete(key);
                }
            }
        }
    }
    return notes.sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
}

function extractPedalEvents(midi: any): Array<{ time: number; value: number }> {
    const tickToSec = buildTickToSecFn(midi);
    const events: Array<{ time: number; value: number }> = [];
    for (const track of midi.tracks) {
        let tick = 0;
        for (const event of track) {
            tick += event.deltaTime;
            if (event.type === 'channel' && event.subtype === 'controller' && (event.controllerType ?? 0) === 64) {
                events.push({ time: tickToSec(tick), value: event.value ?? 0 });
            }
        }
    }
    return events.sort((a, b) => a.time - b.time);
}

function resolveSoundfont(): string | null {
    const candidates = [
        process.env.SF2_PATH,
        '/Users/nielspfeffer/Downloads/Full Grand Piano.sf2',
        '/Users/nielspfeffer/.gervill/soundbank-emg.sf2',
        '/Users/nielspfeffer/Downloads/A320U.sf2',
        '/Users/nielspfeffer/Downloads/FluidR3_GS.sf2',
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

/** Convert MIDI file to WAV using timidity or fluidsynth */
function midiToWav(midiPath: string, wavPath: string) {
    try {
        execSync(`timidity "${midiPath}" -Ow -o "${wavPath}"`, { stdio: 'pipe' });
        return;
    } catch { /* timidity not found, try fluidsynth */ }

    const sf2 = resolveSoundfont();
    if (sf2) {
        execSync(`fluidsynth -ni -F "${wavPath}" -r 44100 "${sf2}" "${midiPath}"`, { stdio: 'pipe' });
        return;
    }

    throw new Error(
        'Cannot convert MIDI to audio.\n' +
        '  Install timidity: brew install timidity\n' +
        '  Or set SF2_PATH and install fluidsynth: brew install fluid-synth',
    );
}

/** Combine student WAV + teacher WAV → output MP3 */
function combineToMp3(studentWav: string, teacherWav: string, outputMp3: string) {
    execSync(
        `ffmpeg -y -i "${studentWav}" -i "${teacherWav}" ` +
        `-filter_complex "` +
        `[0:a]apad=pad_dur=2[s];` +
        `[s][1:a]concat=n=2:v=0:a=1[out]" ` +
        `-map "[out]" -codec:a libmp3lame -b:a 192k "${outputMp3}"`,
        { stdio: 'pipe' },
    );
}

/**
 * A `Buffer`'s own bytes as a plain `ArrayBuffer`, which is what `midifile-ts` reads.
 * `Buffer` is a view into a pooled allocation, so the offsets matter; and its `.buffer` is
 * typed `ArrayBuffer | SharedArrayBuffer`, which `read()` will not take.
 */
const bytesOf = (buffer: Buffer): ArrayBuffer =>
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

function clearScenarioOutputs(prefix: string) {
    if (!fs.existsSync(OUT_DIR)) return;
    for (const file of fs.readdirSync(OUT_DIR)) {
        if (!file.startsWith(`${prefix}_`) && file !== `${prefix}.mp3`) continue;
        try { fs.unlinkSync(`${OUT_DIR}/${file}`); } catch { /* ignore */ }
    }
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

// ── Scenarios ──

type Scenario = {
    name: string;
    description: string;
    startDate: number;
    endDate: number;
    mpm: string;
};

const scenarios: Scenario[] = [
    {
        name: '01_robotic',
        description: 'Robotic: constant tempo 72bpm, flat mf, legato but lifeless',
        startDate: BEAT,
        endDate: 5 * MEASURE,
        mpm: buildStudentMpm({
            tempos: [0, 720, 3600, 7200, 10800].map(d => ({ date: d, bpm: 72, transitionTo: 72 })),
            dynamics: [0, 2520, 7200, 10080].map(d => ({ date: d, volume: 70, transitionTo: 70 })),
        }),
    },
    {
        name: '02_rushing_loud',
        description: 'Rushing & loud: accelerates 80→120bpm, ff, staccato',
        startDate: 4 * MEASURE,
        endDate: 9 * MEASURE,
        mpm: buildStudentMpm({
            tempos: [
                { date: 0, bpm: 80, transitionTo: 90 },
                { date: 11520, bpm: 90, transitionTo: 100 },
                { date: 14400, bpm: 100, transitionTo: 110 },
                { date: 17280, bpm: 110, transitionTo: 115 },
                { date: 20160, bpm: 115, transitionTo: 120 },
            ],
            dynamics: [
                { date: 0, volume: 90, transitionTo: 95 },
                { date: 11520, volume: 95, transitionTo: 100 },
                { date: 14400, volume: 100, transitionTo: 105 },
                { date: 17280, volume: 105, transitionTo: 110 },
            ],
            articDef: 'staccato',
            relativeDuration: 0.4,
        }),
    },
    {
        name: '03_timid',
        description: 'Timid: very slow ~35bpm, very quiet pp, lifeless (B section)',
        startDate: 17 * MEASURE,          // B section start (unfolded mm 17)
        endDate: 21 * MEASURE,             // 4 measures of B
        mpm: buildStudentMpm({
            tempos: [
                { date: 0, bpm: 35, transitionTo: 33 },
                { date: 48960, bpm: 33, transitionTo: 36 },
                { date: 51840, bpm: 36, transitionTo: 32 },
                { date: 54720, bpm: 32, transitionTo: 34 },
            ],
            dynamics: [
                { date: 0, volume: 30, transitionTo: 28 },
                { date: 48960, volume: 28, transitionTo: 32 },
                { date: 51840, volume: 32, transitionTo: 27 },
            ],
        }),
    },
];

// ── Main ──

/**
 * Boot, from disk instead of over `fetch` — otherwise exactly `client/src/pipeline/boot.ts`:
 * the score as MSM, Grünfeld's document (the one every `xml:id` is read from), and one render
 * of it over the score for the matcher's reference side. The comparison side is not loaded: it
 * is fitted per take, from that same document, inside `evidenceForTake`.
 */
console.log('Loading resources...');
const mei = fs.readFileSync('client/public/score.mei', 'utf8');
const referenceMpmText = fs.readFileSync('client/public/performance.mpm', 'utf8');

console.log('Converting MEI → MSM...');
const scoreMsm = convert(mei);

console.log('Rendering the reference for the matcher...');
const performed = measuredNotesFromPerformanceData(
    performMsmToData({ msm: scoreMsm, mpm: referenceMpmText }, { expandOrnaments: false }),
);
const scoreNotes = withoutUnisons(performed);
console.log(`  ${scoreNotes.length} notes (${performed.length - scoreNotes.length} unisons folded)`);

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const scenario of scenarios) {
    if (SCENARIO_FILTER && scenario.name !== SCENARIO_FILTER) continue;
    clearScenarioOutputs(scenario.name);
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  ${scenario.name}: ${scenario.description}`);
    console.log(`  Range: ${scenario.startDate}–${scenario.endDate}`);
    console.log('═'.repeat(60));

    // 1. Render student MIDI
    console.log('  [1/6] Rendering student MIDI...');
    const studentMidiBytes = render(mei, scenario.mpm, { from: scenario.startDate, to: scenario.endDate });
    if (!studentMidiBytes) throw new Error(`${scenario.name}: student render produced nothing`);
    const studentMidPath = `${OUT_DIR}/${scenario.name}_student.mid`;
    fs.writeFileSync(studentMidPath, studentMidiBytes);

    // 2. Match + implant (the same matcher the browser runs)
    console.log('  [2/6] Matching & implanting...');
    const midiFile = readMidi(studentMidiBytes);
    const dateHint = (scenario.startDate + scenario.endDate) / 2;
    const { notes, range } = implantLocal(scoreNotes, midiFile, dateHint);
    console.log(`    Implant range: [${range.from}, ${range.to}]`);

    // 3. Fit the take into Grünfeld's slots and price it against him. In the app this runs in
    //    a Web Worker (`workers/evidenceClient.ts`); here it is the same pure call, direct.
    console.log('  [3/6] Fitting the take + comparing against Grünfeld...');
    const evidence = evidenceForTake({
        notes,
        range,
        scoreMsm,
        scoreNotes,
        referenceMpmText,
    });
    console.log(
        `    ref_fit_ms=${Math.round(evidence.timings.referenceFitMs)}`
        + ` fit_ms=${Math.round(evidence.timings.fitMs)} compare_ms=${Math.round(evidence.timings.evidenceMs)}`
        + ` aggregate=${evidence.aggregateJnd.toFixed(2)} JND`
        + ` (${Math.round(evidence.subThresholdFraction * 100)}% sub-threshold)`,
    );
    console.log(`    fitted=[${evidence.filled.join(', ')}] measured=[${evidence.measuredTypes.join(', ')}]`);
    for (const { type, reason } of evidence.suppressed) console.log(`    gate closed ${type} — ${reason}`);

    const { diffSummary } = evidence;
    console.log(`    ${diffSummary.split('\n')[0]}`);
    fs.writeFileSync(`${OUT_DIR}/${scenario.name}_diff.txt`, diffSummary);
    fs.writeFileSync(`${OUT_DIR}/${scenario.name}_student.mpm`, evidence.studentMpmText);

    // 4. The counter-performance: Grünfeld's own document, pushed away from this student's
    //    levels inside the take's range and capped, with every dimension the take did not
    //    measure left alone (`mpm/counter.ts`).
    console.log('  [4/6] Shaping the counter-performance...');
    const teacherMpmXml = counterPerformance({
        referenceMpmText,
        range,
        dimensions: allDimensions(AGGRESSIVENESS),
        // The pivot is the take's own paired instructions, slot by slot — not a level for the
        // whole passage. `studentCenter`/`events` went with the counter-performance rewrite
        // (`mpm/counter.ts`); `pipeline/strategies/exaggerated.ts` calls it exactly this way.
        peaks: evidence.peaks,
        measured: evidence.measuredTypes,
        log: (msg) => console.log(`    ${msg}`),
    });
    fs.writeFileSync(`${OUT_DIR}/${scenario.name}_teacher.mpm`, teacherMpmXml);

    if (DRY_RUN) {
        console.log('  [5/6] DRY_RUN=1 — stopping before the audio tools.');
        continue;
    }

    // Helper: render a MIDI performance
    const renderMidi = (passLabel: string, passMei: string, passRange: Range): Buffer => {
        const bytes = render(passMei, teacherMpmXml, passRange);
        if (!bytes) throw new Error(`${scenario.name}/${passLabel}: render produced nothing`);
        const midiBytes = Buffer.from(bytes);
        fs.writeFileSync(`${OUT_DIR}/${scenario.name}_${passLabel}.mid`, midiBytes);
        return midiBytes;
    };

    // 5. Render the teacher's answer
    console.log('  [5/6] Rendering teacher MIDI...');
    const teacherMidPath = `${OUT_DIR}/${scenario.name}_teacher.mid`;
    const correctionBytes = renderMidi('teacher', mei, range);
    const correctionMidi = readMidi(bytesOf(correctionBytes));

    // 6. MIDI → WAV → combine → MP3
    console.log('  [6/6] Combining → MP3...');
    try {
        const studentWav = `${OUT_DIR}/${scenario.name}_student.wav`;
        const teacherWav = `${OUT_DIR}/${scenario.name}_teacher.wav`;

        // Export visualization data for render_teacher_pianoroll.py
        const vizData = {
            scenario: scenario.name,
            notes: extractMidiNoteEvents(correctionMidi),
            pedal: extractPedalEvents(correctionMidi),
        };
        fs.writeFileSync(
            `${OUT_DIR}/${scenario.name}_teacher_viz.json`,
            JSON.stringify(vizData, null, 2),
        );
        console.log(`    Visualization: ${scenario.name}_teacher_viz.json`);

        midiToWav(studentMidPath, studentWav);
        midiToWav(teacherMidPath, teacherWav);

        const mp3Path = `${OUT_DIR}/${scenario.name}.mp3`;
        combineToMp3(studentWav, teacherWav, mp3Path);
        console.log(`    → ${mp3Path}`);

        for (const f of [studentWav, teacherWav]) {
            try { fs.unlinkSync(f); } catch { /* ignore */ }
        }
    } catch (e: any) {
        console.log(`    MP3 combine failed: ${e.message}`);
        console.log('    (MIDI files are still available for manual processing)');
    }
}

// ── Summary ──

console.log(`\n${'═'.repeat(60)}`);
console.log('Done! Output files:');
const files = fs.readdirSync(OUT_DIR).sort();
for (const f of files) {
    const stat = fs.statSync(`${OUT_DIR}/${f}`);
    console.log(`  ${f} (${(stat.size / 1024).toFixed(0)} KB)`);
}
