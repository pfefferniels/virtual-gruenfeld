/**
 * The committed fitted reference, and the guarantee that it is what the script says it is.
 *
 * `client/public/reference.fitted.mpm` is a generated asset in a repository that generates
 * almost nothing, so it needs the one thing a generated asset needs: a test that regenerates it
 * and compares the bytes. If the fitter changes — a window width, a rounding digit, an
 * acceptance rule — this fails, and the person who changed it has to look at what it did to the
 * document every take is measured against.
 *
 * That the comparison happens byte for byte rather than "close enough" is S3's determinism
 * guarantee cashed in: every random draw is seeded off the data it fits and every written number
 * is rounded at the write boundary.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    FITTED_PERFORMANCE_NAME,
    FITTED_REFERENCE_PATH,
    fitReference,
} from '../../../scripts/fit-reference';
import { readInstructions, type InstructionIndex } from './pair';
import { FITTED_REFERENCE_MPM_URL, REFERENCE_MPM_URL, parseReferenceMpm } from './reference';

const load = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const referenceText = load('../../public/performance.mpm');
const committed = load('../../public/reference.fitted.mpm');

describe('client/public/reference.fitted.mpm', () => {
    it('is exactly what `npx tsx scripts/fit-reference.ts` writes', () => {
        expect(FITTED_REFERENCE_PATH.endsWith('client/public/reference.fitted.mpm')).toBe(true);
        expect(fitReference()).toBe(committed);
    }, 30_000);

    it('is a second fit of the same performance, not a copy of it', () => {
        expect(committed).not.toBe(referenceText);
        expect(committed.length).toBeLessThan(referenceText.length);
        // The editorial document's provenance does not travel: `@corresp` links the corpus
        // argumentations to `performance.mpm`, which stays the server's document.
        expect(referenceText).toContain('corresp=');
        expect(committed).not.toContain('corresp=');
    });

    it('says which side it is', () => {
        expect(committed).toContain(`<performance name="${FITTED_PERFORMANCE_NAME}"`);
        const mpm = parseReferenceMpm(committed);
        expect(mpm.getPerformance(0)?.getPulsesPerQuarter()).toBe(720);
    });

    it('writes into Grünfeld’s own slots and invents none of its own', () => {
        const editorial = readInstructions(parseReferenceMpm(referenceText));
        const fitted = readInstructions(parseReferenceMpm(committed));

        expect(fitted.all.length).toBeGreaterThan(300);
        for (const instruction of fitted.all) {
            const original = editorial.byId.get(`${instruction.type}::${instruction.xmlId}`);
            expect(original, `${instruction.type}::${instruction.xmlId}`).toBeDefined();
            expect(original?.date).toBe(instruction.date);
        }
    });

    it('leaves out the slots the fit could not answer for, rather than guessing', () => {
        const editorial = readInstructions(parseReferenceMpm(referenceText));
        const fitted = readInstructions(parseReferenceMpm(committed));
        const countOf = (index: InstructionIndex, type: string): number =>
            index.all.filter((i) => i.type === type).length;

        // A `<rubato>` is written only where it cuts the residual by 20 % (risk R5), so the
        // fitted document has fewer of them than the editorial one — by design, and the same
        // rule the student's own document is written under.
        expect(countOf(fitted, 'rubato')).toBeLessThan(countOf(editorial, 'rubato'));
        expect(countOf(fitted, 'tempo')).toBeGreaterThan(countOf(editorial, 'tempo') * 0.8);
        expect(countOf(fitted, 'ornament')).toBeGreaterThan(countOf(editorial, 'ornament') * 0.8);
    });

    it('is served from its own URL, beside the reference it was fitted from', () => {
        expect(REFERENCE_MPM_URL).toBe('performance.mpm');
        expect(FITTED_REFERENCE_MPM_URL).toBe('reference.fitted.mpm');
    });
});
