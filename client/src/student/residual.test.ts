/**
 * What the document already explains: the rubato warp, the tempo clock, and the render.
 *
 * The `calculateRubatoOnDate` block is mpm-desk's own `rubatoMath.test.ts`, brought over with
 * the code it tests (risk R11) — the same seven windows, the same two absent-attribute cases,
 * the same numbers.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PPQ } from '../shared/constants';
import { convert } from '../services/mpmRenderer';
import {
    RESIDUAL_SEED,
    calculateRubatoOnDate,
    renderStudent,
    tempoClock,
    type AnchoredTempo,
    type RenderedNote,
    type RubatoFrame,
    type TempoClock,
} from './residual';

const load = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

// ── the rubato warp ──────────────────────────────────────────────────────────────────────

/**
 * The warp has to agree with the renderer, and in mpmify it did not.
 *
 * mpmify used to clamp `@lateStart` into [0, **0.9**] and `@earlyEnd` into [**0.1**, 1] —
 * bounds that exist nowhere in meico — and it left an inverted window inverted. meico (and
 * espressivo's `resolveRubato`, which is held equivalent to it) floors `lateStart` at 0, caps
 * `earlyEnd` at 1, and widens an inverted or empty window to the whole frame. The difference is
 * not a rounding one: on the frame below, four of these seven windows moved by up to 72 ticks,
 * which is a tenth of a quarter note.
 */
const rubato = (lateStart?: number, earlyEnd?: number): RubatoFrame => ({
    date: 0,
    frameLength: 720,
    intensity: 1,
    lateStart,
    earlyEnd,
});

describe('calculateRubatoOnDate', () => {
    it.each([
        // window                       at 360   why
        ['the identity', undefined, undefined, 360],
        ['a window meico leaves alone', 0.1, 0.9, 360],
        ['a lateStart past the old 0.9 cap', 0.95, 1, 702],
        ['an earlyEnd below the old 0.1 floor', 0, 0.05, 18],
        ['an inverted window, widened to the frame', 0.5, 0.3, 360],
        ['an empty window, widened to the frame', 0.4, 0.4, 360],
        ['a negative lateStart, floored at 0', -0.2, 1, 360],
    ])('%s', (_name, lateStart, earlyEnd, expected) => {
        expect(calculateRubatoOnDate(360, rubato(lateStart, earlyEnd))).toBeCloseTo(expected as number, 6);
    });

    it('takes an absent @intensity as the identity, not NaN', () => {
        // `Math.pow(x, undefined)` is NaN, and a `<rubato>` may legitimately carry no
        // @intensity: a hand-written document need not state one. Every date under one used to
        // come back NaN.
        const withoutIntensity: RubatoFrame = { date: 0, frameLength: 720, lateStart: 0.25, earlyEnd: 1 };
        const answer = calculateRubatoOnDate(360, withoutIntensity);
        expect(Number.isNaN(answer)).toBe(false);
        expect(answer).toBeCloseTo(450, 6);
    });

    it('leaves the date alone where there is no @frameLength, rather than answering NaN', () => {
        // `@frameLength` is the one rubato parameter with no default: espressivo's
        // `resolveRubato` rejects the instruction outright. It used to divide by `undefined`.
        expect(calculateRubatoOnDate(360, { date: 0 })).toBe(360);
    });

    it('pulls a date later under an intensity above 1 and earlier below it', () => {
        const frame = (intensity: number): RubatoFrame => ({ date: 0, frameLength: 720, intensity });
        expect(calculateRubatoOnDate(360, frame(2))).toBeLessThan(360);
        expect(calculateRubatoOnDate(360, frame(0.5))).toBeGreaterThan(360);
        expect(calculateRubatoOnDate(360, frame(1))).toBeCloseTo(360, 9);
    });
});

// ── the tempo clock ──────────────────────────────────────────────────────────────────────

