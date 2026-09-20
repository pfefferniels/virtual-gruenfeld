import { describe, expect, it, vi } from 'vitest';
import { createLiveInput } from './liveInput';

const noteOn = (pitch: number, velocity = 64) => new Uint8Array([0x90, pitch, velocity]);
const noteOff = (pitch: number) => new Uint8Array([0x80, pitch, 0]);
const sustain = (value: number) => new Uint8Array([0xb0, 64, value]);

const silent = () => createLiveInput({ onHeard: () => undefined });

describe('what counts as heard', () => {
    it('reports a note the moment it is struck, not when it is released', () => {
        const input = silent();
        input.receive(noteOn(60), 1000);
        expect(input.played(1200)).toHaveLength(1);
    });

    it('gives a still-held note the duration it has sounded so far', () => {
        const input = silent();
        input.receive(noteOn(60), 1000);
        expect(input.played(1500)[0].duration).toBeCloseTo(0.5, 3);
        expect(input.played(2000)[0].duration).toBeCloseTo(1.0, 3);
    });

    it('fixes the duration once the key comes up', () => {
        const input = silent();
        input.receive(noteOn(60), 1000);
        input.receive(noteOff(60), 1600);
        expect(input.played(9000)[0].duration).toBeCloseTo(0.6, 3);
    });

    it('treats a note-on at velocity zero as a release', () => {
        const input = silent();
        input.receive(noteOn(60), 1000);
        input.receive(noteOn(60, 0), 1400);
        expect(input.played(9000)[0].duration).toBeCloseTo(0.4, 3);
    });

    it('ends the first sounding when a key is struck again without a release', () => {
        const input = silent();
        input.receive(noteOn(60), 1000);
        input.receive(noteOn(60), 1300);
        const played = input.played(1500);
        expect(played).toHaveLength(2);
        expect(played[0].duration).toBeCloseTo(0.3, 3);
    });

    it('keeps the order they were played in', () => {
        const input = silent();
        [64, 60, 67].forEach((pitch, i) => input.receive(noteOn(pitch), 1000 + i * 100));
        expect(input.played(2000).map((n) => n.pitch)).toEqual([64, 60, 67]);
    });

    it('ignores the pedal, which the fit does not read yet', () => {
        const heard = vi.fn();
        const input = createLiveInput({ onHeard: heard });
        input.receive(sustain(127), 1000);
        expect(input.played(1000)).toHaveLength(0);
        expect(heard).not.toHaveBeenCalled();
    });
});

describe('the gate', () => {
    it('drops what the gate refuses, so the app never hears its own playing', () => {
        const input = createLiveInput({
            accepts: (data) => data[1] !== 60,
            onHeard: () => undefined,
        });
        input.receive(noteOn(60), 1000);
        input.receive(noteOn(64), 1100);
        expect(input.played(2000).map((n) => n.pitch)).toEqual([64]);
    });
});

describe('the buffer', () => {
    it('announces the take as it stands after every accepted note', () => {
        const heard = vi.fn();
        const input = createLiveInput({ onHeard: heard });
        input.receive(noteOn(60), 1000);
        input.receive(noteOn(64), 1100);
        expect(heard).toHaveBeenCalledTimes(2);
        expect(heard.mock.calls[1][0]).toHaveLength(2);
    });

    it('does not grow without bound over a long lesson', () => {
        const input = silent();
        Array.from({ length: 900 }, (_, i) => i).forEach((i) => input.receive(noteOn(60 + (i % 12)), 1000 + i * 50));
        expect(input.played(99000).length).toBeLessThanOrEqual(400);
    });

    it('forgets the take when asked, and stops listening when disposed', () => {
        const input = silent();
        input.receive(noteOn(60), 1000);
        input.clear();
        expect(input.played(2000)).toHaveLength(0);

        input.receive(noteOn(64), 2100);
        expect(input.played(3000)).toHaveLength(1);

        input.dispose();
        input.receive(noteOn(67), 3100);
        expect(input.played(4000)).toHaveLength(0);
    });
});
