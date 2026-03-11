import { describe, expect, it } from 'vitest';
import { MSM } from 'mpmify';
import { reprojectPhantomVelocities } from './dynamicsSafety';

const makeMsm = (notes: Array<Record<string, unknown>>) =>
    new MSM(notes as any[], { numerator: 4, denominator: 4 });

describe('reprojectPhantomVelocities', () => {
    it('transfers the teacher phantom delta onto the student baseline at the same date', () => {
        const referenceMsm = makeMsm([
            { 'xml:id': 'n1', part: 1, date: 0, duration: 240, pitchname: 'c', accidentals: 0, octave: 4, 'midi.pitch': 60, 'midi.onset': 0, 'midi.duration': 0.5, 'midi.velocity': 50 },
            { 'xml:id': 'n2', part: 1, date: 720, duration: 240, pitchname: 'd', accidentals: 0, octave: 4, 'midi.pitch': 62, 'midi.onset': 1, 'midi.duration': 0.5, 'midi.velocity': 60 },
            { 'xml:id': 'n3', part: 1, date: 1440, duration: 240, pitchname: 'e', accidentals: 0, octave: 4, 'midi.pitch': 64, 'midi.onset': 2, 'midi.duration': 0.5, 'midi.velocity': 70 },
        ]);

        const studentMsm = makeMsm([
            { 'xml:id': 'n1', part: 1, date: 0, duration: 240, pitchname: 'c', accidentals: 0, octave: 4, 'midi.pitch': 60, 'midi.onset': 10, 'midi.duration': 0.5, 'midi.velocity': 82, source: 'implanted' },
            { 'xml:id': 'n2', part: 1, date: 720, duration: 240, pitchname: 'd', accidentals: 0, octave: 4, 'midi.pitch': 62, 'midi.onset': 11, 'midi.duration': 0.5, 'midi.velocity': 92, source: 'implanted' },
            { 'xml:id': 'n3', part: 1, date: 1440, duration: 240, pitchname: 'e', accidentals: 0, octave: 4, 'midi.pitch': 64, 'midi.onset': 12, 'midi.duration': 0.5, 'midi.velocity': 102, source: 'implanted' },
        ]);

        const projected = reprojectPhantomVelocities({
            from: 0,
            to: 1440,
            scope: 'global',
            phantomVelocities: new Map([[720, 68]]),
        }, referenceMsm, studentMsm);

        expect(projected.get(720)).toBe(100);
    });

    it('interpolates the student baseline by score date when no exact implanted chord exists', () => {
        const referenceMsm = makeMsm([
            { 'xml:id': 'n1', part: 1, date: 0, duration: 240, pitchname: 'c', accidentals: 0, octave: 4, 'midi.pitch': 60, 'midi.onset': 0, 'midi.duration': 0.5, 'midi.velocity': 50 },
            { 'xml:id': 'n2', part: 1, date: 720, duration: 240, pitchname: 'd', accidentals: 0, octave: 4, 'midi.pitch': 62, 'midi.onset': 1, 'midi.duration': 0.5, 'midi.velocity': 60 },
            { 'xml:id': 'n3', part: 1, date: 1440, duration: 240, pitchname: 'e', accidentals: 0, octave: 4, 'midi.pitch': 64, 'midi.onset': 2, 'midi.duration': 0.5, 'midi.velocity': 70 },
        ]);

        const studentMsm = makeMsm([
            { 'xml:id': 'n1', part: 1, date: 0, duration: 240, pitchname: 'c', accidentals: 0, octave: 4, 'midi.pitch': 60, 'midi.onset': 10, 'midi.duration': 0.5, 'midi.velocity': 80, source: 'implanted' },
            { 'xml:id': 'n3', part: 1, date: 1440, duration: 240, pitchname: 'e', accidentals: 0, octave: 4, 'midi.pitch': 64, 'midi.onset': 12, 'midi.duration': 0.5, 'midi.velocity': 100, source: 'implanted' },
        ]);

        const projected = reprojectPhantomVelocities({
            from: 0,
            to: 1440,
            scope: 'global',
            phantomVelocities: new Map([[720, 68]]),
        }, referenceMsm, studentMsm);

        expect(projected.get(720)).toBe(98);
    });

    it('drops anchors without implanted student support', () => {
        const referenceMsm = makeMsm([
            { 'xml:id': 'n1', part: 1, date: 0, duration: 240, pitchname: 'c', accidentals: 0, octave: 4, 'midi.pitch': 60, 'midi.onset': 0, 'midi.duration': 0.5, 'midi.velocity': 50 },
            { 'xml:id': 'n2', part: 1, date: 720, duration: 240, pitchname: 'd', accidentals: 0, octave: 4, 'midi.pitch': 62, 'midi.onset': 1, 'midi.duration': 0.5, 'midi.velocity': 60 },
            { 'xml:id': 'n3', part: 1, date: 1440, duration: 240, pitchname: 'e', accidentals: 0, octave: 4, 'midi.pitch': 64, 'midi.onset': 2, 'midi.duration': 0.5, 'midi.velocity': 70 },
        ]);

        const studentMsm = makeMsm([
            { 'xml:id': 'n1', part: 1, date: 0, duration: 240, pitchname: 'c', accidentals: 0, octave: 4, 'midi.pitch': 60, 'midi.onset': 10, 'midi.duration': 0.5, 'midi.velocity': 80, source: 'implanted' },
        ]);

        const projected = reprojectPhantomVelocities({
            from: 0,
            to: 1440,
            scope: 'global',
            phantomVelocities: new Map([[720, 68]]),
        }, referenceMsm, studentMsm);

        expect(projected).toEqual(new Map());
    });

    it('ignores teacher leftovers and uses implanted student notes only', () => {
        const referenceMsm = makeMsm([
            { 'xml:id': 'n1', part: 1, date: 0, duration: 240, pitchname: 'c', accidentals: 0, octave: 4, 'midi.pitch': 60, 'midi.onset': 0, 'midi.duration': 0.5, 'midi.velocity': 50 },
            { 'xml:id': 'n2', part: 1, date: 720, duration: 240, pitchname: 'd', accidentals: 0, octave: 4, 'midi.pitch': 62, 'midi.onset': 1, 'midi.duration': 0.5, 'midi.velocity': 60 },
            { 'xml:id': 'n3', part: 1, date: 1440, duration: 240, pitchname: 'e', accidentals: 0, octave: 4, 'midi.pitch': 64, 'midi.onset': 2, 'midi.duration': 0.5, 'midi.velocity': 70 },
        ]);

        const studentMsm = makeMsm([
            { 'xml:id': 'n1', part: 1, date: 0, duration: 240, pitchname: 'c', accidentals: 0, octave: 4, 'midi.pitch': 60, 'midi.onset': 10, 'midi.duration': 0.5, 'midi.velocity': 80, source: 'implanted' },
            { 'xml:id': 'n2', part: 1, date: 720, duration: 240, pitchname: 'd', accidentals: 0, octave: 4, 'midi.pitch': 62, 'midi.onset': 1, 'midi.duration': 0.5, 'midi.velocity': 60 },
            { 'xml:id': 'n3', part: 1, date: 1440, duration: 240, pitchname: 'e', accidentals: 0, octave: 4, 'midi.pitch': 64, 'midi.onset': 12, 'midi.duration': 0.5, 'midi.velocity': 100, source: 'implanted' },
        ]);

        const projected = reprojectPhantomVelocities({
            from: 0,
            to: 1440,
            scope: 'global',
            phantomVelocities: new Map([[720, 68]]),
        }, referenceMsm, studentMsm);

        expect(projected.get(720)).toBe(98);
    });
});
