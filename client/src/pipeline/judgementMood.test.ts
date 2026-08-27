import { describe, expect, it } from 'vitest';
import { DYNAMICS_MAP, MOVEMENT_MAP, Mpm, ORNAMENTATION_MAP, ORNAMENTATION_STYLE, TEMPO_MAP, allChildElements, type Element } from 'espressivo';
import type { MeasuredNote } from '../score/measured';
import { buildJudgementMoodRenderPlan } from './judgementMood';

/**
 * The same assertions the mpm-ts version made, on the same inputs, against the same numbers —
 * only the document is text now and it is read back through espressivo.
 */

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

const REFERENCE_WITH_ARPEGGIO = `<mpm>
  <performance name="reference" pulsesPerQuarter="720">
    <global>
      <header>
        <ornamentationStyles>
          <styleDef name="performance_style">
            <ornamentDef name="reference_arpeggio">
              <dynamicsGradient transition.from="0" transition.to="-1"></dynamicsGradient>
              <temporalSpread frame.start="-40" frameLength="80" noteoff.shift="false" time.unit="ticks" intensity="1"></temporalSpread>
            </ornamentDef>
          </styleDef>
        </ornamentationStyles>
      </header>
      <dated>
        <dynamicsMap>
          <dynamics xml:id="dyn_1" date="700" volume="52" transition.to="86"></dynamics>
        </dynamicsMap>
        <ornamentationMap>
          <style date="0" name.ref="performance_style"></style>
          <ornament xml:id="orn_1" date="760" name.ref="reference_arpeggio" note.order="#f_mid #f_low #f_top #f_inner" scale="2"></ornament>
        </ornamentationMap>
      </dated>
    </global>
  </performance>
</mpm>`;

const EMPTY_REFERENCE = `<mpm>
  <performance name="reference" pulsesPerQuarter="720">
    <global><header></header><dated></dated></global>
  </performance>
</mpm>`;

const elementsOf = (mpmText: string, mapName: string, elementName: string): Element[] => {
    const map = new Mpm(mpmText).getPerformance(0)?.getGlobal()?.getDated()?.getMap(mapName) ?? null;
    if (!map) return [];
    const found: Element[] = [];
    for (let index = 0; index < map.size(); index++) {
        const element = map.getElement(index);
        if (element && element.getLocalName() === elementName) found.push(element);
    }
    return found;
};

const defsOf = (mpmText: string): Element[] => {
    const header = new Mpm(mpmText).getPerformance(0)?.getGlobal()?.getHeader() ?? null;
    const found: Element[] = [];
    for (const style of header?.getAllStyleDefs(ORNAMENTATION_STYLE)?.values() ?? []) {
        for (const [, def] of style.getAllDefs()) {
            const xml = def.getXmlOrNull();
            if (xml) found.push(xml);
        }
    }
    return found;
};

const num = (element: Element, name: string): number | null => {
    const raw = element.getAttributeValue(name);
    return raw === null ? null : Number(raw);
};

/**
 * The value the renderer will read: espressivo omits an attribute sitting at its spec default
 * (`frame.start="0"`, `noteoff.shift="false"`, `intensity="1"`, `transition.from="0"`), where
 * mpm-ts spelled every one of them out. Absent and default are the same performance, so these
 * assertions are on the value rather than on the byte.
 */
