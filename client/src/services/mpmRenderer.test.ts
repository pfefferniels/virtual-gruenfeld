import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { read } from 'midifile-ts';
import { describe, expect, it } from 'vitest';
import { convert, render, renderMsm } from './mpmRenderer';
// What the retired Java meico server (`/perform`) played for the same request — every
// note-on of bars 1–2, in file order. espressivo must keep playing exactly these.
import javaBars1to2 from './fixtures/javaPerformBars1-2.json';

const load = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const mei = load('../../public/score.mei');
const mpm = load('../../../assets/all/performance.mpm');

type NoteOn = { tick: number; channel: number; pitch: number; velocity: number };
type ControlChange = { tick: number; controller: number; value: number };

const eventsOf = (bytes: Uint8Array) => {
    const noteOns: NoteOn[] = [];
    const controlChanges: ControlChange[] = [];
    for (const track of read(bytes).tracks) {
        let tick = 0;
        for (const event of track) {
            tick += event.deltaTime;
            if (event.type !== 'channel') continue;
            if (event.subtype === 'noteOn' && event.velocity > 0) {
                noteOns.push({ tick, channel: event.channel, pitch: event.noteNumber, velocity: event.velocity });
            } else if (event.subtype === 'controller') {
                controlChanges.push({ tick, controller: event.controllerType, value: event.value });
            }
        }
    }
    return { noteOns, controlChanges };
};

describe('convert', () => {
    it('yields the score MSM that asMSM reads: every note with id, date and pitch on the 720 grid, no rests', () => {
        const msm = convert(mei);
        expect(msm).toContain('pulsesPerQuarter="720"');
        expect(msm).not.toContain('<rest ');

        const notes = msm.match(/<note [^>]*>/g) ?? [];
        expect(notes).toHaveLength(476);
        for (const note of notes) {
            expect(note).toMatch(/xml:id="/);
            expect(note).toMatch(/ date="/);
            expect(note).toMatch(/ midi\.pitch="/);
        }
    });
});

describe('render', () => {
    it('plays bars 1–2 note for note as the Java renderer did', () => {
        const bytes = render(mei, mpm, { from: 0, to: 5760 });
        expect(bytes).toBeDefined();
        expect(eventsOf(bytes!).noteOns).toEqual(javaBars1to2);
    });

    it('cuts to [from, to), starts the passage at 0 ms and puts everything on channel 0', () => {
        const { noteOns } = eventsOf(render(mei, mpm, { from: 11520, to: 23040 })!);
        expect(noteOns).toHaveLength(58);
        // 83.33 bpm at 720 ppq makes a tick a millisecond, so "first note at 0 ms" is tick 0.
        expect(Math.min(...noteOns.map((n) => n.tick))).toBe(0);
        expect(new Set(noteOns.map((n) => n.channel))).toEqual(new Set([0]));
    });

    it('sends a soft-pedal movement to the soft pedal (stock meico sent it to the damper)', () => {
        const { controlChanges } = eventsOf(render(mei, mpm, { from: 0, to: 5760 })!);
        expect(controlChanges.some((cc) => cc.controller === 67 && cc.value === 127)).toBe(true);
        expect(controlChanges.some((cc) => cc.controller === 64)).toBe(true);
    });

    it('refuses an MPM that carries no performance', () => {
        expect(() => render(mei, '<mpm xmlns="http://www.cemfi.de/mpm/ns/1.0"/>', { from: 0, to: 720 })).toThrow(/performance/);
    });
});

/**
 * The entry point the evidence worker uses. It has `scoreMsm` and no MEI, and what it renders —
 * Grünfeld over the take's window — is the document every number of the take is measured
 * against (`mpm/evidence.ts`). If it played even one note differently from what a take is
 * rendered by, the two sides would be fitted from two performances and the identity take's
 * zero would be luck. So the claim is byte equality, not equivalence.
 */
describe('renderMsm', () => {
    const scoreMsm = convert(mei);

    it('is `render` entered one step later: identical MIDI bytes, window for window', () => {
        for (const range of [
            { from: 0, to: 11520 },
            { from: 11520, to: 23040 },
            { from: 23040, to: 34560 },
            { from: 11520, to: 34560 },
        ]) {
            const fromMei = render(mei, mpm, range);
            const fromMsm = renderMsm(scoreMsm, mpm, range);
            expect(fromMsm).toBeDefined();
            expect([...fromMsm!]).toEqual([...fromMei!]);
        }
    });

    it('refuses a document that will not parse, rather than rendering silence', () => {
        // espressivo's own parse throws before this module's `isEmpty()` guard is reached; what
        // matters is that a bad score surfaces here and not as an empty take three calls later.
        expect(() => renderMsm('', mpm, { from: 0, to: 720 })).toThrow(/root element|MSM/);
    });
});
