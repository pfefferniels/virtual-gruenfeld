/**
 * Full end-to-end pipeline test → MP3
 *
 * 1. MEI → /convert → MSM
 * 2. MSM → mpmify → reference MPM
 * 3. Modify reference MPM to simulate a student → /perform → student MIDI
 * 4. Student MIDI + MSM notes → /implant → student MSM (with implanted performance data)
 * 5. Student MSM → mpmify → student MPM
 * 6. diff(referenceMPM, studentMPM, range)
 * 7. exaggerate(referenceMPM.clone(), studentMPM, range)
 * 8. Exaggerated MPM → /perform → teacher MIDI
 * 9. Save student.mid + teacher.mid → Java MidiToMp3 → MP3
 *
 * Run:  npx tsx generate_test_mp3.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const { MPM } = await import('/Users/nielspfeffer/Projects/mpm-ts/src/MPM.ts');
const { exportMPM } = await import('/Users/nielspfeffer/Projects/mpm-ts/src/Serialization.ts');
const { MSM, importWork } = await import('/Users/nielspfeffer/Projects/mpmify/src/index.ts');

type MPM = InstanceType<typeof MPM>;
type MSM = InstanceType<typeof MSM>;

// ── Config ──
const CONVERT_URL = 'http://localhost:8080/convert';
const PERFORM_URL = 'http://localhost:8080/perform';
const IMPLANT_URL = 'http://localhost:8000/implant';

const MEI_PATH = path.resolve('client/public/score.mei');
const INFO_PATH = path.resolve('client/public/info.json');

const PPQ = 720;
const BEAT = PPQ;
const MEASURE = 4 * BEAT;

// Region: measures 2–5 (skip the pickup)
const START_DATE = BEAT;
const END_DATE = 5 * MEASURE;

// ── Helpers ──

const assertOk = async (r: Response) => {
    if (r.ok) return;
    let text = '';
    try { text = await r.text(); } catch { /* ignore */ }
    throw new Error(`HTTP ${r.status} ${r.statusText}${text ? `: ${text}` : ''}`);
};

const mpmify = (msm: MSM, infoJson: any): MPM => {
    const mpm = new MPM();
    const { transformers } = importWork(infoJson);
    transformers.forEach((transformer: any) => {
        transformer.run(msm, mpm);
    });
    return mpm;
};

const THRESHOLDS: Record<string, number> = {
    volume: 4, bpm: 4, "transition.to": 4,
    relativeDuration: 0.05, relativeVelocity: 0.05,
    intensity: 0.1, scale: 0.1, "milliseconds.offset": 5, frameLength: 50,
};

const ATTRS_TO_COMPARE: Record<string, string[]> = {
    dynamics: ['volume', 'transition.to'],
    tempo: ['bpm', 'transition.to'],
    articulation: ['relativeDuration', 'relativeVelocity'],
    rubato: ['intensity', 'frameLength'],
    ornament: ['scale', 'intensity'],
    asynchrony: ['milliseconds.offset'],
    accentuationPattern: ['scale'],
};

const diff = (mpm1: MPM, mpm2: MPM, range: { from: number; to: number }, topN = 10): string => {
    const inRange = (i: any) => {
        const date = i.date ?? i["date"];
        return typeof date === 'number' && date >= range.from && date <= range.to;
    };

    const allInstructions = mpm1.getInstructions().filter(inRange);
    const idx = new Map<string, any>();
    for (const i of mpm2.getInstructions()) {
        idx.set(`${i.type}::${i["xml:id"]}`, i);
    }

    const peaks: any[] = [];

    for (const inst of allInstructions) {
        const corresp = idx.get(`${inst.type}::${inst["xml:id"]}`);
        if (!corresp) continue;

        const attrs = ATTRS_TO_COMPARE[inst.type];
        if (!attrs) continue;

        const diffs: Record<string, any> = {};
        let magnitude = 0;
        let hasSignificant = false;

        for (const attr of attrs) {
            const refVal = inst[attr];
            const studentVal = corresp[attr];
            if (typeof refVal !== 'number' || typeof studentVal !== 'number') continue;

            const delta = studentVal - refVal;
            if (Math.abs(delta) >= (THRESHOLDS[attr] ?? 0)) hasSignificant = true;

            diffs[attr] = { ref: refVal, student: studentVal, delta };
            magnitude += Math.abs(delta);
        }

        if (!hasSignificant || Object.keys(diffs).length === 0) continue;
        peaks.push({ id: inst["xml:id"], type: inst.type, diffs, magnitude });
    }

    peaks.sort((a, b) => b.magnitude - a.magnitude);
    const top = peaks.slice(0, topN);
    if (top.length === 0) return "No significant differences found.";

    const lines = top.map(p => {
        const parts = Object.entries(p.diffs).map(([attr, { ref, student, delta }]: any) =>
            `${attr}: ${ref.toFixed(1)}→${student.toFixed(1)} (${delta > 0 ? '+' : ''}${delta.toFixed(1)})`
        ).join(', ');
        return `[${p.type}] ${p.id}: ${parts}`;
    });
    return `Top ${top.length} differences (ref→student):\n${lines.join('\n')}`;
};

