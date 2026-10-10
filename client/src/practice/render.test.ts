import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addAbsoluteTime } from '../pianosound/MidiNote';
import { convert } from '../services/mpmRenderer';
import { BAR, END, type Pass } from './planner';
import { createPracticeRenderer, reductionMpmOf } from './render';

const load = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const scoreMsm = load('../../public/score.msm');
const referenceMpmText = load('../../public/performance.mpm');
const reductionMsm = convert(load('../../public/harmonic_reduction.mei'));
const renderer = createPracticeRenderer({ scoreMsm, referenceMpmText, reductionMsm });

const pass = (over: Partial<Pass>): Pass => ({
    source: 'perf', range: [0, 4 * BAR], factors: {}, scope: 'global', hand: 'both',
    timeScale: 1, vel: 1, voice: false, character: '', pause: 0, ...over,
});

const notesOf = (p: Pass) => addAbsoluteTime(renderer.render(p).midi)
    .filter((e) => e.type === 'channel' && e.subtype === 'noteOn')
    .map((e) => e as typeof e & { noteNumber: number; velocity: number; abs: number });

const controlsOf = (p: Pass, controller: number) => addAbsoluteTime(renderer.render(p).midi)
    .filter((e) => e.type === 'channel' && e.subtype === 'controller' && e.controllerType === controller)
    .map((e) => e as typeof e & { value: number; abs: number });

describe('a practice pass, rendered', () => {
    it('plays the bars it names and nothing else', () => {
        const phrase = notesOf(pass({}));
        const twoBars = notesOf(pass({ range: [0, 2 * BAR] }));
        expect(phrase.length).toBeGreaterThan(40);
        expect(twoBars.length).toBeGreaterThan(5);
        expect(twoBars.length).toBeLessThan(phrase.length);
        expect(phrase[0].abs).toBeLessThan(50);
    });

    it('is one tick to the millisecond, so its duration is its length in ms', () => {
        const rendered = renderer.render(pass({}));
        const last = Math.max(...addAbsoluteTime(rendered.midi).map((e) => e.abs));
        expect(rendered.durationMs).toBeGreaterThan(8000);
        expect(last).toBeLessThanOrEqual(rendered.durationMs + 1);
    });

    it('takes the time scale', () => {
        const plain = renderer.render(pass({})).durationMs;
        expect(renderer.render(pass({ timeScale: 0.5 })).durationMs).toBeCloseTo(plain / 2, 0);
    });

    it('plays one hand when asked', () => {
        const both = notesOf(pass({}));
        const right = notesOf(pass({ hand: 'rh' }));
        const left = notesOf(pass({ hand: 'lh' }));
        expect(right.length + left.length).toBe(both.length);
        expect(Math.min(...right.map((n) => n.noteNumber))).toBeGreaterThan(Math.min(...left.map((n) => n.noteNumber)));
    });

    it('exaggerates: a doubled dynamics factor widens the velocity range', () => {
        const range = (p: Pass) => { const v = notesOf(p).map((n) => n.velocity); return Math.max(...v) - Math.min(...v); };
        expect(range(pass({ factors: { dynamics: 4 } }))).toBeGreaterThan(range(pass({})));
    });

    it('lifts every pedal it put down', () => {
        for (const controller of [64, 67]) {
            const moves = controlsOf(pass({ range: [0, END] }), controller);
            if (moves.length) expect(moves[moves.length - 1].value).toBe(0);
        }
        expect(controlsOf(pass({ range: [0, END] }), 64).length).toBeGreaterThan(10);
    });

    it('plays the reduction sped up, without pedal', () => {
        const red = pass({ source: 'red', range: [0, 8 * BAR], timeScale: 1 / 3, speed: 3, factors: { rubato: 4, ornamentSpread: 2 } });
        const rendered = renderer.render(red);
        expect(notesOf(red).length).toBeGreaterThan(20);
        expect(controlsOf(red, 64)).toHaveLength(0);
        expect(rendered.durationMs).toBeLessThan(renderer.render(pass({ range: [0, 8 * BAR] })).durationMs / 2);
    });
});

describe('the roll, as the reduction carries it', () => {
    const mpm = reductionMpmOf(referenceMpmText, reductionMsm);

    it('keeps tempo, dynamics and rubato, and drops what has no notes to act on', () => {
        expect(mpm).toContain('<tempoMap');
        expect(mpm).toContain('<dynamicsMap');
        expect(mpm).not.toContain('<articulationMap');
        expect(mpm).not.toContain('<movementMap');
    });

    it('keeps only the arpeggios that land on a chord of the reduction', () => {
        const onsets = new Set([...reductionMsm.matchAll(/<note [^>]*\bdate="([\d.]+)"/g)].map((m) => Number(m[1])));
        const kept = [...mpm.matchAll(/<ornament\b[^>]*?\bdate="([\d.]+)"/g)].map((m) => Number(m[1]));
        const all = [...referenceMpmText.matchAll(/<ornament\b[^>]*?\bdate="([\d.]+)"/g)];
        expect(kept.length).toBeGreaterThan(0);
        expect(kept.length).toBeLessThan(all.length);
        expect(kept.every((d) => onsets.has(d))).toBe(true);
    });
});
