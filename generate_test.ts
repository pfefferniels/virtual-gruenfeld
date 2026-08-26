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
 *                                            against reference.fitted.mpm  (client/src/mpm/)
 *     → counterPerformance(...)              Grünfeld pushed away from this student
 *     → /teacher-stream                      one LLM + TTS call, anchored monologue
 *     → mood chord + cue layout + ffmpeg     student first, teacher answering
 *
 * Until the espressivo-only rewrite this file carried a ~530-line private copy of the diff and
 * the exaggeration, because the client's versions could not be imported outside the browser.
 * They can now: everything below `client/src` is plain TypeScript over espressivo, so the copy
 * is gone and this script exercises the modules the app actually ships.
 *
 * Requires:
 *   - virtual-gruenfeld server (/teacher-stream) on SERVER_URL
 *   - timidity or fluidsynth + SF2_PATH (MIDI → WAV)
 *   - ffmpeg (audio concat + MP3 encoding)
 *
 * Run:  npx tsx generate_test.ts          (one scenario: SCENARIO=01_robotic npx tsx …)
 *       DRY_RUN=1 npx tsx generate_test.ts   everything up to the server call, then stop
 */

import * as fs from 'fs';
import { execSync } from 'child_process';
import 'dotenv/config';
import { performMsmToData } from 'espressivo';
import { read as readMidi, write as writeMidi } from 'midifile-ts';
import { implantLocal } from './client/src/matcher';
import { measuredNotesFromMsmText, measuredNotesFromPerformanceData, withoutUnisons } from './client/src/score/measured';
import { fallbackImmediateJudgement, summarizeImmediateJudgement, type ImmediateJudgementPayload } from './client/src/judgement';
import { buildTimingMap, secAtDate, cueDelay } from './client/src/teacherCues';
import { layoutCues } from './client/src/pipeline/teacherVocalStream';
import { appendMidiWithOffset, delayMidi, millisecondsToMidiTicks } from './client/src/pianosound/midiSequence';
import { buildJudgementMoodRenderPlan } from './client/src/pipeline/judgementMood';
import { convert, render } from './client/src/services/mpmRenderer';
import { evidenceForTake } from './client/src/mpm/evidence';
import { allDimensions, counterPerformance, studentCenter } from './client/src/mpm/counter';
import { PPQ, positionToTick } from './client/src/shared/constants';
import type { Range, StructuredDiffEvent } from './client/src/mpm/types';

/** Extra sustain-pedal hold after the correction entry point (ms). */
const JUDGEMENT_MOOD_PEDAL_BUFFER_MS = 3000;

// ── Config ──

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3002';
const BEAT = PPQ;
const MEASURE = 4 * BEAT;
/** The counter-performance's strength, `mpm/counter.ts`'s own default spelled out. */
const AGGRESSIVENESS = 0.2;
const OUT_DIR = 'test_output';
const CUE_PREP_MODE = 'balanced';
const SCENARIO_FILTER = process.env.SCENARIO?.trim();
/**
 * Stop after the counter-performance, before anything leaves the machine. Everything up to
 * that point is espressivo and this repo; past it are the teacher server, fluidsynth and
 * ffmpeg. Useful for checking the pipeline without an OpenAI key or a soundfont.
 */
const DRY_RUN = process.env.DRY_RUN === '1';

// ── Helpers ──

const assertOk = async (r: Response, label: string) => {
    if (r.ok) return;
    let text = '';
    try { text = await r.text(); } catch { /* ignore */ }
    throw new Error(`${label}: HTTP ${r.status} ${r.statusText}${text ? `: ${text}` : ''}`);
};


// ── Teacher Stream (unified vocal) ──

type TeacherStreamAnchor = { marker: string; charOffset: number; text: string };
type TeacherStreamAlignment = {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
};
type TeacherStreamResponse = {
    rawText: string;
    anchors: TeacherStreamAnchor[];
    cleanedText: string;
    audioBase64: string;
    alignment: TeacherStreamAlignment;
    model: string;
    stats: { llmMs: number; ttsMs: number; totalMs: number };
};

