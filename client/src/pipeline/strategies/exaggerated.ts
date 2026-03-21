import { exaggerate } from '../../mpm';
import { performTeacherPlayback } from '../../api';
import { fallbackImmediateJudgement } from '../../judgement';
import { appendMidiWithOffset, appendSustainTail, delayMidi, millisecondsToMidiTicks, prepareMoodChordMidi } from '../../pianosound/midiSequence';
import { buildJudgementMoodRenderPlan } from '../judgementMood';
import { requestVocalStream, scheduleVocalStream } from '../teacherVocalStream';
import type { VocalChunk } from '../chunker';
import type { TeacherStrategy } from '../types';

/** Breathing room between JUDGE narration ending and correction piano entry. */
const JUDGE_TO_CORRECTION_BUFFER_MS = 3000;

/** Pedal ramp starts this many ms before the judgement ends. */
const PEDAL_RAMP_PRE_JUDGEMENT_MS = 1000;
/** Total pedal ramp duration: 1s before + 2s after judgement = 3s. */
const PEDAL_RAMP_DURATION_MS = 3000;

export const exaggeratedStrategy: TeacherStrategy = async (ctx, take, controls) => {
    const { log, isCancelled, play, audioContext, mode, takeStartedAt, onJudgement, aiAvailable } = controls;

    exaggerate(take.referenceMpmClone, take.studentMpm, take.range, 0.2, log);

    // Kick off vocal stream (only when AI service is running)
    const vocalStreamPromise = aiAvailable
        ? requestVocalStream(
            take.judgementSummary,
            take.diffSummary,
            take.structuredDiff,
            undefined, // timingMap not yet available; candidates will be built from diffEvents
            mode,
            audioContext,
            log,
        ).catch((e) => {
            log(`VOCAL: stream error: ${e}`);
            return [] as VocalChunk[];
        })
        : Promise.resolve([] as VocalChunk[]);

    const performStartedAt = Date.now();
    const correctionPerf = await performTeacherPlayback(
        ctx.mei, ctx.baseMsm, take.referenceMpmClone, take.range,
    );
    log(`PLAY: correction perform_ms=${Date.now() - performStartedAt}`);
    if (isCancelled() || !correctionPerf) return;

    // Sustain tail: hold pedal 2.5s after last note, then slow release
    correctionPerf.midi = appendSustainTail(correctionPerf.midi);

    const vocalChunks = await vocalStreamPromise;
    if (isCancelled()) return;

    // Without AI service: just play the correction
    if (!aiAvailable) {
        log('PLAY: instrumental-only (no AI service)');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        play(correctionPerf.midi as any, undefined, () => {});
        return;
    }

    // Extract JUDGE chunk info
    const judgeChunk = vocalChunks.find((c) => c.marker === 'JUDGE');
    const judgeText = judgeChunk?.text ?? '';
    const judgeDurationMs = judgeChunk ? judgeChunk.audioBuffer.duration * 1000 : 0;

    // Update UI with judgement text
    if (judgeText) {
        onJudgement(judgeText);
    } else {
        const fallback = fallbackImmediateJudgement(take.judgementSummary);
        onJudgement(fallback);
    }

    const correctionEntryMs = judgeDurationMs + JUDGE_TO_CORRECTION_BUFFER_MS;
    const correctionEntrySec = correctionEntryMs / 1000;

    // Build mood chord from harmonic reduction (if available)
    const moodPlan = ctx.reductionMei && ctx.reductionMsm
        ? buildJudgementMoodRenderPlan(
            ctx.reductionMsm,
            ctx.baseMsm,
            take.referenceMpmClone,
            take.range.from,
            { minimumPedalHoldMs: correctionEntryMs },
        )
        : null;

    // Render mood chord if available
    const moodPerf = moodPlan
        ? await performTeacherPlayback(ctx.reductionMei!, ctx.reductionMsm!, moodPlan.mpm, moodPlan.range)
        : undefined;
    if (isCancelled()) return;

    // Short staccato notes sustained by pedal, with gradual 3s pedal lift
    if (moodPerf) {
        const rampStartMs = judgeDurationMs - PEDAL_RAMP_PRE_JUDGEMENT_MS;
        moodPerf.midi = prepareMoodChordMidi(moodPerf.midi, rampStartMs, PEDAL_RAMP_DURATION_MS);
    }

    log(`PLAY: time_to_play_ms=${Date.now() - takeStartedAt}`);

    if (moodPerf && moodPlan && vocalChunks.length > 0) {
        // Mood chord → vocal stream over chord → corrective playback
        const connectedMidi = appendMidiWithOffset(
            moodPerf.midi,
            correctionPerf.midi,
            millisecondsToMidiTicks(moodPerf.midi, correctionEntryMs),
        );

        log(
            `PLAY: mood chord (date=${moodPlan.chordDate}, notes=${moodPlan.noteCount}, ` +
            `range=[${moodPlan.renderFrom}, ${moodPlan.renderTo}], entry_ms=${Math.round(correctionEntryMs)})`,
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        play(connectedMidi as any, undefined, ({ scheduleAudioCue }) => {
            scheduleVocalStream(
                vocalChunks,
                correctionPerf.timingMap,
                scheduleAudioCue,
                log,
                correctionEntrySec,
            );
        });
    } else if (vocalChunks.length > 0) {
        // No mood chord — delay correction MIDI so JUDGE narration finishes first
        const delayedMidi = delayMidi(
            correctionPerf.midi,
            millisecondsToMidiTicks(correctionPerf.midi, correctionEntryMs),
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        play(delayedMidi as any, undefined, ({ scheduleAudioCue }) => {
            scheduleVocalStream(
                vocalChunks,
                correctionPerf.timingMap,
                scheduleAudioCue,
                log,
                correctionEntrySec,
            );
        });
    } else {
        // Fallback: instrumental only (vocal stream failed)
        log('PLAY: fallback instrumental-only (no vocal chunks)');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        play(correctionPerf.midi as any, undefined, () => {});
    }
};
