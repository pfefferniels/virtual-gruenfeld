import { exaggerate } from '../../mpm';
import type { StructuredDiffEvent } from '../../mpm';
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
import type { TeacherStrategy, StrategyControls, SpokenJudgement } from '../types';

// ── Cue planning + playback helpers ──

const planAndPrepareCues = async (
    diffSummary: string,
    diffEvents: StructuredDiffEvent[],
    timingMap: Parameters<typeof resolveTeacherCues>[1],
    mode: StrategyControls['mode'],
    audioContext: AudioContext,
    playbackDeadlineAt: number | undefined,
    log: (msg: string) => void,
): Promise<PreparedTeacherCue[]> => {
    const planStartedAt = Date.now();
    const cueDraftPromise = requestTeacherCuePlan(diffSummary, diffEvents, mode, timingMap, log)
        .then((drafts) => {
            log(`CUE: plan_ms=${Date.now() - planStartedAt} drafted=${drafts.length}`);
            return drafts;
        })
        .catch((e) => {
            log(`CUE plan error: ${e}`);
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
        log(`CUE prepare error: ${e}`);
        return [];
    }
};

const playWithCues = (
    midi: MidiFile,
    cues: PreparedTeacherCue[],
    play: StrategyControls['play'],
    log: (msg: string) => void,
    spokenJudgement?: SpokenJudgement,
) => {
    log(`PLAY: starting (cues=${cues.length})`);
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
                    log(`CUE: trigger "${cue.text}" at ${cue.atSec.toFixed(2)}s`);
                },
            });
        }
    });
};

// ── Strategy ──

export const exaggeratedStrategy: TeacherStrategy = async (ctx, take, controls) => {
    const { log, isCancelled, play, playAudioBuffer, audioContext, mode, playbackDeadlineAt, takeStartedAt } = controls;

    exaggerate(take.referenceMpmClone, take.studentMpm, take.range, 0.2, log);

    const spokenJudgement = await take.spokenJudgementPromise;
    const spokenJudgementMs = spokenJudgement ? spokenJudgement.audioBuffer.duration * 1000 : 0;

    // Build mood chord from harmonic reduction (if available)
    const moodPlan = ctx.reductionMei && ctx.reductionMsm
        ? buildJudgementMoodRenderPlan(
            ctx.reductionMsm,
            ctx.baseMsm,
            take.referenceMpmClone,
            take.range.from,
            { minimumPedalHoldMs: spokenJudgementMs + JUDGEMENT_MOOD_PEDAL_BUFFER_MS },
        )
        : null;

    // Render mood chord + corrective playback in parallel
    const performStartedAt = Date.now();
    const [moodPerf, correctionPerf] = await Promise.all([
        moodPlan
            ? performTeacherPlayback(ctx.reductionMei!, ctx.reductionMsm!, moodPlan.mpm, moodPlan.range)
            : Promise.resolve(undefined),
        performTeacherPlayback(ctx.mei, ctx.baseMsm, take.referenceMpmClone, take.range),
    ]);
    log(`PLAY: perform_ms=${Date.now() - performStartedAt}`);
    if (isCancelled() || !correctionPerf) return;

    const preparedCues = await planAndPrepareCues(
        take.diffSummary, take.structuredDiff, correctionPerf.timingMap,
        mode, audioContext, playbackDeadlineAt, log,
    );
    if (isCancelled()) return;

    log(`PLAY: time_to_play_ms=${Date.now() - takeStartedAt}`);

    if (moodPerf && moodPlan) {
        // Mood chord → spoken judgement over chord → corrective playback with cues
        const entrySec = spokenJudgementMs / 1000;
        const connectedMidi = appendMidiWithOffset(
            moodPerf.midi,
            correctionPerf.midi,
            millisecondsToMidiTicks(moodPerf.midi, spokenJudgementMs),
        );
        const connectedCues = offsetCueTimes(preparedCues, entrySec);
        log(
            `PLAY: mood chord (date=${moodPlan.chordDate}, notes=${moodPlan.noteCount}, ` +
            `range=[${moodPlan.renderFrom}, ${moodPlan.renderTo}], entry_ms=${Math.round(spokenJudgementMs)})`,
        );
        playWithCues(connectedMidi, connectedCues, play, log, spokenJudgement ?? undefined);
    } else {
        // Fallback: spoken judgement then corrective playback
        if (spokenJudgement && !isCancelled()) {
            log(`PLAY: spoken judgement "${spokenJudgement.text}"`);
            await playAudioBuffer(spokenJudgement.audioBuffer, () => {
                log(`PLAY: spoken judgement start (duration_ms=${Math.round(spokenJudgementMs)})`);
            });
        }
        if (isCancelled()) return;
        playWithCues(correctionPerf.midi, preparedCues, play, log);
    }
};
