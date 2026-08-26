import { allDimensions, counterPerformance, type ExaggerationDimension } from '../../mpm';
import { performTeacherPlayback } from '../../api';
import { isAgenticTeacher } from '../../featureFlags';
import { fallbackImmediateJudgement } from '../../judgement';
import { describePlan, type LessonPlan } from '../../lessonPlan';
import { appendMidiWithOffset, appendSustainTail, delayMidi, millisecondsToMidiTicks, prepareMoodChordMidi } from '../../pianosound/midiSequence';
import { buildJudgementMoodRenderPlan } from '../judgementMood';
import {
    requestVocalStream,
    scheduleTalkOnly,
    scheduleVocalStream,
    talkOnlyDurationSec,
    type VocalStreamResult,
} from '../teacherVocalStream';
import type { TeacherStrategy } from '../types';

/** Breathing room between JUDGE narration ending and correction piano entry. */
const JUDGE_TO_CORRECTION_BUFFER_MS = 3000;

/** Pedal ramp starts this many ms before the judgement ends. */
const PEDAL_RAMP_PRE_JUDGEMENT_MS = 1000;
/** Total pedal ramp duration: 1s before + 2s after judgement = 3s. */
const PEDAL_RAMP_DURATION_MS = 3000;

const NO_STREAM: VocalStreamResult = { chunks: [], plan: null };

