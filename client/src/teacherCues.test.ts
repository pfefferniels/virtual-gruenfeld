import { describe, expect, it } from 'vitest';
import type { MidiFile } from 'midifile-ts';
import { MSM } from 'mpmify';
import type { StructuredDiffEvent } from './mpm';
import { buildTimingMap, pickCueCandidates, planTeacherCues, resolveTeacherCuePlan, secAtDate } from './teacherCues';

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

describe('buildTimingMap', () => {
    it('maps rendered teacher note onsets back onto score dates', () => {
        const referenceMsm = makeMsm([
            { 'xml:id': 'n1', part: 1, date: 0, duration: 240, pitchname: 'c', accidentals: 0, octave: 4, 'midi.pitch': 60, 'midi.onset': 0, 'midi.duration': 0.5, 'midi.velocity': 80 },
            { 'xml:id': 'n2', part: 1, date: 720, duration: 240, pitchname: 'd', accidentals: 0, octave: 4, 'midi.pitch': 62, 'midi.onset': 1, 'midi.duration': 0.5, 'midi.velocity': 80 },
            { 'xml:id': 'n3', part: 1, date: 1440, duration: 240, pitchname: 'e', accidentals: 0, octave: 4, 'midi.pitch': 64, 'midi.onset': 2, 'midi.duration': 0.5, 'midi.velocity': 80 },
        ]);

        const timingMap = buildTimingMap(referenceMsm, makeMidi(), { from: 0, to: 1440 });

        expect(timingMap).toHaveLength(3);
        expect(timingMap[0]).toEqual({ date: 0, sec: 0 });
        expect(timingMap[1].date).toBe(720);
        expect(timingMap[1].sec).toBeCloseTo(0.5, 6);
        expect(secAtDate(timingMap, 1080)).toBeCloseTo(1.0, 6);
    });
});

