import type { MidiFile } from 'midifile-ts';
import type { InstructionDiff, Range, StructuredDiffEvent, StudentLevels } from '../mpm';
import type { CuePrepMode } from '../prepMode';
import type { ImmediateJudgementPayload } from '../judgement';
import type { MeasuredNote } from '../score/measured';

/**
 * What the app holds between takes: two documents as text, and the score's notes as the
 * reference sounds them. No parsed MPM survives a boot — every document crosses every
 * boundary here as XML.
 */
export type PipelineContext = {
    mei: string;
    /** `convert(mei)`: the score as MSM text. Part of the comparison's metric, not decoration. */
    scoreMsm: string;
    /** Every score note, timed as `performance.mpm` sounds it — the matcher's reference side. */
    scoreNotes: MeasuredNote[];
    /**
     * The editorial reference — the one reference document there is: the scaffold, what the
     * comparison side is fitted from per take (`mpm/evidence.ts`), the counter-performance's
     * base, and what `mode: 'reference'` plays untouched.
     */
    referenceMpmText: string;
    reductionMei?: string;
    reductionNotes?: MeasuredNote[];
};

export type TakeSnapshot = {
    /**
     * The student's own tempo and volume levels, as the fitter measured them — the fixed point
     * the counter-performance is pushed around (`mpm/counter.ts`, semantics 27).
     */
    levels: StudentLevels;
    /**
     * What this take actually measured: the audibility gate's list intersected with what the
     * fitter wrote (DESIGN §3.4). The counter-performance exaggerates nothing outside it —
     * a dimension with no student behind it could only caricature the editorial bake.
     */
    measuredTypes: readonly string[];
    /**
     * The student's own performance, as the fitter wrote it. `mode: 'path'` is the only thing
     * that reads it: the demonstration there *is* the student's document, with the k costliest
     * edits of the script applied (`mpm/path.ts`).
     */
    studentMpmText: string;
    /**
     * Grünfeld over this take's range, written by the same fitter — the side every number in
     * {@link TakeSnapshot.peaks} was measured against. `mode: 'path'` reads it as the `b` of its
     * edit script, so the demonstration is priced against the same document the criticism was.
     */
    referenceFitText: string;
    /**
     * The take's paired instructions, per attribute, in raw MPM units — what the
     * counter-performance pushes Grünfeld away from, slot by slot (`mpm/counter.ts`).
     */
    peaks: readonly InstructionDiff[];
    diffSummary: string;
    structuredDiff: StructuredDiffEvent[];
    judgementSummary: ImmediateJudgementPayload;
    range: Range;
};

export type ScheduledCue = {
    atSec: number;
    audioBuffer: AudioBuffer;
    onStart?: () => void;
};

export type PlayFn = (
    midi: MidiFile,
    cb: undefined,
    setup: (api: { scheduleAudioCue: (cue: ScheduledCue) => void }) => void,
) => void;

export type PlayAudioBufferFn = (
    audioBuffer: AudioBuffer,
    onStart?: () => void,
) => Promise<void>;

export type StrategyControls = {
    log: (msg: string) => void;
    isCancelled: () => boolean;
    play: PlayFn;
    playAudioBuffer: PlayAudioBufferFn;
    audioContext: AudioContext;
    mode: CuePrepMode;
    takeStartedAt: number;
    onJudgement: (value: string | ((prev: string) => string)) => void;
    aiAvailable: boolean;
};

export type TeacherStrategy = (
    ctx: PipelineContext,
    take: TakeSnapshot,
    controls: StrategyControls,
) => Promise<void>;

export type TakeRunnerControls = {
    log: (msg: string) => void;
    stop: () => void;
    play: PlayFn;
    playAudioBuffer: PlayAudioBufferFn;
    audioContext: AudioContext;
    mode: CuePrepMode;
    isCancelled: () => boolean;
    onDiff: (text: string) => void;
    onJudgement: (value: string | ((prev: string) => string)) => void;
    aiAvailable: boolean;
};
