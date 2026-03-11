import { describe, expect, it } from 'vitest';
import { MPM } from 'mpm-ts';
import { MSM } from 'mpmify';
import { reprojectSilentOnsets, sanitizeTempoInstructions, TempoTransformerOptions } from './tempoSafety';

const makeMsm = (notes: Array<Record<string, unknown>>) =>
    new MSM(notes as any[], { numerator: 4, denominator: 4 });

describe('reprojectSilentOnsets', () => {
    it('maps reference silent anchors into student time', () => {
        const referenceMsm = makeMsm([
            { 'xml:id': 'n1', part: 1, date: 0, duration: 240, pitchname: 'c', accidentals: 0, octave: 4, 'midi.pitch': 60, 'midi.onset': 0, 'midi.duration': 0.5, 'midi.velocity': 80 },
            { 'xml:id': 'n2', part: 1, date: 720, duration: 240, pitchname: 'd', accidentals: 0, octave: 4, 'midi.pitch': 62, 'midi.onset': 1, 'midi.duration': 0.5, 'midi.velocity': 80 },
            { 'xml:id': 'n3', part: 1, date: 1440, duration: 240, pitchname: 'e', accidentals: 0, octave: 4, 'midi.pitch': 64, 'midi.onset': 2, 'midi.duration': 0.5, 'midi.velocity': 80 },
        ]);

        const studentMsm = makeMsm([
            { 'xml:id': 'n1', part: 1, date: 0, duration: 240, pitchname: 'c', accidentals: 0, octave: 4, 'midi.pitch': 60, 'midi.onset': 10, 'midi.duration': 0.5, 'midi.velocity': 80, source: 'implanted' },
            { 'xml:id': 'n2', part: 1, date: 720, duration: 240, pitchname: 'd', accidentals: 0, octave: 4, 'midi.pitch': 62, 'midi.onset': 11.5, 'midi.duration': 0.5, 'midi.velocity': 80, source: 'implanted' },
            { 'xml:id': 'n3', part: 1, date: 1440, duration: 240, pitchname: 'e', accidentals: 0, octave: 4, 'midi.pitch': 64, 'midi.onset': 14, 'midi.duration': 0.5, 'midi.velocity': 80, source: 'implanted' },
        ]);

        const options: TempoTransformerOptions = {
            from: 0,
            to: 1440,
            scope: 'global',
            silentOnsets: [{ date: 1080, onset: 1.5 }],
        };

        const projected = reprojectSilentOnsets(options, referenceMsm, studentMsm);

        expect(projected).toHaveLength(1);
        expect(projected[0].date).toBe(1080);
        expect(projected[0].onset).toBeCloseTo(2.75, 6);
    });

    it('drops anchors that would invert the local student timeline', () => {
        const referenceMsm = makeMsm([
            { 'xml:id': 'n1', part: 1, date: 0, duration: 240, pitchname: 'c', accidentals: 0, octave: 4, 'midi.pitch': 60, 'midi.onset': 0, 'midi.duration': 0.5, 'midi.velocity': 80 },
            { 'xml:id': 'n2', part: 1, date: 720, duration: 240, pitchname: 'd', accidentals: 0, octave: 4, 'midi.pitch': 62, 'midi.onset': 1, 'midi.duration': 0.5, 'midi.velocity': 80 },
            { 'xml:id': 'n3', part: 1, date: 1440, duration: 240, pitchname: 'e', accidentals: 0, octave: 4, 'midi.pitch': 64, 'midi.onset': 2, 'midi.duration': 0.5, 'midi.velocity': 80 },
        ]);

        const studentMsm = makeMsm([
            { 'xml:id': 'n1', part: 1, date: 0, duration: 240, pitchname: 'c', accidentals: 0, octave: 4, 'midi.pitch': 60, 'midi.onset': 10, 'midi.duration': 0.5, 'midi.velocity': 80, source: 'implanted' },
            { 'xml:id': 'n2', part: 1, date: 720, duration: 240, pitchname: 'd', accidentals: 0, octave: 4, 'midi.pitch': 62, 'midi.onset': 11, 'midi.duration': 0.5, 'midi.velocity': 80, source: 'implanted' },
            { 'xml:id': 'n3', part: 1, date: 1440, duration: 240, pitchname: 'e', accidentals: 0, octave: 4, 'midi.pitch': 64, 'midi.onset': 12, 'midi.duration': 0.5, 'midi.velocity': 80, source: 'implanted' },
        ]);

        const options: TempoTransformerOptions = {
            from: 0,
            to: 1440,
            scope: 'global',
            silentOnsets: [{ date: 360, onset: 1.9 }],
        };

        expect(reprojectSilentOnsets(options, referenceMsm, studentMsm)).toEqual([]);
    });
});

describe('sanitizeTempoInstructions', () => {
    it('floors invalid tempo values and removes degenerate transitions', () => {
        const mpm = new MPM();
        mpm.insertInstruction({
            type: 'tempo',
            'xml:id': 'tempo_1',
            date: 0,
            beatLength: 0.25,
            bpm: -30,
            'transition.to': -5,
            meanTempoAt: 0.3,
        }, 'global');

        sanitizeTempoInstructions(mpm, 'global');

        const [tempo] = mpm.getInstructions<any>('tempo', 'global');
        expect(tempo.bpm).toBe(10);
        expect(tempo['transition.to']).toBeUndefined();
        expect(tempo.meanTempoAt).toBeUndefined();
    });
});
