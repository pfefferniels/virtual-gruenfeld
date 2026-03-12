import { asMSM, asMSMBasic } from '../asMSM';
import { assertOk, warmPerformEndpoint } from '../api';
import { mpmify } from '../mpm';
import type { PipelineContext } from './types';

export const boot = async (
    log: (msg: string) => void,
): Promise<PipelineContext> => {
    log('APP: boot');

    log('FETCH: info.json');
    let response = await fetch('info.json');
    await assertOk(response);
    const transformations = await response.text();
    log(`FETCH: info.json ok (bytes=${transformations.length})`);

    log('FETCH: score.mei');
    response = await fetch('score.mei');
    await assertOk(response);
    const mei = await response.text();
    log(`FETCH: score.mei ok (bytes=${mei.length})`);

    log('MSM: asMSM(score.mei)…');
    const baseMsm = await asMSM(mei);
    log(`MSM: ready (notes=${JSON.stringify(baseMsm.allNotes[0]) ?? 'unknown'})`);

    log('MPM: building referenceMpm…');
    const referenceMpm = mpmify(baseMsm, transformations, { log });
    log(`MPM: referenceMpm ready (instructions=${referenceMpm.getInstructions().length})`);

    warmPerformEndpoint();

    // Load harmonic reduction (optional — two-pass mode requires it)
    let reductionMei: string | undefined;
    let reductionMsm: PipelineContext['reductionMsm'];
    try {
        const reductionResp = await fetch('harmonic_reduction.mei');
        if (reductionResp.ok) {
            reductionMei = await reductionResp.text();
            log(`FETCH: harmonic_reduction.mei ok (bytes=${reductionMei.length})`);
            reductionMsm = await asMSMBasic(reductionMei);
            log(`MSM: reduction ready (notes=${reductionMsm.allNotes.length})`);
        }
    } catch (e) {
        log(`BOOT: harmonic reduction not available (${e})`);
    }

    return { mei, transformations, baseMsm, referenceMpm, reductionMei, reductionMsm };
};