/** A quarter at 60 bpm is 1000 ms, which makes every number below readable by eye. */
const constant = (date: number, bpm: number, endDate: number, anchorMs: number): AnchoredTempo => ({
    tempo: { date, bpm, beatLength: 0.25, endDate },
    anchorMs,
});

describe('tempoClock', () => {
    it('times a constant span from its own anchor', () => {
        const clock: TempoClock = tempoClock([constant(0, 60, 2880, 5000)], PPQ);
        expect(clock.msAt(0)).toBeCloseTo(5000, 6);
        expect(clock.msAt(720)).toBeCloseTo(6000, 6);
        expect(clock.msAt(2880)).toBeCloseTo(9000, 6);
    });

    it('inverts itself', () => {
        const clock = tempoClock([constant(0, 72, 2880, 1234)], PPQ);
        for (const tick of [0, 360, 720, 1500, 2880]) {
            expect(clock.tickAt(clock.msAt(tick))).toBeCloseTo(tick, 3);
        }
    });

    it('re-anchors at every boundary, so one span cannot poison the next', () => {
        // The second span is anchored 500 ms later than the first would have delivered it —
        // which is exactly the case semantics 3 is about: a recorded onset that the tempo fit
        // did not quite reach must not drag everything after it out of place.
        const clock = tempoClock([constant(0, 60, 720, 0), constant(720, 60, 1440, 1500)], PPQ);
        expect(clock.msAt(719.999)).toBeCloseTo(1000, 0);
        expect(clock.msAt(720)).toBeCloseTo(1500, 6);
        expect(clock.msAt(1440)).toBeCloseTo(2500, 6);
        expect(clock.tickAt(1500)).toBeCloseTo(720, 6);
    });

    it('follows a ramp through espressivo’s own arithmetic', () => {
        const ramp: AnchoredTempo = {
            tempo: { date: 0, bpm: 60, transitionTo: 120, meanTempoAt: 0.5, beatLength: 0.25, endDate: 1440 },
            anchorMs: 0,
        };
        const clock = tempoClock([ramp], PPQ);
        // A constant 60 bpm would take 2000 ms over two quarters; the ramp arrives sooner.
        expect(clock.msAt(1440)).toBeLessThan(2000);
        expect(clock.msAt(1440)).toBeGreaterThan(1000);
        expect(clock.tickAt(clock.msAt(1440))).toBeCloseTo(1440, 3);
    });

    it('is the identity where there is no tempo at all', () => {
        const clock = tempoClock([], PPQ);
        expect(clock.msAt(720)).toBe(720);
        expect(clock.tickAt(720)).toBe(720);
    });

    it('sorts the spans it is handed', () => {
        const shuffled = tempoClock([constant(720, 60, 1440, 1500), constant(0, 60, 720, 0)], PPQ);
        expect(shuffled.msAt(720)).toBeCloseTo(1500, 6);
    });
});

// ── the render-based half ────────────────────────────────────────────────────────────────

describe('renderStudent', () => {
    const scoreMsm = convert(load('../../public/score.mei'));
    const reference = load('../../public/performance.mpm');

    it('indexes what the document prescribes by note id', () => {
        const rendered = renderStudent(scoreMsm, reference);

        expect(rendered.size).toBeGreaterThan(400);
        const first: RenderedNote | undefined = rendered.get('npk4lw6');
        expect(first).toBeDefined();
        expect(first?.date).toBe(0);
        expect(first?.duration).toBe(720);
        // the prescribed velocity — the divisor `relativeVelocity` needs (semantics 12)
        expect(first?.velocity).toBe(41);
        expect(first?.msEnd).toBeGreaterThan(first?.msDate ?? 0);
    });

    it('is deterministic, because the seed is', () => {
        const a = renderStudent(scoreMsm, reference);
        const b = renderStudent(scoreMsm, reference);
        expect([...a.entries()].map(([id, note]) => [id, note.velocity, note.msDate])).toEqual(
            [...b.entries()].map(([id, note]) => [id, note.velocity, note.msDate]),
        );
        expect(RESIDUAL_SEED).toBe(0x6d706d);
    });
});