const logExaggerate = (ref: number, student: number, aggressiveness: number, min: number, max: number): number => {
    if (student <= 0 || ref <= 0) return ref;
    const ratio = ref / student;
    return Math.max(min, Math.min(max, ref * Math.pow(ratio, aggressiveness)));
};

const EXAGGERATION_SPEC: Record<string, Array<{ attr: string; min: number; max: number }>> = {
    dynamics: [{ attr: 'volume', min: 1, max: 127 }, { attr: 'transition.to', min: 1, max: 127 }],
    tempo: [{ attr: 'bpm', min: 10, max: 300 }, { attr: 'transition.to', min: 10, max: 300 }],
    articulation: [{ attr: 'relativeDuration', min: 0.1, max: 5 }, { attr: 'relativeVelocity', min: 0.1, max: 5 }],
    rubato: [{ attr: 'intensity', min: 0.01, max: 10 }],
    ornament: [{ attr: 'scale', min: 0.1, max: 20 }],
    asynchrony: [{ attr: 'milliseconds.offset', min: -500, max: 500 }],
    accentuationPattern: [{ attr: 'scale', min: 0, max: 10 }],
};

const exaggerate = (mpm1: MPM, mpm2: MPM, range: { from: number; to: number }, aggressiveness = 1.2) => {
    const inRange = (i: any) => {
        const date = i.date ?? i["date"];
        return typeof date === 'number' && date >= range.from && date <= range.to;
    };

    const allInstructions = mpm1.getInstructions().filter(inRange);
    const idx = new Map<string, any>();
    for (const i of mpm2.getInstructions()) {
        idx.set(`${i.type}::${i["xml:id"]}`, i);
    }

    let changes = 0;
    for (const inst of allInstructions) {
        const corresp = idx.get(`${inst.type}::${inst["xml:id"]}`);
        if (!corresp) continue;

        const specs = EXAGGERATION_SPEC[inst.type];
        if (!specs) continue;

        let changed = false;
        for (const { attr, min, max } of specs) {
            const refVal = inst[attr];
            const studentVal = corresp[attr];
            if (typeof refVal !== 'number' || typeof studentVal !== 'number') continue;

            if (inst.type === 'asynchrony') {
                const delta = studentVal - refVal;
                inst[attr] = Math.max(min, Math.min(max, refVal - delta * aggressiveness));
            } else {
                inst[attr] = logExaggerate(refVal, studentVal, aggressiveness, min, max);
            }
            changed = true;
        }
        if (changed) changes++;
    }
    return changes;
};

// ── Step 1: Load MEI, info.json, reference MPM ──

console.log('Step 1: Loading resources...');
const mei = fs.readFileSync(MEI_PATH, 'utf8');
const infoJson = fs.readFileSync(INFO_PATH, 'utf8');


// ── Step 2: MEI → MSM via /convert ──

console.log('Step 2: Converting MEI to MSM via /convert...');
const convertResp = await fetch(CONVERT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mei }),
});
await assertOk(convertResp);
const msmXml = (await convertResp.json()).msm;

