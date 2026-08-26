/**
 * One take: the student's playing in, the teacher's evidence out, the strategy handed both.
 *
 * The two lines this used to be — `mpmify(studentMsm, info.json)` followed by
 * `diff(referenceMpm, studentMpm, range)` — replayed Grünfeld's whole editorial chain over the
 * student in order to *manufacture* instructions the diff could pair by id. The reference
 * prints those ids, so the student is fitted into them instead (`student/fit.ts`) and the
 * pairing is a `Map` lookup. What that buys is in `mpm/compare.ts`: six of seven dimensions
 * measured where three were, and an audibility gate over all of them.
 *
 * The evidence runs in a Web Worker (`workers/evidenceClient.ts`), because it is ~90 ms of
 * parsing and rendering that would otherwise land on the main thread in the second after the
 * student lifts their hands.
 */
import { counterPerformanceBase, studentInstructionsFrom } from '../mpm';
import type { Range } from '../mpm';
import { summarizeImmediateJudgement } from '../judgement';
import type { Evidence } from '../mpm/evidence';
import type { MeasuredNote } from '../score/measured';
import { PPQ } from '../shared/constants';
import { runEvidence } from '../workers/evidenceClient';
import type { PipelineContext, TeacherStrategy, TakeRunnerControls } from './types';

export const runTake = async (
    ctx: PipelineContext,
    notes: readonly MeasuredNote[],
    range: Range,
    strategy: TeacherStrategy,
    controls: TakeRunnerControls,
): Promise<void> => {
    const takeStartedAt = Date.now();
    controls.stop();
    controls.log(`CALLBACK: take implanted -> range=[${range.from}, ${range.to}]`);

    // A take with no window in it. The finish trigger is 1.2 s of silence after a single
    // event, so a student who plays one chord and stops gets `from === to` (`matcher.ts:701`),
    // and a take the matcher recognises nothing in gets `{0, 0}` (`matcher.ts:705`). Neither
    // is a passage: `readScaffold` rejects `from >= to` outright, and under a quarter note
    // there is no phrase to fit, only the edges of one. Said out loud and dropped — the
    // callback that runs this is not awaited (`midi.ts:94`), so a throw here would leave the
    // student with no feedback and no line in the log to explain it.
    if (range.to - range.from < PPQ) {
        controls.log('TAKE: too little playing to measure');
        return;
    }

    controls.log('EVIDENCE: fitting the take into Grünfeld’s slots…');
    let evidence: Evidence;
    try {
        evidence = await runEvidence(
            {
                notes,
                range,
                scoreMsm: ctx.scoreMsm,
                referenceMpmText: ctx.referenceMpmText,
                fittedReferenceMpmText: ctx.fittedReferenceMpmText,
            },
            controls.log,
        );
    } catch (e) {
        // The fit itself failed on this input — the worker says so rather than dying, and
        // re-running it here would only fail again (`workers/evidenceClient.ts`). One take is
        // lost; the session is not.
        controls.log(`EVIDENCE error: ${e}`);
        return;
    }

    // Take #2 can begin while take #1 is still being evidenced, and whichever call resolves
    // last would otherwise win the UI: a superseded take must not clear the current one.
    if (controls.isCancelled()) return;

    controls.log(
        `EVIDENCE: fit_ms=${Math.round(evidence.timings.fitMs)} compare_ms=${Math.round(evidence.timings.evidenceMs)}` +
        ` aggregate=${evidence.aggregateJnd.toFixed(2)} JND (${Math.round(evidence.subThresholdFraction * 100)}% sub-threshold)`,
    );
    controls.log(`EVIDENCE: fitted=[${evidence.filled.join(', ')}] measured=[${evidence.measuredTypes.join(', ')}]`);
    for (const { type, reason } of evidence.suppressed) {
        controls.log(`EVIDENCE: gate closed ${type} — ${reason}`);
    }
    if (evidence.skipped.length > 0) {
        controls.log(`EVIDENCE: ${evidence.skipped.length} slot(s) not fitted (${evidence.skipped[0].type}: ${evidence.skipped[0].reason}, …)`);
    }
    for (const { type, meanSigned, medianDelta } of evidence.disagreements) {
        // The instruction pair wins: the cue table is calibrated on raw deltas (DESIGN §3.3.4).
        controls.log(`EVIDENCE: direction disagreement on ${type} (meanSigned=${meanSigned.toFixed(3)}, medianDelta=${medianDelta.toFixed(3)})`);
    }

    const { diffSummary, structuredDiff } = evidence;
    const judgementSummary = summarizeImmediateJudgement(structuredDiff, range);

    // Text in, a fresh document out: nothing the demonstration mutates can reach anyone else
    // (semantics 30), and `ctx.referenceMpm` stays the pristine Grünfeld `mode: 'reference'`
    // plays.
    const referenceMpmClone = counterPerformanceBase(ctx.referenceMpmText);
    const studentMpm = studentInstructionsFrom(evidence.studentMpmText);

    controls.onDiff(diffSummary);
    controls.onJudgement('');

    const mode = controls.mode;

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
            takeStartedAt,
            onJudgement: controls.onJudgement,
            aiAvailable: controls.aiAvailable,
        });
    } catch (e) {
        controls.log(`PERFORM error: ${e}`);
    }
};
