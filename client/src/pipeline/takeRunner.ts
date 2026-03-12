import type { MSM } from 'mpmify';
import { mpmify, diff, diffStructured } from '../mpm';
import type { Range } from '../mpm';
import { summarizeImmediateJudgement, fallbackImmediateJudgement } from '../judgement';
import { requestImmediateJudgement, requestSpokenJudgement } from '../api';
import { REALTIME_PLAYBACK_DEADLINE_MS } from '../cueLibrary';
import type { PipelineContext, TeacherStrategy, TakeRunnerControls } from './types';

const QUICK_JUDGEMENT_BUDGET_MS = 450;

export const runTake = async (
    ctx: PipelineContext,
    studentMsm: MSM,
    range: Range,
    strategy: TeacherStrategy,
    controls: TakeRunnerControls,
): Promise<void> => {
    const takeStartedAt = Date.now();
    controls.stop();
    controls.log(`CALLBACK: take implanted -> range=[${range.from}, ${range.to}]`);

    controls.log('MPM: building studentMpm…');
    const studentMpm = mpmify(studentMsm, ctx.transformations, { referenceMsm: ctx.baseMsm, log: controls.log });
    controls.log(`MPM: studentMpm ready (instructions=${studentMpm.getInstructions().length})`);

    const referenceMpmClone = ctx.referenceMpm.clone();

    const diffSummary = diff(ctx.referenceMpm, studentMpm, range);
    const structuredDiff = diffStructured(ctx.referenceMpm, studentMpm, range);
    const judgementSummary = summarizeImmediateJudgement(structuredDiff, range);

    controls.onDiff(diffSummary);
    controls.onJudgement('');

    const mode = controls.mode;
    const fallback = fallbackImmediateJudgement(judgementSummary);
    const judgementStartedAt = Date.now();
    const judgementPromise = requestImmediateJudgement(judgementSummary, controls.log)
        .then((text) => {
            controls.log(`JUDGE: judgement_ms=${Date.now() - judgementStartedAt}`);
            if (!controls.isCancelled() && text) {
                controls.onJudgement(text);
            }
            return text;
        })
        .catch((e) => {
            controls.log(`JUDGE error: ${e}`);
            return '';
        });
    const spokenJudgementPromise = judgementPromise
        .then(async (text) => {
            const spokenText = text || fallback;
            if (!spokenText) return null;
            const audioBuffer = await requestSpokenJudgement(spokenText, controls.audioContext, controls.log);
            if (!audioBuffer) return null;
            return { text: spokenText, audioBuffer };
        })
        .catch((e) => {
            controls.log(`JUDGE audio error: ${e}`);
            return null;
        });
    window.setTimeout(() => {
        if (!controls.isCancelled()) {
            controls.onJudgement((prev) => prev || fallback);
        }
    }, QUICK_JUDGEMENT_BUDGET_MS);

    const playbackDeadlineAt = mode === 'realtime'
        ? Date.now() + REALTIME_PLAYBACK_DEADLINE_MS
        : undefined;

    controls.log(`CUE: mode=${mode}`);

    try {
        await strategy(ctx, {
            studentMpm,
            referenceMpmClone,
            diffSummary,
            structuredDiff,
            judgementSummary,
            spokenJudgementPromise,
            range,
        }, {
            log: controls.log,
            isCancelled: controls.isCancelled,
            play: controls.play,
            playAudioBuffer: controls.playAudioBuffer,
            audioContext: controls.audioContext,
            mode,
            playbackDeadlineAt,
            takeStartedAt,
        });
    } catch (e) {
        controls.log(`PERFORM error: ${e}`);
    }

    void judgementPromise;
};
