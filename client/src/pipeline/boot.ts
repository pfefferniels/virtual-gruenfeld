/**
 * Boot: the three documents the app runs on, and nothing derived that they already state.
 *
 * What used to happen here was a reconstruction — `asMSM` re-read the roll's `<when>` timings
 * out of the MEI, and `mpmify` replayed 494 transformer calls over `info.json` to *manufacture*
 * a reference performance whose instruction ids the diff could join on. Grünfeld's document
 * already prints those ids (`<tempo xml:id="tempo_720" …>`), so the reference is now simply
 * fetched: `performance.mpm`, the same file the server's corpus reads.
 *
 * Three things are loaded or derived, once:
 *
 * | what | from | why |
 * |---|---|---|
 * | `scoreMsm` | `convert(score.mei)`, memoized in `services/mpmRenderer` | the comparison's metric: window, measures, beat grid; the fitter's time signature |
 * | `referenceMpmText` | `client/public/performance.mpm` | the scaffold (`readScaffold`), the comparison side's own playing, and the counter-performance's base |
 * | `scoreNotes` | one render of the reference over the score | the matcher's reference side, for the take *and* for the per-take reference fit |
 *
 * That render is the only derivation, and it is the one thing neither text states: what
 * Grünfeld's document *sounds* like, note by note. It replaces `asMSM`'s `<when>` reading with
 * the same information taken from the document the rest of the pipeline is about (semantics
 * 35). ~40 ms.
 *
 * There is no second reference document. The comparison side used to be a committed asset,
 * `reference.fitted.mpm`; it is now fitted per take, inside the evidence worker, over the take's
 * own range and through the take's own MIDI path — which is what makes an identity take say
 * nothing (`mpm/evidence.ts`).
 */
import { performMsmToData } from 'espressivo';
import { loadReferenceMpm, parseReferenceMpm } from '../mpm/reference';
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

    log('FETCH: performance.mpm');
    const referenceMpmText = await loadReferenceMpm();
    log(`FETCH: reference ok (bytes=${referenceMpmText.length})`);

    // Throws on a document that is not 720 ppq or has no performance — an error page is not a
    // reference, and a take is the wrong moment to find that out. The parse is discarded (the
    // take re-reads the scaffold from the text, in the worker); it costs ~10 ms, which is the
    // price of failing at boot instead of on the student's first phrase.
    startedAt = Date.now();
    parseReferenceMpm(referenceMpmText);
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
            // Folded like the score: the mood chord groups the reduction by date, so a pitch
            // written twice in one chord would be struck twice and counted twice.
            reductionNotes = withoutUnisons(measuredNotesFromMsmText(convert(reductionMei)));
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
        reductionMei,
        reductionNotes,
    };
};