describe('planTeacherCues', () => {
    it('adapts cue selection to the strongest spaced anchors and keeps beat positions unique', () => {
        const timingMap = [
            { date: 0, sec: 0 },
            { date: 720, sec: 0.5 },
            { date: 1440, sec: 1.1 },
            { date: 2160, sec: 1.8 },
            { date: 2880, sec: 2.5 },
            { date: 3600, sec: 3.3 },
            { date: 4320, sec: 4.2 },
            { date: 5040, sec: 5.1 },
        ];
        const diffEvents: StructuredDiffEvent[] = [
            {
                id: 'a',
                date: 720,
                position: 'm1.2',
                type: 'dynamics',
                severity: 'mod',
                primaryAttr: 'volume',
                magnitude: 10,
                cueText: 'leiser',
                direction: 'less',
                refValue: 60,
                studentValue: 72,
            },
            {
                id: 'b',
                date: 1440,
                position: 'm1.3',
                type: 'tempo',
                severity: 'large',
                primaryAttr: 'bpm',
                magnitude: 28,
                cueText: 'ruhiger',
                direction: 'less',
                refValue: 88,
                studentValue: 116,
            },
            {
                id: 'c',
                date: 2160,
                position: 'm1.4',
                type: 'tempo',
                severity: 'slight',
                primaryAttr: 'transition.to',
                magnitude: 6,
                cueText: 'ruhiger',
                direction: 'less',
                refValue: 88,
                studentValue: 94,
            },
            {
                id: 'd',
                date: 4320,
                position: 'm2.3',
                type: 'articulation',
                severity: 'mod',
                primaryAttr: 'relativeDuration',
                magnitude: 0.25,
                cueText: 'mehr Legato',
                direction: 'more',
                refValue: 1,
                studentValue: 0.75,
            },
        ];

        const candidates = pickCueCandidates(diffEvents, timingMap);

        expect(candidates.map((cue) => cue.position)).toEqual(['m1.3', 'm2.3']);
        expect(candidates.map((cue) => cue.event.cueText)).toEqual(['ruhiger', 'mehr Legato']);
    });

    it('keeps the stronger cue when anchors are too close together', () => {
        const timingMap = [
            { date: 0, sec: 0 },
            { date: 720, sec: 0.6 },
            { date: 1440, sec: 1.1 },
            { date: 2160, sec: 2.8 },
        ];
        const diffEvents: StructuredDiffEvent[] = [
            {
                id: 'd1',
                date: 720,
                position: 'm1.2',
                type: 'dynamics',
                severity: 'slight',
                primaryAttr: 'volume',
                magnitude: 10,
                cueText: 'leiser',
                direction: 'less',
                refValue: 60,
                studentValue: 72,
            },
            {
                id: 'd2',
                date: 1440,
                position: 'm1.3',
                type: 'tempo',
                severity: 'large',
                primaryAttr: 'bpm',
                magnitude: 35,
                cueText: 'ruhiger',
                direction: 'less',
                refValue: 90,
                studentValue: 125,
            },
            {
                id: 'd3',
                date: 2160,
                position: 'm1.4',
                type: 'articulation',
                severity: 'mod',
                primaryAttr: 'relativeDuration',
                magnitude: 0.3,
                cueText: 'mehr Legato',
                direction: 'more',
                refValue: 1,
                studentValue: 0.6,
            },
        ];

        const cues = planTeacherCues(diffEvents, timingMap);

        expect(cues.map(cue => cue.text)).toEqual(['ruhiger', 'mehr Legato']);
        expect(cues[0].atSec).toBeCloseTo(1.02, 6);
        expect(cues[1].atSec).toBeCloseTo(2.72, 6);
    });

    it('resolves an llm-authored cue plan onto exact seconds and filters bad positions', () => {
        const timingMap = [
            { date: 0, sec: 0 },
            { date: 720, sec: 0.6 },
            { date: 1440, sec: 1.1 },
            { date: 2160, sec: 2.8 },
        ];
        const diffEvents: StructuredDiffEvent[] = [
            {
                id: 'd1',
                date: 720,
                position: 'm1.2',
                type: 'dynamics',
                severity: 'slight',
                primaryAttr: 'volume',
                magnitude: 10,
                cueText: 'leiser',
                direction: 'less',
                refValue: 60,
                studentValue: 72,
            },
            {
                id: 'd2',
                date: 1440,
                position: 'm1.3',
                type: 'tempo',
                severity: 'large',
                primaryAttr: 'bpm',
                magnitude: 35,
                cueText: 'ruhiger',
                direction: 'less',
                refValue: 90,
                studentValue: 125,
            },
            {
                id: 'd3',
                date: 2160,
                position: 'm1.4',
                type: 'articulation',
                severity: 'mod',
                primaryAttr: 'relativeDuration',
                magnitude: 0.3,
                cueText: 'mehr Legato',
                direction: 'more',
                refValue: 1,
                studentValue: 0.6,
            },
        ];

        const cues = resolveTeacherCuePlan(diffEvents, timingMap, [
            { position: 'm9.9', text: 'ignorieren' },
            { position: 'm1.3', text: 'ruhig weiter' },
            { position: 'm1.2', text: 'etwas leiser jetzt bitte' },
            { position: 'm1.4', text: 'oben mehr binden' },
        ]);

        expect(cues.map(cue => cue.text)).toEqual(['ruhig weiter', 'oben mehr binden']);
        expect(cues[0].atSec).toBeCloseTo(1.02, 6);
        expect(cues[1].atSec).toBeCloseTo(2.72, 6);
    });

    it('falls back to the default cue when llm wording is unclear or too vague', () => {
        const timingMap = [
            { date: 0, sec: 0 },
            { date: 720, sec: 0.6 },
            { date: 1440, sec: 1.1 },
        ];
        const diffEvents: StructuredDiffEvent[] = [
            {
                id: 'd1',
                date: 720,
                position: 'm1.2',
                type: 'ornament',
                severity: 'mod',
                primaryAttr: 'scale',
                magnitude: 1,
                cueText: 'oben mehr zeigen',
                direction: 'more',
                refValue: 0.2,
                studentValue: 0.1,
            },
            {
                id: 'd2',
                date: 1440,
                position: 'm1.3',
                type: 'tempo',
                severity: 'mod',
                primaryAttr: 'transition.to',
                magnitude: 20,
                cueText: 'ruhiger',
                direction: 'less',
                refValue: 90,
                studentValue: 110,
            },
        ];

        const cues = resolveTeacherCuePlan(diffEvents, timingMap, [
            { position: 'm1.2', text: 'mehr staffeln' },
            { position: 'm1.3', text: 'weniger' },
        ]);

        expect(cues.map((cue) => cue.text)).toEqual(['oben mehr zeigen']);
    });
});