// Parse MSM notes using regex (avoids XML parser dependency)
const parseNotesFromMsm = (xml: string) => {
    const ppqMatch = xml.match(/pulsesPerQuarter="(\d+)"/);
    const ppq = ppqMatch ? parseFloat(ppqMatch[1]) : 720;
    const notes: any[] = [];

    // Match each <part> and extract its number
    const partRegex = /<part\b[^>]*number="(\d+)"[^>]*>([\s\S]*?)<\/part>/g;
    let partMatch;
    while ((partMatch = partRegex.exec(xml)) !== null) {
        const partNum = parseInt(partMatch[1], 10);
        const partContent = partMatch[2];

        // Match each <note> within this part
        const noteRegex = /<note\b([^>]*)\/?>(?:<\/note>)?/g;
        let noteMatch;
        while ((noteMatch = noteRegex.exec(partContent)) !== null) {
            const attrs = noteMatch[1];
            const attr = (name: string) => {
                // Handle xml:id specially
                const re = name === 'xml:id'
                    ? /xml:id="([^"]*)"/
                    : new RegExp(`${name.replace('.', '\\.')}="([^"]*)"`);
                const m = attrs.match(re);
                return m ? m[1] : '';
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
    return { notes, ppq };
};

const { notes: msmNotes, ppq } = parseNotesFromMsm(msmXml);
console.log(`  MSM: ${msmNotes.length} notes, ppq=${ppq}`);

// Enrich MSM notes with real performance data from MEI <when> elements
// (replicates what asMSM does in the browser)
const enrichWithPerformanceData = (notes: any[], meiXml: string) => {
    // Parse all <when> elements: extract data="#noteId", absolute, velocity, duration
    const whenRegex = /<when\b([^>]*)>([\s\S]*?)<\/when>/g;
    const performanceMap = new Map<string, { onset: number; duration: number; velocity: number; source: string }>();

    // Find recording sources
    const recordingRegex = /<recording\b[^>]*source="([^"]*)"[^>]*>([\s\S]*?)<\/recording>/g;
    let recordingMatch;
    while ((recordingMatch = recordingRegex.exec(meiXml)) !== null) {
        const source = recordingMatch[1];
        const recordingContent = recordingMatch[2];

        const innerWhenRegex = /<when\b([^>]*)>([\s\S]*?)<\/when>/g;
        let whenMatch;
        while ((whenMatch = innerWhenRegex.exec(recordingContent)) !== null) {
            const attrs = whenMatch[1];
            const content = whenMatch[2];

            const dataMatch = attrs.match(/data="([^"]*)"/);
            const absoluteMatch = attrs.match(/absolute="(\d+)ms"/);
            if (!dataMatch || !absoluteMatch) continue;

            // data can contain multiple note refs like "#id1 #id2"
            const noteIds = dataMatch[1].split(/\s+/).map(d => d.replace('#', ''));
            const onset = parseInt(absoluteMatch[1], 10);

            const velocityMatch = content.match(/<extData type="velocity">(\d+)<\/extData>/);
            const durationMatch = content.match(/<extData type="duration">(\d+)ms<\/extData>/);
            if (!velocityMatch || !durationMatch) continue;

            const velocity = parseInt(velocityMatch[1], 10);
            const duration = parseInt(durationMatch[1], 10);

            for (const noteId of noteIds) {
                performanceMap.set(noteId, {
                    onset: onset / 1000,       // ms → seconds
                    duration: duration / 1000,  // ms → seconds
                    velocity,
                    source,
                });
            }
        }
    }

    let matched = 0;
    for (const note of notes) {
        const perf = performanceMap.get(note['xml:id']);
        if (perf) {
            note['midi.onset'] = perf.onset;
            note['midi.duration'] = perf.duration;
            note['midi.velocity'] = perf.velocity;
            note.source = perf.source;
            matched++;
        }
    }
    return matched;
};

const matched = enrichWithPerformanceData(msmNotes, mei);
console.log(`  Enriched ${matched}/${msmNotes.length} notes with real performance data from MEI`);