async function requestTeacherStream(
    judgement: ImmediateJudgementPayload,
    diff: string,
    candidates: Array<Record<string, unknown>>,
    mode: string,
): Promise<TeacherStreamResponse> {
    const res = await fetch(`${SERVER_URL}/teacher-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ judgement, diff, candidates, mode }),
    });
    await assertOk(res, '/teacher-stream');
    return res.json() as Promise<TeacherStreamResponse>;
}

type VocalChunkFile = {
    marker: string;
    text: string;
    audioPath: string;
    startSec: number;
    endSec: number;
    durationSec: number;
};

function sliceVocalStream(
    fullAudioPath: string,
    anchors: TeacherStreamAnchor[],
    alignment: TeacherStreamAlignment,
    scenarioName: string,
): VocalChunkFile[] {
    const starts = alignment.character_start_times_seconds;
    const ends = alignment.character_end_times_seconds;

    if (anchors.length === 0 || starts.length === 0) {
        // No alignment → single chunk from full audio
        const dur = audioDurationSec(fullAudioPath);
        return [{
            marker: anchors[0]?.marker ?? 'JUDGE',
            text: anchors[0]?.text ?? '',
            audioPath: fullAudioPath,
            startSec: 0,
            endSec: dur,
            durationSec: dur,
        }];
    }

    const boundaries: number[] = [];
    for (const anchor of anchors) {
        const offset = anchor.charOffset;
        if (offset < starts.length) {
            boundaries.push(starts[offset]);
        } else if (ends.length > 0) {
            boundaries.push(ends[ends.length - 1]);
        } else {
            boundaries.push(0);
        }
    }
    boundaries.push(ends.length > 0 ? ends[ends.length - 1] : 0);

    const chunks: VocalChunkFile[] = [];
    for (let i = 0; i < anchors.length; i++) {
        const startSec = boundaries[i];
        const endSec = boundaries[i + 1];
        if (endSec <= startSec) continue;

        const safeMarker = anchors[i].marker.replace(/\./g, '_');
        const audioPath = `${OUT_DIR}/${scenarioName}_chunk_${i}_${safeMarker}.mp3`;
        execSync(
            `ffmpeg -y -i "${fullAudioPath}" -ss ${startSec.toFixed(3)} -to ${endSec.toFixed(3)} -c copy "${audioPath}"`,
            { stdio: 'pipe' },
        );

        chunks.push({
            marker: anchors[i].marker,
            text: anchors[i].text,
            audioPath,
            startSec,
            endSec,
            durationSec: audioDurationSec(audioPath),
        });
    }

    return chunks;
}

const audioDurationSec = (audioPath: string): number => {
    const output = execSync(
        `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${audioPath}"`,
        { stdio: 'pipe' },
    ).toString().trim();
    const duration = Number(output);
    if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error(`Invalid duration from ffprobe for ${audioPath}`);
    }
    return duration;
};

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