const effective = (element: Element, name: string, fallback: number): number =>
    num(element, name) ?? fallback;

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

        const plan = buildJudgementMoodRenderPlan(reductionNotes, scoreNotes, REFERENCE_WITH_ARPEGGIO, 750);

        expect(plan).not.toBeNull();
        expect(plan?.chordDate).toBe(720);
        expect(plan?.noteCount).toBe(3);
        expect(plan?.noteOrder).toBe('#r2 #r1 #r3');
        expect(plan?.range.from).toBe(719);
        expect(plan?.range.to).toBe(1478);

        const mpm = plan!.mpm;

        const [tempo] = elementsOf(mpm, TEMPO_MAP, 'tempo');
        expect(num(tempo, 'bpm')).toBe(30);
        expect(num(tempo, 'beatLength')).toBe(0.25);
        expect(num(tempo, 'date')).toBe(719);

        const [dynamics] = elementsOf(mpm, DYNAMICS_MAP, 'dynamics');
        expect(num(dynamics, 'volume')).toBe(30);

        const [style] = elementsOf(mpm, ORNAMENTATION_MAP, 'style');
        expect(num(style, 'date')).toBe(719);
        expect(style.getAttributeValue('name.ref')).toBe('performance_style');

        const [ornamentDef] = defsOf(mpm);
        expect(ornamentDef.getAttributeValue('name')).toBe('reference_arpeggio');
        const [spread] = allChildElements(ornamentDef, 'temporalSpread');
        expect(spread.getAttributeValue('time.unit')).toBe('milliseconds');
        expect(effective(spread, 'frame.start', 0)).toBe(0);
        expect(num(spread, 'frameLength')).toBe(700);
        // The spacing curve stays neutral: the slowed def is the mood chord's own, and an even
        // roll is what the mpm-ts builder produced too (it wrote no `@intensity` at all).
        expect(effective(spread, 'intensity', 1)).toBe(1);
        // The source def's gradient rides along; its shape is Grünfeld's editorial choice.
        const [gradient] = allChildElements(ornamentDef, 'dynamicsGradient');
        expect(effective(gradient, 'transition.from', 0)).toBe(0);
        expect(num(gradient, 'transition.to')).toBe(-1);

        const [ornament] = elementsOf(mpm, ORNAMENTATION_MAP, 'ornament');
        expect(num(ornament, 'date')).toBe(720);
        expect(ornament.getAttributeValue('name.ref')).toBe('reference_arpeggio');
        expect(ornament.getAttributeValue('note.order')).toBe('#r2 #r1 #r3');
        expect(num(ornament, 'scale')).toBe(1);

        const movements = elementsOf(mpm, MOVEMENT_MAP, 'movement');
        expect(movements.map((movement) => [
            num(movement, 'date'),
            num(movement, 'position'),
            num(movement, 'transition.to'),
        ])).toEqual([
            [719, 0, 1],
            [720, 1, null],
            [1476, 1, 0],
            [1477, 0, null],
        ]);
        expect(movements.every((movement) => movement.getAttributeValue('controller') === 'sustain')).toBe(true);
    });

    it('falls back to a default arpeggio when there is no nearby ornament', () => {
        const reductionNotes = [
            note('r1', 1440, 1440, 50),
            note('r2', 1440, 1440, 57),
        ];

        const plan = buildJudgementMoodRenderPlan(reductionNotes, [], EMPTY_REFERENCE, 1440);

        expect(plan).not.toBeNull();
        const [ornamentDef] = defsOf(plan!.mpm);
        expect(ornamentDef.getAttributeValue('name')).toBe('judgement_mood_default_ornament');
        const [ornament] = elementsOf(plan!.mpm, ORNAMENTATION_MAP, 'ornament');
        expect(ornament.getAttributeValue('note.order')).toBe('#r1 #r2');
        // No `<dynamics>` to read: the documented default of 72, scaled by 0.35.
        const [dynamics] = elementsOf(plan!.mpm, DYNAMICS_MAP, 'dynamics');
        expect(num(dynamics, 'volume')).toBe(25);
    });

    it('holds the pedal for at least the narration, and renders past its release', () => {
        const reductionNotes = [note('r1', 720, 1440, 48), note('r2', 720, 1440, 60)];

        const plan = buildJudgementMoodRenderPlan(
            reductionNotes,
            [],
            REFERENCE_WITH_ARPEGGIO,
            720,
            { minimumPedalHoldMs: 8000 },
        );

        // 8000 ms at the fixed 30 bpm / beatLength 0.25 is 2880 ticks from `renderFrom`.
        const movements = elementsOf(plan!.mpm, MOVEMENT_MAP, 'movement');
        expect(num(movements[2], 'date')).toBe(719 + 2880);
        expect(plan?.range.to).toBe(719 + 2880 + 2);
    });
});