// Only keep notes that have performance data (same filter as asMSM)
const enrichedNotes = msmNotes.filter(n => typeof n['midi.onset'] === 'number');
console.log(`  ${enrichedNotes.length} notes with performance data`);

// Deep-copy notes before mpmify mutates them (InsertTemporalSpread
// averages chord onsets, shiftToFirstOnset shifts all onsets to 0).
// We need the original onsets for the implant call.
const notesForImplant = enrichedNotes.map((n: any) => ({ ...n }));

const baseMsm = new MSM(enrichedNotes, { numerator: 4, denominator: 4 });

// ── Step 3: Build reference MPM via mpmify ──

console.log('Step 3: Building reference MPM via mpmify...');
const referenceMpm = mpmify(baseMsm, infoJson);
const refInstructions = referenceMpm.getInstructions();
const instructionCounts: Record<string, number> = {};
for (const i of refInstructions) {
    instructionCounts[i.type] = (instructionCounts[i.type] || 0) + 1;
}
console.log(`  Reference MPM: ${refInstructions.length} instructions`, instructionCounts);
const ornamentDefs = referenceMpm.getDefinitions('ornamentDef');
console.log(`  OrnamentDefs: ${ornamentDefs.length}`);

// ── Step 4: Generate student MIDI via /perform with a from-scratch MPM ──
// A genuinely different interpretation: the student plays mechanically loud,
// fast, staccato, with no rubato and no arpeggiation — a typical "student"
// who reads the notes but misses the expressive nuance.

console.log('Step 4: Building student MPM from scratch...');

const studentInterpretationMpm = `
<mpm>
  <metadata></metadata>
  <performance name="student_interpretation" pulsesPerQuarter="720">
    <global>
      <header>
        <articulationStyles>
          <styleDef name="performance_style">
            <articulationDef name="student_staccato" relativeDuration="0.5" relativeVelocity="1.1"/>
          </styleDef>
        </articulationStyles>
      </header>
      <dated>
        <tempoMap>
          <style date="0" name.ref="performance_style" xml:id="style_tempo"/>
          <tempo xml:id="tempo_0" date="0" bpm="76" beatLength="0.25" transition.to="76"/>
          <tempo xml:id="tempo_720" date="720" bpm="76" beatLength="0.25" transition.to="78"/>
          <tempo xml:id="tempo_3600" date="3600" bpm="78" beatLength="0.25" transition.to="80"/>
          <tempo xml:id="tempo_5760" date="5760" bpm="80" beatLength="0.25" transition.to="78"/>
          <tempo xml:id="tempo_7200" date="7200" bpm="78" beatLength="0.25" transition.to="76"/>
          <tempo xml:id="tempo_9360" date="9360" bpm="76" beatLength="0.25" transition.to="80"/>
          <tempo xml:id="tempo_10800" date="10800" bpm="80" beatLength="0.25" transition.to="76"/>
        </tempoMap>
        <dynamicsMap>
          <style date="0" name.ref="performance_style" xml:id="style_dyn"/>
          <dynamics xml:id="dynamics_0" date="0" volume="75" transition.to="75"/>
          <dynamics xml:id="dynamics_2520" date="2520" volume="75" transition.to="78"/>
          <dynamics xml:id="dynamics_3600" date="3600" volume="78" transition.to="80"/>
          <dynamics xml:id="dynamics_5760" date="5760" volume="80" transition.to="75"/>
          <dynamics xml:id="dynamics_7200" date="7200" volume="75" transition.to="78"/>
          <dynamics xml:id="dynamics_10080" date="10080" volume="78" transition.to="80"/>
          <dynamics xml:id="dynamics_12240" date="12240" volume="80" transition.to="75"/>
        </dynamicsMap>
        <articulationMap>
          <style date="0" name.ref="performance_style" defaultArticulation="student_staccato" xml:id="style_artic"/>
        </articulationMap>
      </dated>
    </global>
  </performance>
</mpm>`.trim();

console.log('  Student interpretation: metronomic tempo ~76-80 bpm, loud mf ~75-80, staccato, no rubato, no arpeggiation');
console.log('Step 4b: Rendering student MIDI via /perform...');

