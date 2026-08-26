import { describe, expect, it } from 'vitest';
import { MPM, type Dynamics, type Ornament, type Tempo, type Movement, type OrnamentDef } from 'mpm-ts';
import type { MeasuredNote } from '../score/measured';
import { buildJudgementMoodRenderPlan } from './judgementMood';

/** A measured note: score date/duration in ticks, onset and end in milliseconds. */
const note = (
    id: string,
    date: number,
    duration: number,
    pitch: number,
): MeasuredNote => ({
    'xml:id': id,
    part: 1,
    date,
    duration,
    'midi.pitch': pitch,
    'milliseconds.date': 0,
    'milliseconds.date.end': 0,
    velocity: 64,
});

describe('buildJudgementMoodRenderPlan', () => {
    it('builds a single-chord render plan with fixed tempo, mapped ornament order, and pedal envelope', () => {
        const reductionNotes = [
            note('r1', 720, 1440, 48),
            note('r2', 720, 1440, 55),
            note('r3', 720, 1440, 60),
            note('r4', 2160, 1440, 53),
        ];
        const scoreNotes = [
            note('f_low', 720, 720, 48),
            note('f_mid', 720, 720, 64),
            note('f_top', 720, 720, 67),
            note('f_inner', 720, 720, 65),
        ];

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

        const plan = buildJudgementMoodRenderPlan(reductionNotes, scoreNotes, referenceMpm, 750);

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
        const reductionNotes = [
            note('r1', 1440, 1440, 50),
            note('r2', 1440, 1440, 57),
        ];
        const referenceMpm = new MPM();

        const plan = buildJudgementMoodRenderPlan(reductionNotes, [], referenceMpm, 1440);

        expect(plan).not.toBeNull();
        const [ornamentDef] = plan!.mpm.getDefinitions<OrnamentDef>('ornamentDef', 'global');
        expect(ornamentDef.name).toBe('judgement_mood_default_ornament');
        const [ornament] = plan!.mpm.getInstructions<Ornament>('ornament', 'global');
        expect(ornament['note.order']).toBe('#r1 #r2');
    });
});
