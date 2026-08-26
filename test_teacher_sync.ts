import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { MidiFile } from 'midifile-ts';
import { measuredNotesFromMsm } from './client/src/score/measured.ts';
import { buildTimingMap, planTeacherCues, secAtDate } from './client/src/teacherCues.ts';

const require = createRequire(import.meta.url);
const { MSM } = require('mpmify');

const makeMsm = (notes: Array<Record<string, unknown>>) =>
    new MSM(notes as any[], { numerator: 4, denominator: 4 });

const makeMidi = (): MidiFile => ({
    header: {
        format: 1,
        numTracks: 1,
        ticksPerBeat: 480,
    } as any,
    tracks: [[
        { deltaTime: 0, type: 'meta', subtype: 'setTempo', microsecondsPerBeat: 500000 },
        { deltaTime: 0, type: 'channel', subtype: 'noteOn', noteNumber: 60, velocity: 90, channel: 0 },
        { deltaTime: 240, type: 'channel', subtype: 'noteOff', noteNumber: 60, velocity: 0, channel: 0 },
        { deltaTime: 240, type: 'channel', subtype: 'noteOn', noteNumber: 62, velocity: 90, channel: 0 },
        { deltaTime: 240, type: 'channel', subtype: 'noteOff', noteNumber: 62, velocity: 0, channel: 0 },
        { deltaTime: 720, type: 'channel', subtype: 'noteOn', noteNumber: 64, velocity: 90, channel: 0 },
        { deltaTime: 240, type: 'channel', subtype: 'noteOff', noteNumber: 64, velocity: 0, channel: 0 },
    ]],
});

console.log('=== Teacher sync tests ===');

{
    const referenceMsm = makeMsm([
        { 'xml:id': 'n1', part: 1, date: 0, duration: 240, pitchname: 'c', accidentals: 0, octave: 4, 'midi.pitch': 60, 'midi.onset': 0, 'midi.duration': 0.5, 'midi.velocity': 80 },
        { 'xml:id': 'n2', part: 1, date: 720, duration: 240, pitchname: 'd', accidentals: 0, octave: 4, 'midi.pitch': 62, 'midi.onset': 1, 'midi.duration': 0.5, 'midi.velocity': 80 },
        { 'xml:id': 'n3', part: 1, date: 1440, duration: 240, pitchname: 'e', accidentals: 0, octave: 4, 'midi.pitch': 64, 'midi.onset': 2, 'midi.duration': 0.5, 'midi.velocity': 80 },
    ]);

    const timingMap = buildTimingMap(measuredNotesFromMsm(referenceMsm), makeMidi(), { from: 0, to: 1440 });
    assert.equal(timingMap.length, 3, 'timing map should track three anchor dates');
    assert.equal(timingMap[0].sec, 0);
    assert(Math.abs(secAtDate(timingMap, 1080) - 1.0) < 1e-6, 'interpolated midpoint should be 1.0s');
    console.log('PASS timing map reconstruction');
}

{
    const cues = planTeacherCues([
        {
            id: 'a',
            date: 720,
            type: 'dynamics',
            severity: 'slight',
            primaryAttr: 'volume',
            magnitude: 10,
            cueText: 'leiser',
            direction: 'less',
            refValue: 60,
            studentValue: 70,
        },
        {
            id: 'b',
            date: 1440,
            type: 'tempo',
            severity: 'large',
            primaryAttr: 'bpm',
            magnitude: 30,
            cueText: 'ruhiger',
            direction: 'less',
            refValue: 90,
            studentValue: 120,
        },
        {
            id: 'c',
            date: 2160,
            type: 'articulation',
            severity: 'mod',
            primaryAttr: 'relativeDuration',
            magnitude: 0.3,
            cueText: 'mehr Legato',
            direction: 'more',
            refValue: 1,
            studentValue: 0.6,
        },
    ], [
        { date: 0, sec: 0 },
        { date: 720, sec: 0.6 },
        { date: 1440, sec: 1.1 },
        { date: 2160, sec: 2.8 },
    ]);

    assert.deepEqual(cues.map((cue) => cue.text), ['ruhiger', 'mehr Legato']);
    console.log('PASS cue spacing prioritization');
}

console.log('All teacher sync tests passed.');
