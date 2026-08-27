/**
 * The seeded generator, and the one property it exists for.
 *
 * `random.ts` is copied from mpm-desk, and this is the test that keeps the copy honest
 * (risk R11): if the generator ever drifts, every annealed curve in every fitted take moves
 * with it, and the byte-identity the take pipeline promises quietly stops holding. The four
 * sequence values below are what mulberry32 emits for seed 42 — they are a fingerprint, not a
 * requirement about distribution.
 */
import { describe, expect, it } from 'vitest';
import { hashSeed, seededRandom } from './random';

describe('seededRandom', () => {
    it('emits the same sequence for the same seed', () => {
        const a = seededRandom(1234);
        const b = seededRandom(1234);
        const first = [a(), a(), a(), a(), a()];
        const second = [b(), b(), b(), b(), b()];
        expect(first).toEqual(second);
    });

    it('emits a different sequence for a different seed', () => {
        const a = seededRandom(1);
        const b = seededRandom(2);
        expect([a(), a(), a()]).not.toEqual([b(), b(), b()]);
    });

    it('is mulberry32 — the fingerprint of seed 42', () => {
        const random = seededRandom(42);
        const drawn = [random(), random(), random(), random()];
        expect(drawn.map((value) => Number(value.toFixed(12)))).toEqual([
            0.60110375192, 0.448290558998, 0.85246579349, 0.669734041439,
        ]);
    });

    it('stays inside [0, 1), which is what `fitTransitionCurve` assumes of it', () => {
        const random = seededRandom(0xdecafbad);
        for (let i = 0; i < 2000; i++) {
            const value = random();
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(1);
        }
    });
});

describe('hashSeed', () => {
    it('is FNV-1a: the offset basis for the empty string, and its known steps', () => {
        expect(hashSeed('')).toBe(2166136261);
        expect(hashSeed('a')).toBe(3826002220);
    });

    it('handles the non-ASCII a German corpus is full of', () => {
        expect(hashSeed('Grünfeld')).toBe(1122607403);
        expect(hashSeed('Grünfeld')).not.toBe(hashSeed('Grunfeld'));
    });

    it('is an unsigned 32-bit value, so it can be fed to the generator as-is', () => {
        for (const text of ['', 'a', 'Träumerei', JSON.stringify({ date: 720, value: 41 })]) {
            const seed = hashSeed(text);
            expect(Number.isInteger(seed)).toBe(true);
            expect(seed).toBeGreaterThanOrEqual(0);
            expect(seed).toBeLessThan(2 ** 32);
        }
    });

    it('makes the seed a function of the data, which is the whole point', () => {
        const points = [
            { date: 0, value: 41 },
            { date: 720, value: 44 },
        ];
        expect(hashSeed(JSON.stringify(points))).toBe(hashSeed(JSON.stringify([...points])));
        expect(hashSeed(JSON.stringify(points))).not.toBe(
            hashSeed(JSON.stringify([...points, { date: 1440, value: 40 }])),
        );
    });
});