const studentPerformResp = await fetch(PERFORM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        mei, mpm: studentInterpretationMpm,
        from: START_DATE, to: END_DATE, ppq: PPQ,
    }),
});
await assertOk(studentPerformResp);
const studentMidiB64 = (await studentPerformResp.json()).midi_b64;
const studentMidiBytes = Buffer.from(studentMidiB64, 'base64');
fs.writeFileSync('student.mid', studentMidiBytes);
console.log(`  Student MIDI: ${studentMidiBytes.length} bytes → student.mid`);

// ── Step 5: Implant student MIDI into MSM via /implant ──

console.log('Step 5: Implanting student MIDI via /implant...');
const dateHint = (START_DATE + END_DATE) / 2;
const dateWindow = (END_DATE - START_DATE) / 2 + 5000;

const implantResp = await fetch(IMPLANT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        notes: notesForImplant,
        midi: Array.from(studentMidiBytes),
        date_hint: dateHint,
        date_window: dateWindow,
    }),
});
await assertOk(implantResp);
const implantData = await implantResp.json();
const range = implantData.range;
console.log(`  Implant range: [${range.from}, ${range.to}]`);
console.log(`  Implanted notes: ${implantData.notes.length}`);

const debug = implantData.debug?.implant?.implant_effects ?? {};
console.log(`  Matched: ${debug.kept_matched_in_region ?? '?'}, Dropped: ${debug.dropped_in_region_unmatched ?? '?'}`);

// ── Step 6: Create student MSM + mpmify → student MPM ──

console.log('Step 6: Building student MPM via mpmify...');
// The implant service now applies head_shift_dt to pre-region notes,
// ensuring onset continuity at the boundary. No client-side fix needed.
const studentMsm = baseMsm.deepClone();
studentMsm.allNotes = implantData.notes;
const studentMpm = mpmify(studentMsm, infoJson);
console.log(`  Student MPM: ${studentMpm.getInstructions().length} instructions`);

// ── Step 7: diff ──

console.log('\nStep 7: Diffing reference vs student MPM...');
const diffResult = diff(referenceMpm, studentMpm, range);
console.log(diffResult);

// ── Step 8: Exaggerate reference MPM ──

const AGGRESSIVENESS = 0.4;
console.log(`\nStep 8: Exaggerating reference MPM (log-ratio, aggressiveness=${AGGRESSIVENESS})...`);
const teacherMpm = referenceMpm.clone();
const numChanges = exaggerate(teacherMpm, studentMpm, range, AGGRESSIVENESS);
console.log(`  Exaggerated ${numChanges} instructions`);

// ── Step 9: Render teacher MIDI via /perform with exaggerated MPM ──

console.log('Step 9: Rendering teacher MIDI via /perform...');
const teacherMpmXml = exportMPM(teacherMpm);
const teacherPerformResp = await fetch(PERFORM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        mei, mpm: teacherMpmXml,
        from: range.from, to: range.to, ppq: PPQ,
    }),
});
await assertOk(teacherPerformResp);
const teacherMidiB64 = (await teacherPerformResp.json()).midi_b64;
const teacherMidiBytes = Buffer.from(teacherMidiB64, 'base64');
fs.writeFileSync('teacher.mid', teacherMidiBytes);
console.log(`  Teacher MIDI: ${teacherMidiBytes.length} bytes → teacher.mid`);

// ── Step 10: Convert to MP3 via Java/meico ──

console.log('\nStep 10: Rendering MP3 via meico...');
import { execSync } from 'child_process';
try {
    const output = execSync(
        `java --add-opens java.desktop/com.sun.media.sound=ALL-UNNAMED ` +
        `-cp ${process.env.HOME}/Projects/mpm-renderer/externals/meico.jar:. ` +
        `MidiToMp3 student.mid teacher.mid student_teacher.mp3 2000`,
        { encoding: 'utf8', stdio: 'pipe' }
    );
    console.log(output);
} catch (e: any) {
    console.error('Java render failed:', e.stderr || e.message);
    console.log('Falling back to symusic + ffmpeg...');
    execSync('python3 generate_mp3.py', { stdio: 'inherit' });
}

console.log('\nDone! Listen to student_teacher.mp3');
