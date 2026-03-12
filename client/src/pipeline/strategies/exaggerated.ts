import { exaggerate, detectLargeScaleDeviation } from '../../mpm';
import type { Range, StructuredDiffEvent } from '../../mpm';
import { performTeacherPlayback, resolveTeacherCues, requestTeacherCuePlan, prepareTeacherCues } from '../../api';
import type { PreparedTeacherCue } from '../../api';
import { REALTIME_PLAN_BUDGET_MS } from '../../cueLibrary';
import type { TeacherCueDraft } from '../../teacherCues';
import { appendMidiWithOffset, millisecondsToMidiTicks, offsetCueTimes } from '../../pianosound/midiSequence';
import type { MidiFile } from 'midifile-ts';
import {
    buildJudgementMoodRenderPlan,
    JUDGEMENT_MOOD_PEDAL_BUFFER_MS,
} from '../judgementMood';
import type { TeacherStrategy, PipelineContext, TakeSnapshot, StrategyControls, SpokenJudgement } from '../types';

const playJudgementPreamble = async (
    take: TakeSnapshot,
    controls: StrategyControls,
) => {
    const { log, isCancelled, playAudioBuffer } = controls;
    const spokenJudgement = await take.spokenJudgementPromise;
    if (!spokenJudgement || isCancelled()) return;

    log(`PLAY: spoken judgement "${spokenJudgement.text}"`);
    await playAudioBuffer(spokenJudgement.audioBuffer, () => {
        log(`PLAY: spoken judgement start (duration_ms=${Math.round(spokenJudgement.audioBuffer.duration * 1000)})`);
    });
};

// ── Shared cue planning + playback helper ──

const planAndPrepareCues = async (
    diffSummary: string,
    diffEvents: StructuredDiffEvent[],
    timingMap: Parameters<typeof resolveTeacherCues>[1],
    mode: StrategyControls['mode'],
    audioContext: AudioContext,
    playbackDeadlineAt: number | undefined,
    log: (msg: string) => void,
    label: string,
): Promise<PreparedTeacherCue[]> => {
    const planStartedAt = Date.now();
    const cueDraftPromise = requestTeacherCuePlan(diffSummary, diffEvents, mode, timingMap, log)
        .then((drafts) => {
            log(`CUE(${label}): plan_ms=${Date.now() - planStartedAt} drafted=${drafts.length}`);
            return drafts;
        })
        .catch((e) => {
            log(`CUE(${label}) plan error: ${e}`);
            return [] as TeacherCueDraft[];
        });

    let drafted: TeacherCueDraft[] = [];
    if (mode === 'realtime') {
        const remainingMs = Math.max(0, Math.min(
            (playbackDeadlineAt ?? Date.now()) - Date.now(),
            REALTIME_PLAN_BUDGET_MS,
        ));
        drafted = await Promise.race([
            cueDraftPromise,
            new Promise<TeacherCueDraft[]>((resolve) => window.setTimeout(() => resolve([]), remainingMs)),
        ]);
    } else {
        drafted = await cueDraftPromise;
    }

    const cuePlan = resolveTeacherCues(diffEvents, timingMap, drafted);
    try {
        return await prepareTeacherCues(cuePlan, audioContext, log, mode, playbackDeadlineAt);
    } catch (e) {
        log(`CUE(${label}) prepare error: ${e}`);
        return [];
    }
};

