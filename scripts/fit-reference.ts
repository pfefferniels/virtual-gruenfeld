/**
 * Generate `client/public/reference.fitted.mpm` — Grünfeld's own playing, written by the
 * student's fitter.
 *
 * Risk R2's fallback, taken. `performance.mpm` is a *bake*: its sixty `<tempo>` elements were
 * drawn by hand in mpm-desk, and `@bpm` there is an editorial instantaneous value on a curve
 * that swings 37→89 bpm inside a bar. The student's are *solved* from onsets that carry that
 * tempo, a rubato warp and a rolled chord at once. S3 measured what that difference costs on a
 * take where the playing is identical: 22 bpm on tempo, 9.2 JND aggregate — far over the diff's
 * own noise floor, so a student who played the roll back perfectly would be told, in German and
 * with a severity band attached, that their tempo was wrong.
 *
 * Two ways of writing one performance are not comparable; two runs of one procedure are. So the
 * comparison side is fitted too:
 *
 *     performMsmToData(score, performance.mpm) → MeasuredNote[] → fitStudent → this file
 *
 * The bias is then on both sides of every subtraction and cancels by construction. What this
 * costs is stated plainly: the `refValue` numbers the teacher's evidence quotes come from this
 * document, while the scholarly prose (`info.json`, the corpus argumentations) is about the
 * editorial one. `performance.mpm` remains the counter-performance's base, the server's
 * document and the scaffold every `xml:id` is read from — the two files carry the same ids, in
 * the same slots, because that is what the fitter writes into.
 *
 * Deterministic: S3's fitter seeds every random draw off the data it is fitting and rounds at
 * the write boundary, so this script is a pure function of two committed inputs.
 * `client/src/mpm/fittedReference.test.ts` asserts the committed bytes equal a fresh run.
 *
 *     npx tsx scripts/fit-reference.ts            # writes the file
 *     npx tsx scripts/fit-reference.ts --check    # exits 1 if the committed file is stale
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Mpm, performMsmToData } from 'espressivo';
import { parseReferenceMpm } from '../client/src/mpm/reference';
import type { Range } from '../client/src/mpm/types';
import { measuredNotesFromPerformanceData } from '../client/src/score/measured';
import { convert } from '../client/src/services/mpmRenderer';
import { fitStudent } from '../client/src/student/fit';
import { readScaffold } from '../client/src/student/scaffold';

const at = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export const SCORE_MEI_PATH = at('../client/public/score.mei');
export const REFERENCE_MPM_PATH = at('../client/public/performance.mpm');
export const FITTED_REFERENCE_PATH = at('../client/public/reference.fitted.mpm');

/** Ticks per quarter and per bar — 720 and 4/4, the grid the whole project speaks. */
const PPQ = 720;
const TICKS_PER_BAR = 4 * PPQ;

/**
 * The name the fitted document declares.
 *
 * `fitStudent` writes `<performance name="student">` because that is what it is for; this
 * document is the same procedure pointed at Grünfeld, and a file whose only reader is the
 * comparison should say which side it is. Nothing keys on the name — `compareMpm`,
 * `readScaffold` and `cutToRange` all take performance 0 — so this is legibility, not
 * behaviour.
 */
export const FITTED_PERFORMANCE_NAME = 'gruenfeld-fitted';

/**
 * The whole piece, rounded up to a bar line.
 *
 * Derived from the reference's own last sounding note rather than stated, so that a change to
 * the score or the roll cannot silently leave the last bars unfitted. `readScaffold` takes a
 * half-open range and `fitStudent` reads spans out of it, so the end has to sit past every
 * date, not on the last one.
 */
const wholePiece = (notes: readonly { date: number }[]): Range => {
    const last = notes.reduce((max, note) => Math.max(max, note.date), 0);
    return { from: 0, to: Math.ceil((last + 1) / TICKS_PER_BAR) * TICKS_PER_BAR };
};

/**
 * Fit the reference against itself, over the whole piece in one call.
 *
 * One call rather than slot-wise: `fitStudent` is not take-scoped — it reads the slots the
 * scaffold hands it and fits each against the onsets around it — and fitting the piece whole is
 * what makes every slot's span the one its neighbours give it (S3's `spansOf`), exactly as a
 * take does inside its window. `expandOrnaments: false` mirrors the fitter's own residual
 * renders: a v3 ornament that generated notes would put notes in the measurement that no
 * playing produced, and the v2 ornaments this reconstruction is made of are unaffected.
 */
export const fitReference = (): string => {
    const mei = readFileSync(SCORE_MEI_PATH, 'utf8');
    const referenceText = readFileSync(REFERENCE_MPM_PATH, 'utf8');

    const scoreMsm = convert(mei);
    const notes = measuredNotesFromPerformanceData(
        performMsmToData({ msm: scoreMsm, mpm: referenceText }, { expandOrnaments: false }),
    );

    const range = wholePiece(notes);
    const scaffold = readScaffold(parseReferenceMpm(referenceText), range);
    const { studentMpmText } = fitStudent(notes, scaffold, scoreMsm);

    const fitted = new Mpm(studentMpmText);
    fitted.getPerformance(0)?.setName(FITTED_PERFORMANCE_NAME);

    const text = fitted.writeMpm();
    if (text === null) throw new Error('fit-reference: the fitted document could not be serialized');
    return text;
};

const main = (): void => {
    const fitted = fitReference();
    const check = process.argv.includes('--check');

    if (check) {
        const committed = readFileSync(FITTED_REFERENCE_PATH, 'utf8');
        if (committed === fitted) {
            process.stdout.write(`reference.fitted.mpm is up to date (${fitted.length} bytes)\n`);
            return;
        }
        process.stderr.write('reference.fitted.mpm is STALE — run `npx tsx scripts/fit-reference.ts`\n');
        process.exitCode = 1;
        return;
    }

    writeFileSync(FITTED_REFERENCE_PATH, fitted, 'utf8');
    process.stdout.write(`wrote ${FITTED_REFERENCE_PATH} (${fitted.length} bytes)\n`);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