export const exaggeratedStrategy: TeacherStrategy = async (ctx, take, controls) => {
    const { log, isCancelled, play, playAudioBuffer, audioContext, mode, takeStartedAt, onJudgement, aiAvailable } = controls;

    // The counter-performance is built from the reference **text** every time, so the two
    // branches below cannot come to share a document and `mode: 'reference'` always plays
    // Grünfeld untouched (semantics 30).
    const shape = (range: typeof take.range, dimensions: readonly ExaggerationDimension[]): string =>
        counterPerformance({
            referenceMpmText: ctx.referenceMpmText,
            range,
            dimensions,
            peaks: take.peaks,
            measured: take.measuredTypes,
            log,
        });

    // With fixed pedagogy the demo is known before the teacher speaks, so it is
    // shaped here and renders while the model is still thinking. Agentic takes
    // cannot: the plan arrives with the monologue, so the two steps serialize.
    const agentic = aiAvailable && isAgenticTeacher();
    let counterMpm: string | null = agentic ? null : shape(take.range, allDimensions());

    const vocalStreamPromise = aiAvailable
        ? requestVocalStream(
            take.judgementSummary,
            take.diffSummary,
            take.structuredDiff,
            take.range,
            undefined, // timingMap not yet available; candidates will be built from diffEvents
            mode,
            audioContext,
            log,
            agentic,
        ).catch((e) => {
            log(`VOCAL: stream error: ${e}`);
            return NO_STREAM;
        })
        : Promise.resolve(NO_STREAM);

    let plan: LessonPlan | null = null;
    let earlyStream: VocalStreamResult | null = null;
    if (agentic) {
        earlyStream = await vocalStreamPromise;
        if (isCancelled()) return;
        plan = earlyStream.plan;
        if (plan) {
            log(`PLAN: ${describePlan(plan)}`);
        } else {
            log('PLAN: none returned — demonstrating as usual');
        }
    }

    const demoMode = plan?.mode ?? 'exaggerated';
    const demoRange = plan?.range ?? take.range;

    if (agentic && demoMode === 'exaggerated') {
        const dimensions = plan && plan.dimensions.length > 0 ? plan.dimensions : allDimensions();
        counterMpm = shape(demoRange, dimensions);
    }

    // `none` skips the render entirely; `reference` plays Grünfeld untouched.
    let demoPerf: ReturnType<typeof performTeacherPlayback> = undefined;
    if (demoMode !== 'none') {
        const performStartedAt = Date.now();
        // `reference` plays the pristine document; `exaggerated` plays the splice, which is a
        // copy of it. A demo mode with no counter-performance behind it falls back to Grünfeld
        // rather than to nothing.
        const demoMpm = demoMode === 'exaggerated' && counterMpm !== null ? counterMpm : ctx.referenceMpmText;
        demoPerf = performTeacherPlayback(ctx.mei, ctx.scoreNotes, demoMpm, demoRange);
        log(`PLAY: ${demoMode === 'reference' ? 'reference' : 'correction'} perform_ms=${Date.now() - performStartedAt}`);
        if (isCancelled() || !demoPerf) return;

        // Sustain tail: hold pedal 2.5s after last note, then slow release
        demoPerf.midi = appendSustainTail(demoPerf.midi);
    }

    const { chunks: vocalChunks } = earlyStream ?? await vocalStreamPromise;
    if (isCancelled()) return;

    // Without AI service: just play the correction
    if (!aiAvailable) {
        log('PLAY: instrumental-only (no AI service)');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        play(demoPerf!.midi as any, undefined, () => {});
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

    // Talking-only takes need the chord to carry the whole monologue, not just
    // the JUDGE — nothing follows it that could take over.
    const narrationMs = demoMode === 'none'
        ? talkOnlyDurationSec(vocalChunks) * 1000
        : judgeDurationMs + JUDGE_TO_CORRECTION_BUFFER_MS;
    const correctionEntrySec = narrationMs / 1000;

    // Build mood chord from harmonic reduction (if available)
    const moodPlan = ctx.reductionMei && ctx.reductionNotes
        ? buildJudgementMoodRenderPlan(
            ctx.reductionNotes,
            ctx.scoreNotes,
            ctx.referenceMpmText,
            demoRange.from,
            { minimumPedalHoldMs: narrationMs },
        )
        : null;

    // Render mood chord if available
    const moodPerf = moodPlan
        ? performTeacherPlayback(ctx.reductionMei!, ctx.reductionNotes!, moodPlan.mpm, moodPlan.range)
        : undefined;
    if (isCancelled()) return;

    // Short staccato notes sustained by pedal, with gradual 3s pedal lift
    if (moodPerf) {
        const rampStartMs = narrationMs - PEDAL_RAMP_PRE_JUDGEMENT_MS;
        moodPerf.midi = prepareMoodChordMidi(moodPerf.midi, rampStartMs, PEDAL_RAMP_DURATION_MS);
    }

    log(`PLAY: time_to_play_ms=${Date.now() - takeStartedAt}`);

    if (demoMode === 'none') {
        if (vocalChunks.length === 0) {
            log('PLAY: nothing to say and nothing to play');
            return;
        }
        if (moodPerf) {
            log(`PLAY: talk-only over mood chord (${vocalChunks.length} segments, ${correctionEntrySec.toFixed(1)}s)`);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            play(moodPerf.midi as any, undefined, ({ scheduleAudioCue }) => {
                scheduleTalkOnly(vocalChunks, scheduleAudioCue, log);
            });
            return;
        }
        // No chord to speak over — the voice carries the take on its own.
        log(`PLAY: talk-only, unaccompanied (${vocalChunks.length} segments)`);
        for (const chunk of vocalChunks) {
            if (isCancelled()) return;
            await playAudioBuffer(chunk.audioBuffer, () => log(`VOCAL: playing "${chunk.marker}" "${chunk.text.slice(0, 30)}"`));
        }
        return;
    }

    const correctionPerf = demoPerf!;

    if (moodPerf && moodPlan && vocalChunks.length > 0) {
        // Mood chord → vocal stream over chord → corrective playback
        const connectedMidi = appendMidiWithOffset(
            moodPerf.midi,
            correctionPerf.midi,
            millisecondsToMidiTicks(moodPerf.midi, narrationMs),
        );

        log(
            `PLAY: mood chord (date=${moodPlan.chordDate}, notes=${moodPlan.noteCount}, ` +
            `range=[${moodPlan.renderFrom}, ${moodPlan.renderTo}], entry_ms=${Math.round(narrationMs)})`,
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
            millisecondsToMidiTicks(correctionPerf.midi, narrationMs),
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