const playWithCues = (
    midi: MidiFile,
    cues: PreparedTeacherCue[],
    play: StrategyControls['play'],
    log: (msg: string) => void,
    label: string,
    spokenJudgement?: SpokenJudgement,
) => {
    log(`PLAY(${label}): starting (cues=${cues.length})`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    play(midi as any, undefined, ({ scheduleAudioCue }) => {
        if (spokenJudgement) {
            scheduleAudioCue({
                atSec: 0,
                audioBuffer: spokenJudgement.audioBuffer,
                onStart: () => {
                    log(`PLAY: spoken judgement start (duration_ms=${Math.round(spokenJudgement.audioBuffer.duration * 1000)})`);
                },
            });
        }
        for (const cue of cues) {
            scheduleAudioCue({
                atSec: cue.atSec,
                audioBuffer: cue.audioBuffer,
                onStart: () => {
                    log(`CUE(${label}): trigger "${cue.text}" at ${cue.atSec.toFixed(2)}s`);
                },
            });
        }
    });
};

// ── Two-pass: reduction then full ──

const twoPassPlayback = async (
    ctx: PipelineContext,
    take: TakeSnapshot,
    controls: StrategyControls,
    deviationRange: Range,
) => {
    const { log, isCancelled, play, audioContext, mode, playbackDeadlineAt, takeStartedAt } = controls;

    exaggerate(take.referenceMpmClone, take.studentMpm, take.range, 0.2, log);

    // Filter diff events to the deviation range
    const inDevRange = (e: StructuredDiffEvent) =>
        e.date >= deviationRange.from && e.date <= deviationRange.to;
    const fullDiff = take.structuredDiff.filter(inDevRange);
    const spokenJudgement = await take.spokenJudgementPromise;
    const fullEntryMs = spokenJudgement ? spokenJudgement.audioBuffer.duration * 1000 : 0;
    const moodPlan = buildJudgementMoodRenderPlan(
        ctx.reductionMsm!,
        ctx.baseMsm,
        take.referenceMpmClone,
        deviationRange.from,
        { minimumPedalHoldMs: fullEntryMs + JUDGEMENT_MOOD_PEDAL_BUFFER_MS },
    );

    const performStartedAt = Date.now();
    const [moodPerf, fullPerf] = await Promise.all([
        moodPlan
            ? performTeacherPlayback(ctx.reductionMei!, ctx.reductionMsm!, moodPlan.mpm as any, moodPlan.range)
            : Promise.resolve(undefined),
        performTeacherPlayback(ctx.mei, ctx.baseMsm, take.referenceMpmClone, deviationRange),
    ]);
    log(`PLAY: two-pass perform_ms=${Date.now() - performStartedAt}`);
    if (isCancelled() || !fullPerf) return;

    const fullCues = await planAndPrepareCues(
        take.diffSummary, fullDiff, fullPerf.timingMap,
        mode, audioContext, playbackDeadlineAt, log, 'full',
    );
    if (isCancelled()) return;

    log(`PLAY: time_to_play_ms=${Date.now() - takeStartedAt}`);
    if (moodPerf && moodPlan) {
        const fullEntrySec = fullEntryMs / 1000;
        const connectedMidi = appendMidiWithOffset(
            moodPerf.midi,
            fullPerf.midi,
            millisecondsToMidiTicks(moodPerf.midi, fullEntryMs),
        );
        const connectedCues = offsetCueTimes(fullCues, fullEntrySec);
        log(
            `PLAY: mood chord ready (date=${moodPlan.chordDate}, notes=${moodPlan.noteCount}, ` +
            `range=[${moodPlan.renderFrom}, ${moodPlan.renderTo}], full_entry_ms=${Math.round(fullEntryMs)})`,
        );
        if (spokenJudgement) {
            log(`PLAY: spoken judgement over mood chord "${spokenJudgement.text}"`);
        }
        playWithCues(connectedMidi, connectedCues, play, log, 'two-pass', spokenJudgement ?? undefined);
    } else {
        log('PLAY: mood chord unavailable, falling back to spoken judgement then full playback');
        await playJudgementPreamble(take, controls);
        if (isCancelled()) return;
        playWithCues(fullPerf.midi, fullCues, play, log, 'full');
    }
};

// ── Main strategy ──

export const exaggeratedStrategy: TeacherStrategy = async (ctx, take, controls) => {
    const { log, isCancelled, play, audioContext, mode, playbackDeadlineAt, takeStartedAt } = controls;

    // Check for large-scale deviation → two-pass mode
    const deviationRange = ctx.reductionMei && ctx.reductionMsm
        ? detectLargeScaleDeviation(take.structuredDiff, take.range)
        : null;

    if (deviationRange) {
        log(`TWO-PASS: large-scale deviation in [${deviationRange.from}, ${deviationRange.to}]`);
        await twoPassPlayback(ctx, take, controls, deviationRange);
        return;
    }

    // ── Normal single-pass ──

    exaggerate(take.referenceMpmClone, take.studentMpm, take.range, 0.2, log);

    const performStartedAt = Date.now();
    const performance = await performTeacherPlayback(ctx.mei, ctx.baseMsm, take.referenceMpmClone, take.range);
    log(`PLAY: perform_ms=${Date.now() - performStartedAt}`);
    if (isCancelled() || !performance) return;

    const preparedCues = await planAndPrepareCues(
        take.diffSummary, take.structuredDiff, performance.timingMap,
        mode, audioContext, playbackDeadlineAt, log, 'single',
    );
    if (isCancelled()) return;

    await playJudgementPreamble(take, controls);
    if (isCancelled()) return;

    log(`PLAY: time_to_play_ms=${Date.now() - takeStartedAt}`);
    playWithCues(performance.midi, preparedCues, play, log, 'single');
};
