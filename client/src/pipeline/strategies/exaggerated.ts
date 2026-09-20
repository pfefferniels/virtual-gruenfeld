import { allDimensions, counterPerformance } from '../../mpm';
import { appendSustainTail } from '../../pianosound/midiSequence';
import { perform } from '../../services/mpmRenderer';
import type { TeacherStrategy } from '../types';

export const exaggeratedStrategy: TeacherStrategy = async (ctx, take, controls) => {
    const { log, isCancelled, play, takeStartedAt } = controls;

    // Built from the reference **text** every time, so the splice can never come to share a
    // document with the editorial reference it was copied from (semantics 30).
    const counterMpm = counterPerformance({
        referenceMpmText: ctx.referenceMpmText,
        range: take.range,
        dimensions: allDimensions(),
        peaks: take.peaks,
        measured: take.measuredTypes,
        log,
    });

    const performStartedAt = Date.now();
    const midi = perform(ctx.mei, counterMpm, take.range);
    log(`PLAY: correction perform_ms=${Date.now() - performStartedAt}`);
    if (isCancelled() || !midi) return;

    log(`PLAY: time_to_play_ms=${Date.now() - takeStartedAt}`);
    play(appendSustainTail(midi));
};
