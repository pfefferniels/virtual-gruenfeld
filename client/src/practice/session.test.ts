import { describe, expect, it } from 'vitest';
import type { MidiFile } from 'midifile-ts';
import { createPractice, type PracticeNow } from './session';
import type { Pass } from './planner';

const interest = Array.from({ length: 32 }, (_, i) => 1 + (i % 5) / 4);
const midi: MidiFile = { header: { formatType: 0, trackCount: 1, ticksPerBeat: 1000 }, tracks: [[]] };

/** A clock that only moves when the test says so. */
const harness = () => {
    let now = 0;
    const waiting: { at: number; resolve: () => void }[] = [];
    const played: Pass[] = [];
    const seen: (PracticeNow | null)[] = [];
    let silenced = 0;
    const practice = createPractice({
        interest,
        seed: 7,
        render: (pass) => { played.push(pass); return { midi, durationMs: 1000 }; },
        play: (_, durationMs) => durationMs,
        silence: () => { silenced++; },
        sleep: (ms) => new Promise((resolve) => { waiting.push({ at: now + ms, resolve }); }),
        onPass: (n) => seen.push(n),
    });
    const advance = async (ms: number) => {
        const until = now + ms;
        for (;;) {
            await Promise.resolve();
            await Promise.resolve();
            waiting.sort((a, b) => a.at - b.at);
            const next = waiting[0];
            if (!next || next.at > until) break;
            waiting.shift();
            now = next.at;
            next.resolve();
        }
        now = until;
    };
    return { practice, played, seen, advance, silenced: () => silenced };
};

describe('practising', () => {
    it('plays pass after pass once resumed', async () => {
        const h = harness();
        h.practice.resume();
        await h.advance(60_000);
        expect(h.played.length).toBeGreaterThan(5);
        expect(h.seen[0]).toMatchObject({ episode: 1, pass: 1 });
    });

    it('stops at once when put down, and plays the interrupted pass again when picked up', async () => {
        const h = harness();
        h.practice.resume();
        await h.advance(500); // halfway through the first pass
        const interrupted = h.played[h.played.length - 1];
        const count = h.played.length;
        h.practice.pause();
        expect(h.practice.playing).toBe(false);
        expect(h.silenced()).toBe(1);
        expect(h.seen[h.seen.length - 1]).toBeNull();

        await h.advance(60_000);
        expect(h.played.length).toBe(count);

        h.practice.resume();
        await h.advance(10);
        expect(h.played[count]).toBe(interrupted);
    });

    it('plays on with the next pass when put down between passes', async () => {
        const h = harness();
        h.practice.resume();
        await h.advance(1001); // the first pass is over; he is drawing breath
        h.practice.pause();
        h.practice.resume();
        await h.advance(10);
        expect(h.played).toHaveLength(2);
        expect(h.played[1]).not.toBe(h.played[0]);
    });

    it('starts the next session when one is over', async () => {
        const h = harness();
        h.practice.resume();
        await h.advance(4 * 60 * 60_000);
        const seeds = new Set(h.seen.filter((n): n is PracticeNow => n !== null).map((n) => n.seed));
        expect(seeds.size).toBeGreaterThan(1);
    });

    it('ignores a second resume while playing', async () => {
        const h = harness();
        h.practice.resume();
        h.practice.resume();
        await h.advance(10);
        expect(h.played).toHaveLength(1);
    });
});