function mixTeacherWithCues(
    teacherWav: string,
    cues: Array<{ id: string; atSec: number; audioPath: string }>,
    outputWav: string,
) {
    if (cues.length === 0) {
        fs.copyFileSync(teacherWav, outputWav);
        return;
    }

    const inputs = [`-i "${teacherWav}"`, ...cues.map((cue) => `-i "${cue.audioPath}"`)].join(' ');
    const delayed = cues
        .map((cue, index) => {
            const delayMs = Math.max(0, Math.round(cue.atSec * 1000));
            return `[${index + 1}:a]volume=0.55,adelay=${delayMs}|${delayMs}[cue${index}]`;
        })
        .join(';');
    const n = cues.length + 1;
    const mixInputs = ['[0:a]', ...cues.map((_, index) => `[cue${index}]`)].join('');
    const weights = [n, ...cues.map(() => n)].join(' ');
    const filter = `${delayed};${mixInputs}amix=inputs=${n}:duration=first:weights=${weights}:normalize=0[out]`;

    execSync(
        `ffmpeg -y ${inputs} -filter_complex "${filter}" -map "[out]" -c:a pcm_s16le "${outputWav}"`,
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
 * the score as MSM, Grünfeld's two documents (the editorial one every `xml:id` is read from,
 * the fitted one the comparison is made against), and one render of the editorial document
 * over the score for the matcher's reference side.
 */
console.log('Loading resources...');
const mei = fs.readFileSync('client/public/score.mei', 'utf8');
const referenceMpmText = fs.readFileSync('client/public/performance.mpm', 'utf8');
const fittedReferenceMpmText = fs.readFileSync('client/public/reference.fitted.mpm', 'utf8');

console.log('Converting MEI → MSM...');
const scoreMsm = convert(mei);

console.log('Rendering the reference for the matcher...');
const performed = measuredNotesFromPerformanceData(
    performMsmToData({ msm: scoreMsm, mpm: referenceMpmText }, { expandOrnaments: false }),
);
const scoreNotes = withoutUnisons(performed);
console.log(`  ${scoreNotes.length} notes (${performed.length - scoreNotes.length} unisons folded)`);

// Load harmonic reduction (optional — the mood chord needs it)
let reductionMei: string | undefined;
let reductionNotes: ReturnType<typeof withoutUnisons> | undefined;
try {
    reductionMei = fs.readFileSync('client/public/harmonic_reduction.mei', 'utf8');
    reductionNotes = withoutUnisons(measuredNotesFromMsmText(convert(reductionMei)));
    console.log(`  Reduction: ${reductionNotes.length} notes`);
} catch (e: any) {
    console.log(`  Harmonic reduction not available: ${e.message}`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const scenario of scenarios) {
    if (SCENARIO_FILTER && scenario.name !== SCENARIO_FILTER) continue;
    clearScenarioOutputs(scenario.name);
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  ${scenario.name}: ${scenario.description}`);
    console.log(`  Range: ${scenario.startDate}–${scenario.endDate}`);
    console.log('═'.repeat(60));

    // 1. Render student MIDI
    console.log('  [1/8] Rendering student MIDI...');
    const studentMidiBytes = render(mei, scenario.mpm, { from: scenario.startDate, to: scenario.endDate });
    if (!studentMidiBytes) throw new Error(`${scenario.name}: student render produced nothing`);
    const studentMidPath = `${OUT_DIR}/${scenario.name}_student.mid`;
    fs.writeFileSync(studentMidPath, studentMidiBytes);

    // 2. Match + implant (the same matcher the browser runs)
    console.log('  [2/8] Matching & implanting...');
    const midiFile = readMidi(studentMidiBytes);
    const dateHint = (scenario.startDate + scenario.endDate) / 2;
    const { notes, range } = implantLocal(scoreNotes, midiFile, dateHint);
    console.log(`    Implant range: [${range.from}, ${range.to}]`);

    // 3. Fit the take into Grünfeld's slots and price it against him. In the app this runs in
    //    a Web Worker (`workers/evidenceClient.ts`); here it is the same pure call, direct.
    console.log('  [3/8] Fitting the take + comparing against Grünfeld...');
    const evidence = evidenceForTake({
        notes,
        range,
        scoreMsm,
        referenceMpmText,
        fittedReferenceMpmText,
    });
    console.log(
        `    fit_ms=${Math.round(evidence.timings.fitMs)} compare_ms=${Math.round(evidence.timings.evidenceMs)}`
        + ` aggregate=${evidence.aggregateJnd.toFixed(2)} JND`
        + ` (${Math.round(evidence.subThresholdFraction * 100)}% sub-threshold)`,
    );
    console.log(`    fitted=[${evidence.filled.join(', ')}] measured=[${evidence.measuredTypes.join(', ')}]`);
    for (const { type, reason } of evidence.suppressed) console.log(`    gate closed ${type} — ${reason}`);

    const { diffSummary, structuredDiff } = evidence;
    console.log(`    ${diffSummary.split('\n')[0]}`);
    fs.writeFileSync(`${OUT_DIR}/${scenario.name}_diff.txt`, diffSummary);
    fs.writeFileSync(`${OUT_DIR}/${scenario.name}_student.mpm`, evidence.studentMpmText);

    const judgementSummary = summarizeImmediateJudgement(structuredDiff, range, {
        distanceJnd: evidence.aggregateJnd,
        subThresholdFraction: evidence.subThresholdFraction,
    });

    // 4. The counter-performance: Grünfeld's own document, pushed away from this student's
    //    levels inside the take's range and capped, with every dimension the take did not
    //    measure left alone (`mpm/counter.ts`).
    console.log('  [4/8] Shaping the counter-performance...');
    const teacherMpmXml = counterPerformance({
        referenceMpmText,
        range,
        dimensions: allDimensions(AGGRESSIVENESS),
        center: studentCenter(evidence.levels),
        events: structuredDiff,
        measured: evidence.measuredTypes,
        log: (msg) => console.log(`    ${msg}`),
    });
    fs.writeFileSync(`${OUT_DIR}/${scenario.name}_teacher.mpm`, teacherMpmXml);

    if (DRY_RUN) {
        console.log('  [5/8] DRY_RUN=1 — stopping before the teacher server.');
        continue;
    }

    // Helper: render a MIDI performance
    const renderMidi = async (
        passLabel: string,
        passMei: string,
        passRange: Range,
        opts?: { mpmXml?: string },
    ): Promise<Buffer> => {
        const bytes = render(passMei, opts?.mpmXml ?? teacherMpmXml, passRange);
        if (!bytes) throw new Error(`${scenario.name}/${passLabel}: render produced nothing`);
        const midiBytes = Buffer.from(bytes);
        fs.writeFileSync(`${OUT_DIR}/${scenario.name}_${passLabel}.mid`, midiBytes);
        return midiBytes;
    };

    // 5. Render teacher correction MIDI + request unified vocal stream in parallel
    console.log('  [5/8] Rendering teacher MIDI + requesting vocal stream...');

    // Build candidates for teacher-stream
    const positions = new Map<string, StructuredDiffEvent[]>();
    for (const event of structuredDiff) {
        const group = positions.get(event.position) ?? [];
        group.push(event);
        positions.set(event.position, group);
    }
    const candidates = Array.from(positions.entries()).map(([position, events]) => ({
        position,
        issues: events.map((event) => ({
            type: event.type,
            severity: event.severity,
            direction: event.direction,
            primaryAttr: event.primaryAttr,
            refValue: event.refValue,
            studentValue: event.studentValue,
        })),
    }));

    const [correctionBytes, teacherStreamResp] = await Promise.all([
        renderMidi('teacher', mei, range),
        requestTeacherStream(judgementSummary, diffSummary, candidates, CUE_PREP_MODE),
    ]);

    // Save vocal stream info
    const judgeAnchor = teacherStreamResp.anchors.find(a => a.marker === 'JUDGE');
    const judgementText = judgeAnchor?.text || fallbackImmediateJudgement(judgementSummary);
    fs.writeFileSync(`${OUT_DIR}/${scenario.name}_judgement.txt`, `${judgementText}\n`);
    fs.writeFileSync(`${OUT_DIR}/${scenario.name}_vocal_raw.txt`, teacherStreamResp.rawText);
    console.log(`    Vocal stream: ${teacherStreamResp.anchors.length} anchors, ` +
        `llm=${teacherStreamResp.stats.llmMs}ms, tts=${teacherStreamResp.stats.ttsMs}ms`);
    for (const anchor of teacherStreamResp.anchors) {
        console.log(`      ${anchor.marker.padEnd(8)} "${anchor.text}"`);
    }

    // Save + slice vocal audio
    let vocalChunks: VocalChunkFile[] = [];
    const fullVocalPath = `${OUT_DIR}/${scenario.name}_vocal_full.mp3`;
    if (teacherStreamResp.audioBase64) {
        fs.writeFileSync(fullVocalPath, Buffer.from(teacherStreamResp.audioBase64, 'base64'));
        vocalChunks = sliceVocalStream(
            fullVocalPath,
            teacherStreamResp.anchors,
            teacherStreamResp.alignment,
            scenario.name,
        );
        console.log(`    Sliced into ${vocalChunks.length} chunks`);
    }

    // Build timing map from correction MIDI
    const correctionMidi = readMidi(bytesOf(correctionBytes));
    const timingMap = buildTimingMap(scoreNotes, correctionMidi, range);

    // Map vocal chunks to playback times
    const judgeChunk = vocalChunks.find(c => c.marker === 'JUDGE');
    const judgeDurationSec = judgeChunk?.durationSec ?? 0;
    const JUDGE_TO_CORRECTION_BUFFER_SEC = 0.2;
    const correctionEntrySec = judgeDurationSec + JUDGE_TO_CORRECTION_BUFFER_SEC;

    // 6. Build mood chord from harmonic reduction (if available)
    console.log('  [6/8] Mood chord + cue layout...');
    let moodPlan: ReturnType<typeof buildJudgementMoodRenderPlan> = null;
    let moodBytes: Buffer | null = null;
    if (reductionMei && reductionNotes) {
        moodPlan = buildJudgementMoodRenderPlan(
            reductionNotes,
            scoreNotes,
            referenceMpmText,
            range.from,
            { minimumPedalHoldMs: correctionEntrySec * 1000 + JUDGEMENT_MOOD_PEDAL_BUFFER_MS },
        );
        if (moodPlan) {
            console.log(`    Mood chord at ${moodPlan.chordDate} (notes=${moodPlan.noteCount})...`);
            moodBytes = await renderMidi('reduction', reductionMei, moodPlan.range, { mpmXml: moodPlan.mpm });
        }
    }

    // Schedule vocal chunks using PAVA layout (optimal non-overlapping positions)
    const CUE_DELAY_DEFAULT_REGION = 2.0;
    const MIN_CUE_GAP_SEC = 0.25;
    const END_GAP_SEC = 1.5;
    const scheduledChunks: Array<{ marker: string; atSec: number; audioPath: string }> = [];

    // JUDGE is fixed at t=0
    const judgeVocal = vocalChunks.find(c => c.marker === 'JUDGE');
    if (judgeVocal) {
        scheduledChunks.push({ marker: 'JUDGE', atSec: 0, audioPath: judgeVocal.audioPath });
        console.log(`    Schedule "JUDGE" at 0.00s`);
    }

    // Collect positional cues with ideal times
    const positional = vocalChunks
        .filter(c => c.marker !== 'JUDGE' && c.marker !== 'END')
        .map(c => {
            const tick = positionToTick(c.marker);
            if (tick === null) return null;
            return { chunk: c, ideal: secAtDate(timingMap, tick) + cueDelay(CUE_DELAY_DEFAULT_REGION) + correctionEntrySec };
        })
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .sort((a, b) => a.ideal - b.ideal);

    // Build layout items (positional + END)
    const layoutItems: { chunk: VocalChunkFile; ideal: number; gapAfter: number }[] = positional.map(
        p => ({ chunk: p.chunk, ideal: p.ideal, gapAfter: MIN_CUE_GAP_SEC }),
    );
    const endVocal = vocalChunks.find(c => c.marker === 'END');
    if (endVocal) {
        if (layoutItems.length > 0) layoutItems[layoutItems.length - 1].gapAfter = END_GAP_SEC;
        const lastPos = positional[positional.length - 1];
        const endIdeal = lastPos
            ? lastPos.ideal + lastPos.chunk.durationSec + END_GAP_SEC
            : correctionEntrySec + END_GAP_SEC;
        layoutItems.push({ chunk: endVocal, ideal: endIdeal, gapAfter: 0 });
    }

    // Run PAVA layout
    if (layoutItems.length > 0) {
        const positions = layoutCues(layoutItems.map(item => ({
            ideal: item.ideal,
            duration: item.chunk.durationSec,
            gapAfter: item.gapAfter,
        })));
        for (let i = 0; i < layoutItems.length; i++) {
            const { chunk } = layoutItems[i];
            const atSec = positions[i];
            const drift = atSec - layoutItems[i].ideal;
            scheduledChunks.push({ marker: chunk.marker, atSec, audioPath: chunk.audioPath });
            console.log(`    Schedule "${chunk.marker}" at ${atSec.toFixed(2)}s (ideal=${layoutItems[i].ideal.toFixed(2)}s, drift=${drift >= 0 ? '+' : ''}${drift.toFixed(2)}s)`);
        }
    }

    // 7. MIDI → WAV → combine → MP3
    console.log('  [7/8] Combining → MP3...');
    try {
        const studentWav = `${OUT_DIR}/${scenario.name}_student.wav`;
        const teacherMidPath = `${OUT_DIR}/${scenario.name}_teacher.mid`;
        const teacherWav = `${OUT_DIR}/${scenario.name}_teacher.wav`;
        const teacherMixedWav = `${OUT_DIR}/${scenario.name}_teacher_with_vocal.wav`;

        let finalMidPath: string;
        const finalScheduledChunks = scheduledChunks;

        if (moodBytes && moodPlan) {
            const moodMidi = readMidi(bytesOf(moodBytes));
            const connectedMidi = appendMidiWithOffset(
                moodMidi,
                correctionMidi,
                millisecondsToMidiTicks(moodMidi, correctionEntrySec * 1000),
            );
            fs.writeFileSync(teacherMidPath, Buffer.from(writeMidi(connectedMidi.tracks, connectedMidi.header.ticksPerBeat)));
            finalMidPath = teacherMidPath;
            // JUDGE chunk already at 0, musical chunks already offset by correctionEntrySec
        } else {
            // No mood chord — delay correction MIDI so JUDGE narration finishes first
            const delayedMidi = delayMidi(correctionMidi, millisecondsToMidiTicks(correctionMidi, correctionEntrySec * 1000));
            fs.writeFileSync(teacherMidPath, Buffer.from(writeMidi(delayedMidi.tracks, delayedMidi.header.ticksPerBeat)));
            finalMidPath = teacherMidPath;
        }

        // Export visualization data for render_teacher_pianoroll.py
        const teacherVizBytes = fs.readFileSync(finalMidPath);
        const teacherVizMidi = readMidi(bytesOf(teacherVizBytes));
        const teacherNotes = extractMidiNoteEvents(teacherVizMidi);
        const pedalEvents = extractPedalEvents(teacherVizMidi);
        const vizData = {
            scenario: scenario.name,
            correctionEntrySec,
            hasMoodChord: !!moodPlan,
            notes: teacherNotes.map(n => ({
                ...n,
                source: n.onset < correctionEntrySec - 0.05 ? 'mood' : 'correction',
            })),
            pedal: pedalEvents,
            scheduledChunks: finalScheduledChunks.map(c => {
                const chunk = vocalChunks.find(vc => vc.marker === c.marker);
                return {
                    marker: c.marker,
                    atSec: c.atSec,
                    audioStartSec: chunk?.startSec ?? 0,
                    audioEndSec: chunk?.endSec ?? 0,
                    durationSec: chunk?.durationSec ?? 0,
                    text: chunk?.text ?? '',
                };
            }),
            vocalAudioPath: teacherStreamResp.audioBase64
                ? `${OUT_DIR}/${scenario.name}_vocal_full.mp3`
                : null,
        };
        fs.writeFileSync(
            `${OUT_DIR}/${scenario.name}_teacher_viz.json`,
            JSON.stringify(vizData, null, 2),
        );
        console.log(`    Visualization: ${scenario.name}_teacher_viz.json`);

        midiToWav(studentMidPath, studentWav);
        midiToWav(finalMidPath, teacherWav);

        // Mix vocal chunks into teacher WAV
        const vocalInputs = finalScheduledChunks.map(c => ({ id: c.marker, atSec: c.atSec, audioPath: c.audioPath }));
        mixTeacherWithCues(teacherWav, vocalInputs, teacherMixedWav);

        const mp3Path = `${OUT_DIR}/${scenario.name}.mp3`;
        combineToMp3(studentWav, teacherMixedWav, mp3Path);
        console.log(`    → ${mp3Path}`);

        for (const f of [studentWav, teacherWav, teacherMixedWav]) {
            try { fs.unlinkSync(f); } catch { /* ignore */ }
        }
    } catch (e: any) {
        console.log(`    MP3 combine failed: ${e.message}`);
        console.log('    (MIDI files are still available for manual processing)');
    }

    console.log('  [8/8] Done.');
}

// ── Summary ──

console.log(`\n${'═'.repeat(60)}`);
console.log('Done! Output files:');
const files = fs.readdirSync(OUT_DIR).sort();
for (const f of files) {
    const stat = fs.statSync(`${OUT_DIR}/${f}`);
    console.log(`  ${f} (${(stat.size / 1024).toFixed(0)} KB)`);
}
