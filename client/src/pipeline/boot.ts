/**
 * Boot: the three documents the app runs on, and nothing derived that they already state.
 *
 * They are fetched from the reconstruction's own home, `welte225.org/mpm`, which several
 * projects read. This repository keeps no copy, so there is no version here to drift.
 *
 * | what | from | why |
 * |---|---|---|
 * | `scoreMsm` | `score.msm` | the comparison's metric: window, measures, beat grid; the fitter's time signature. Published, so it is the MSM the reconstruction was fitted against rather than a re-derivation |
 * | `mei` | `transcription.mei` | `perform(mei, mpm, range)` renders a passage from it |
 * | `referenceMpmText` | `performance.mpm` | the scaffold (`readScaffold`), the comparison side's own playing, and the counter-performance's base |
 * | `scoreNotes` | one render of the reference over the score | the matcher's reference side, for the take *and* for the per-take reference fit |
 *
 * That render is the only derivation, and it is the one thing no text states: what Grünfeld's
 * document *sounds* like, note by note. ~40 ms.
 *
 * There is no second reference document. The comparison side is fitted per take, inside the
 * evidence worker, over the take's own range and through the take's own MIDI path — which is
 * what makes an identity take say nothing (`mpm/evidence.ts`).
 */
import { performMsmToData } from 'espressivo';
import { loadReferenceMpm, parseReferenceMpm, RECONSTRUCTION_BASE } from '../mpm/reference';
import { measuredNotesFromPerformanceData, withoutUnisons } from '../score/measured';
import { assertOk } from '../services/api';
import type { PipelineContext } from './types';

const fetchText = async (name: string): Promise<string> => {
    const response = await fetch(`${RECONSTRUCTION_BASE}/${name}`);
    await assertOk(response);
    return response.text();
};

export const boot = async (
    log: (msg: string) => void,
): Promise<PipelineContext> => {
    log('APP: boot');

    log(`FETCH: ${RECONSTRUCTION_BASE}`);
    const [mei, scoreMsm, referenceMpmText] = await Promise.all([
        fetchText('transcription.mei'),
        fetchText('score.msm'),
        loadReferenceMpm(),
    ]);
    log(`FETCH: ok (mei=${mei.length}, msm=${scoreMsm.length}, mpm=${referenceMpmText.length})`);

    // Throws on a document that is not 720 ppq or has no performance — an error page is not a
    // reference, and a take is the wrong moment to find that out. The parse is discarded (the
    // take re-reads the scaffold from the text, in the worker); it costs ~10 ms, which is the
    // price of failing at boot instead of on the student's first phrase.
    let startedAt = Date.now();
    parseReferenceMpm(referenceMpmText);
    log(`MPM: reference validated (ms=${Date.now() - startedAt})`);

    log('SCORE: rendering the reference for the matcher…');
    startedAt = Date.now();
    const performed = measuredNotesFromPerformanceData(
        performMsmToData({ msm: scoreMsm, mpm: referenceMpmText }, { expandOrnaments: false }),
    );
    const scoreNotes = withoutUnisons(performed);
    log(`SCORE: ${scoreNotes.length} notes, ${performed.length - scoreNotes.length} unisons folded (ms=${Date.now() - startedAt})`);

    return {
        mei,
        scoreMsm,
        scoreNotes,
        referenceMpmText,
    };
};
