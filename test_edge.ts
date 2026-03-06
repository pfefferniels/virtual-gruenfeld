/**
 * Check: does the implant service produce continuous onsets?
 * Reuses the same steps as generate_test_mp3.ts but just inspects the edge.
 */
import * as fs from 'fs';
import * as path from 'path';

const mei = fs.readFileSync('client/public/score.mei', 'utf8');
const PPQ = 720, BEAT = PPQ, MEASURE = 4 * BEAT;
const START_DATE = BEAT, END_DATE = 5 * MEASURE;

// Convert
const r1 = await fetch('http://localhost:8080/convert', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mei }),
});
const msmXml = (await r1.json()).msm;

// Parse + enrich (same as generate_test_mp3.ts)
const notes: any[] = [];
const partRegex = /<part\b[^>]*number="(\d+)"[^>]*>([\s\S]*?)<\/part>/g;
let pm;
while ((pm = partRegex.exec(msmXml)) !== null) {
    const noteRegex = /<note\b([^>]*)\/?>(?:<\/note>)?/g;
    let nm;
    while ((nm = noteRegex.exec(pm[2])) !== null) {
        const a = nm[1];
        const attr = (n: string) => {
            const re = n === 'xml:id' ? /xml:id="([^"]*)"/ : new RegExp(`${n.replace('.', '\\.')}="([^"]*)"`);
            return a.match(re)?.[1] ?? '';
        };
        notes.push({
            'xml:id': attr('xml:id'), date: parseFloat(attr('date') || '0'),
            duration: parseFloat(attr('duration') || '0'), pitchname: attr('pitchname'),
            octave: parseInt(attr('octave') || '0', 10), accidentals: parseFloat(attr('accidentals') || '0'),
            'midi.pitch': parseInt(attr('midi.pitch') || '0', 10), part: parseInt(pm[1], 10),
        });
    }
}
const recordingRegex = /<recording\b[^>]*source="([^"]*)"[^>]*>([\s\S]*?)<\/recording>/g;
let rm;
while ((rm = recordingRegex.exec(mei)) !== null) {
    const wR = /<when\b([^>]*)>([\s\S]*?)<\/when>/g;
    let wm;
    while ((wm = wR.exec(rm[2])) !== null) {
        const da = wm[1].match(/data="([^"]*)"/);
        const ab = wm[1].match(/absolute="(\d+)ms"/);
        if (!da || !ab) continue;
        const ids = da[1].split(/\s+/).map((d: string) => d.replace('#', ''));
        const onset = parseInt(ab[1], 10);
        const vel = wm[2].match(/<extData type="velocity">(\d+)<\/extData>/);
        const dur = wm[2].match(/<extData type="duration">(\d+)ms<\/extData>/);
        if (!vel || !dur) continue;
        for (const id of ids) {
            const n = notes.find((x: any) => x['xml:id'] === id);
            if (n) {
                n['midi.onset'] = onset / 1000;
                n['midi.duration'] = parseInt(dur[1], 10) / 1000;
                n['midi.velocity'] = parseInt(vel[1], 10);
                n.source = rm[1];
            }
        }
    }
}
const enriched = notes.filter((n: any) => typeof n['midi.onset'] === 'number');

// *** SIMULATE what generate_test_mp3 does: run reference mpmify first ***
// This MUTATES enrichedNotes via InsertTemporalSpread chord averaging!
const { MPM } = await import('/Users/nielspfeffer/Projects/mpm-ts/src/MPM.ts');
const { MSM, importWork } = await import('/Users/nielspfeffer/Projects/mpmify/src/index.ts');
const infoJson = fs.readFileSync('client/public/info.json', 'utf8');

console.log('Running reference mpmify (mutates enriched notes)...');
const origLog = console.log;
console.log = () => {};
const baseMsm = new MSM(enriched, { numerator: 4, denominator: 4 });
const mpm = new MPM();
const { transformers } = importWork(infoJson);
transformers.forEach((t: any) => t.run(baseMsm, mpm));
console.log = origLog;
console.log('Reference mpmify done.');

// Now enriched notes have been mutated by InsertTemporalSpread.
// Check a few notes near the boundary
const note2520 = enriched.find((n: any) => n.date === 2520);
console.log(`After ref mpmify, note at date 2520: onset=${note2520?.['midi.onset']?.toFixed(3)}`);

// Student perform + implant (same as generate_test_mp3)
const studentMpm = `<mpm><metadata></metadata><performance name="s" pulsesPerQuarter="720"><global><header><articulationStyles><styleDef name="p"><articulationDef name="s" relativeDuration="0.5" relativeVelocity="1.1"/></styleDef></articulationStyles></header><dated><tempoMap><style date="0" name.ref="p" xml:id="st"/><tempo xml:id="t0" date="0" bpm="76" beatLength="0.25" transition.to="78"/></tempoMap><dynamicsMap><style date="0" name.ref="p" xml:id="sd"/><dynamics xml:id="d0" date="0" volume="75" transition.to="78"/></dynamicsMap><articulationMap><style date="0" name.ref="p" defaultArticulation="s" xml:id="sa"/></articulationMap></dated></global></performance></mpm>`;
const r2 = await fetch('http://localhost:8080/perform', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mei, mpm: studentMpm, from: START_DATE, to: END_DATE, ppq: PPQ }),
});
const studentMidi = Buffer.from((await r2.json()).midi_b64, 'base64');

// IMPORTANT: pass enriched (which was mutated by mpmify) — same as generate_test_mp3 does
const r3 = await fetch('http://localhost:8000/implant', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        notes: enriched, midi: Array.from(studentMidi),
        date_hint: (START_DATE + END_DATE) / 2,
        date_window: (END_DATE - START_DATE) / 2 + 5000,
    }),
});
const data = await r3.json();
console.log('\nShifts:', data.debug?.implant?.shifts_sec);
console.log('Range:', data.range);

// Check edge
const sorted = [...data.notes].sort((a: any, b: any) => a.date - b.date);
console.log('\nEdge notes (date 0–4000):');
for (const n of sorted.filter((n: any) => n.date <= 4000)) {
    const src = n.source === 'implanted' ? 'STUDENT' : 'ref';
    console.log(`  date=${n.date}\tonset=${n['midi.onset']?.toFixed(3)}\tsrc=${src}`);
}

// Check max gap
let prevOnset = -1;
let maxGap = 0;
let maxGapInfo = '';
for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    if (typeof n['midi.onset'] !== 'number') continue;
    if (prevOnset >= 0) {
        const gap = n['midi.onset'] - prevOnset;
        if (gap > maxGap) {
            maxGap = gap;
            maxGapInfo = `between date=${sorted[i-1]?.date} (onset=${prevOnset.toFixed(3)}) and date=${n.date} (onset=${n['midi.onset'].toFixed(3)})`;
        }
    }
    prevOnset = n['midi.onset'];
}
console.log(`\nMax onset gap: ${maxGap.toFixed(3)}s ${maxGapInfo}`);

// Check for backwards jumps
let backwards = 0;
prevOnset = -1;
for (const n of sorted) {
    if (typeof n['midi.onset'] !== 'number') continue;
    if (prevOnset >= 0 && n['midi.onset'] < prevOnset - 0.001) {
        if (backwards < 3) console.log(`  BACKWARDS: date=${n.date} onset=${n['midi.onset'].toFixed(3)} < prev=${prevOnset.toFixed(3)}`);
        backwards++;
    }
    prevOnset = n['midi.onset'];
}
if (backwards > 0) console.log(`Total backwards jumps: ${backwards}`);
