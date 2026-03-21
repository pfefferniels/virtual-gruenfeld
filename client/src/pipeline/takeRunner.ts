import type { MSM } from 'mpmify';
import { mpmify, diff, diffStructured } from '../mpm';
import type { Range } from '../mpm';
import { summarizeImmediateJudgement } from '../judgement';
import { REALTIME_PLAYBACK_DEADLINE_MS } from '../cueLibrary';
import type { PipelineContext, TeacherStrategy, TakeRunnerControls } from './types';

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
            onJudgement: controls.onJudgement,
            aiAvailable: controls.aiAvailable,
        });
    } catch (e) {
        controls.log(`PERFORM error: ${e}`);
    }
};
