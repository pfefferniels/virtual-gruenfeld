/**
 * Boot: the three documents the app runs on, and nothing derived that they already state.
 *
 * What used to happen here was a reconstruction — `asMSM` re-read the roll's `<when>` timings
 * out of the MEI, and `mpmify` replayed 494 transformer calls over `info.json` to *manufacture*
 * a reference performance whose instruction ids the diff could join on. Grünfeld's document
 * already prints those ids (`<tempo xml:id="tempo_720" …>`), so the reference is now simply
 * fetched: `performance.mpm`, the same file the server's corpus reads.
 *
 * Four things are loaded or derived, once:
 *
 * | what | from | why |
 * |---|---|---|
 * | `scoreMsm` | `convert(score.mei)`, memoized in `services/mpmRenderer` | the comparison's metric: window, measures, beat grid; the fitter's time signature |
 * | `referenceMpmText` | `client/public/performance.mpm` | the scaffold (`readScaffold`) and the counter-performance's base |
 * | `fittedReferenceMpmText` | `client/public/reference.fitted.mpm` | the comparison side, so that fit is compared with fit (S4 §2) |
 * | `scoreNotes` | one render of the reference over the score | the matcher's reference side, and the take's own starting point |
 *
 * That render is the only derivation, and it is the one thing neither text states: what
 * Grünfeld's document *sounds* like, note by note. It replaces `asMSM`'s `<when>` reading with
 * the same information taken from the document the rest of the pipeline is about (semantics
 * 35), and it is exactly the note array the fitter's own fixtures are built from
 * (`scripts/fit-reference.ts`), so a student who plays the roll back gets the behaviour the
 * tests measured. ~40 ms.
 */
import { performMsmToData } from 'espressivo';
import { loadFittedReferenceMpm, loadReferenceMpm, parseReferenceMpm } from '../mpm/reference';
import { measuredNotesFromMsmText, measuredNotesFromPerformanceData, withoutUnisons } from '../score/measured';
import { assertOk } from '../services/api';
import { convert } from '../services/mpmRenderer';
import type { PipelineContext } from './types';

const fetchText = async (url: string): Promise<string> => {
    const response = await fetch(url);
    await assertOk(response);
    return response.text();
};

export const boot = async (
    log: (msg: string) => void,
): Promise<PipelineContext> => {
    log('APP: boot');

    log('FETCH: score.mei');
    const mei = await fetchText('score.mei');
    log(`FETCH: score.mei ok (bytes=${mei.length})`);

    log('MSM: convert(score.mei)…');
    let startedAt = Date.now();
    const scoreMsm = convert(mei);
    log(`MSM: ready (bytes=${scoreMsm.length}, ms=${Date.now() - startedAt})`);

    log('FETCH: performance.mpm + reference.fitted.mpm');
    const [referenceMpmText, fittedReferenceMpmText] = await Promise.all([
        loadReferenceMpm(),
        loadFittedReferenceMpm(),
    ]);
    log(`FETCH: reference ok (editorial=${referenceMpmText.length} B, fitted=${fittedReferenceMpmText.length} B)`);

    // Throws on a document that is not 720 ppq or has no performance — an error page is not a
    // reference, and a take is the wrong moment to find that out. Both parses are discarded
    // (the take re-reads the scaffold from the text, in the worker); together they cost 19 ms,
    // which is the price of failing at boot instead of on the student's first phrase.
    startedAt = Date.now();
    parseReferenceMpm(referenceMpmText);
    parseReferenceMpm(fittedReferenceMpmText);
    log(`MPM: reference validated (ms=${Date.now() - startedAt})`);

    log('SCORE: rendering the reference for the matcher…');
    startedAt = Date.now();
    const performed = measuredNotesFromPerformanceData(
        performMsmToData({ msm: scoreMsm, mpm: referenceMpmText }, { expandOrnaments: false }),
    );
    const scoreNotes = withoutUnisons(performed);
    log(`SCORE: ${scoreNotes.length} notes, ${performed.length - scoreNotes.length} unisons folded (ms=${Date.now() - startedAt})`);

    // Load harmonic reduction (optional — the mood chord needs it)
    let reductionMei: string | undefined;
    let reductionNotes: PipelineContext['reductionNotes'];
    try {
        const reductionResp = await fetch('harmonic_reduction.mei');
        if (reductionResp.ok) {
            reductionMei = await reductionResp.text();
            log(`FETCH: harmonic_reduction.mei ok (bytes=${reductionMei.length})`);
            reductionNotes = measuredNotesFromMsmText(convert(reductionMei));
            log(`MSM: reduction ready (notes=${reductionNotes.length})`);
        }
    } catch (e) {
        log(`BOOT: harmonic reduction not available (${e})`);
    }

    return {
        mei,
        scoreMsm,
        scoreNotes,
        referenceMpmText,
        fittedReferenceMpmText,
        reductionMei,
        reductionNotes,
    };
};
