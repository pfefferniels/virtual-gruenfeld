import { describe, expect, it } from 'vitest';
import { MPM, type Dynamics, type Ornament, type Tempo, type Movement, type OrnamentDef } from 'mpm-ts';
import { MSM } from 'mpmify';
import { buildJudgementMoodRenderPlan } from './judgementMood';

const makeMsm = (notes: Array<Record<string, unknown>>) =>
    new MSM(notes as any[], { numerator: 4, denominator: 4 });

describe('buildJudgementMoodRenderPlan', () => {
    it('builds a single-chord render plan with fixed tempo, mapped ornament order, and pedal envelope', () => {
        const reductionMsm = makeMsm([
            { 'xml:id': 'r1', part: 1, date: 720, duration: 1440, pitchname: 'c', accidentals: 0, octave: 3, 'midi.pitch': 48, 'midi.onset': 0, 'midi.duration': 0, 'midi.velocity': 64 },
            { 'xml:id': 'r2', part: 1, date: 720, duration: 1440, pitchname: 'g', accidentals: 0, octave: 3, 'midi.pitch': 55, 'midi.onset': 0, 'midi.duration': 0, 'midi.velocity': 64 },
            { 'xml:id': 'r3', part: 1, date: 720, duration: 1440, pitchname: 'c', accidentals: 0, octave: 4, 'midi.pitch': 60, 'midi.onset': 0, 'midi.duration': 0, 'midi.velocity': 64 },
            { 'xml:id': 'r4', part: 1, date: 2160, duration: 1440, pitchname: 'f', accidentals: 0, octave: 3, 'midi.pitch': 53, 'midi.onset': 0, 'midi.duration': 0, 'midi.velocity': 64 },
        ]);
        const baseMsm = makeMsm([
            { 'xml:id': 'f_low', part: 1, date: 720, duration: 720, pitchname: 'c', accidentals: 0, octave: 3, 'midi.pitch': 48, 'midi.onset': 0, 'midi.duration': 0.5, 'midi.velocity': 70 },
            { 'xml:id': 'f_mid', part: 1, date: 720, duration: 720, pitchname: 'e', accidentals: 0, octave: 4, 'midi.pitch': 64, 'midi.onset': 0, 'midi.duration': 0.5, 'midi.velocity': 70 },
            { 'xml:id': 'f_top', part: 1, date: 720, duration: 720, pitchname: 'g', accidentals: 0, octave: 4, 'midi.pitch': 67, 'midi.onset': 0, 'midi.duration': 0.5, 'midi.velocity': 70 },
            { 'xml:id': 'f_inner', part: 1, date: 720, duration: 720, pitchname: 'f', accidentals: 0, octave: 4, 'midi.pitch': 65, 'midi.onset': 0, 'midi.duration': 0.5, 'midi.velocity': 70 },
        ]);

        const referenceMpm = new MPM();
        referenceMpm.insertDefinition({
            type: 'ornamentDef',
            name: 'reference_arpeggio',
            temporalSpread: {
                type: 'temporalSpread',
                'frame.start': -40,
                frameLength: 80,
                'time.unit': 'ticks',
                'noteoff.shift': false,
            },
            dynamicsGradient: {
                type: 'dynamicsGradient',
                'transition.from': 0,
                'transition.to': -1,
            },
        }, 'global');
        referenceMpm.insertInstruction({
            type: 'dynamics',
            'xml:id': 'dyn_1',
            date: 700,
            volume: 52,
            'transition.to': 86,
        } as Dynamics, 'global');
        referenceMpm.insertInstruction({
            type: 'ornament',
            'xml:id': 'orn_1',
            date: 760,
            'name.ref': 'reference_arpeggio',
            'note.order': '#f_mid #f_low #f_top #f_inner',
            scale: 2,
        } as Ornament, 'global');

        const plan = buildJudgementMoodRenderPlan(reductionMsm, baseMsm, referenceMpm, 750);

        expect(plan).not.toBeNull();
        expect(plan?.chordDate).toBe(720);
        expect(plan?.noteCount).toBe(3);
        expect(plan?.noteOrder).toBe('#r2 #r1 #r3');
        expect(plan?.range.from).toBe(719);
        expect(plan?.range.to).toBe(1478);

        const [tempo] = plan!.mpm.getInstructions<Tempo>('tempo', 'global');
        expect(tempo.bpm).toBe(30);
        expect(tempo.beatLength).toBe(0.25);
        expect(tempo.date).toBe(719);

        const [dynamics] = plan!.mpm.getInstructions<Dynamics>('dynamics', 'global');
        expect(dynamics.volume).toBe(30);

        const [style] = plan!.mpm.getStyles('ornament', 'global');
        expect(style.date).toBe(719);
        expect(style['name.ref']).toBe('performance_style');

        const [ornamentDef] = plan!.mpm.getDefinitions<OrnamentDef>('ornamentDef', 'global');
        expect(ornamentDef.name).toBe('reference_arpeggio');
        expect(ornamentDef.temporalSpread!['time.unit']).toBe('milliseconds');
        expect(ornamentDef.temporalSpread!['frame.start']).toBe(0);
        expect(ornamentDef.temporalSpread!.frameLength).toBe(700);

        const [ornament] = plan!.mpm.getInstructions<Ornament>('ornament', 'global');
        expect(ornament.date).toBe(720);
        expect(ornament['name.ref']).toBe('reference_arpeggio');
        expect(ornament['note.order']).toBe('#r2 #r1 #r3');
        expect(ornament.scale).toBe(1);

        const movements = plan!.mpm.getInstructions<Movement>('movement', 'global');
        expect(movements.map((movement) => [movement.date, movement.position, movement['transition.to'] ?? null])).toEqual([
            [719, 0, 1],
            [720, 1, null],
            [1476, 1, 0],
            [1477, 0, null],
        ]);
    });

    it('falls back to a default arpeggio when there is no nearby ornament', () => {
        const reductionMsm = makeMsm([
            { 'xml:id': 'r1', part: 1, date: 1440, duration: 1440, pitchname: 'd', accidentals: 0, octave: 3, 'midi.pitch': 50, 'midi.onset': 0, 'midi.duration': 0, 'midi.velocity': 64 },
            { 'xml:id': 'r2', part: 1, date: 1440, duration: 1440, pitchname: 'a', accidentals: 0, octave: 3, 'midi.pitch': 57, 'midi.onset': 0, 'midi.duration': 0, 'midi.velocity': 64 },
        ]);
        const baseMsm = makeMsm([]);
        const referenceMpm = new MPM();

        const plan = buildJudgementMoodRenderPlan(reductionMsm, baseMsm, referenceMpm, 1440);

        expect(plan).not.toBeNull();
        const [ornamentDef] = plan!.mpm.getDefinitions<OrnamentDef>('ornamentDef', 'global');
        expect(ornamentDef.name).toBe('judgement_mood_default_ornament');
        const [ornament] = plan!.mpm.getInstructions<Ornament>('ornament', 'global');
        expect(ornament['note.order']).toBe('#r1 #r2');
    });
});
