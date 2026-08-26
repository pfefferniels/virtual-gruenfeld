import type { MidiFile } from 'midifile-ts';
import type { MPM } from 'mpm-ts';
import type { InstructionSource, Range, StructuredDiffEvent } from '../mpm';
import type { CuePrepMode } from '../prepMode';
import type { ImmediateJudgementPayload } from '../judgement';
import type { MeasuredNote } from '../score/measured';

/**
 * What the app holds between takes: three documents as text, the score's notes as the
 * reference sounds them, and — until `mpm/counter.ts` replaces `mpm/exaggerate.ts` — one
 * `mpm-ts` parse of the reference for the demonstration to be built on.
 */
export type PipelineContext = {
    mei: string;
    /** `convert(mei)`: the score as MSM text. Part of the comparison's metric, not decoration. */
    scoreMsm: string;
    /** Every score note, timed as `performance.mpm` sounds it — the matcher's reference side. */
    scoreNotes: MeasuredNote[];
    /** The editorial reference: the scaffold, and the counter-performance's base. */
    referenceMpmText: string;
    /** The fitted reference: the comparison side only (S4 §2). */
    fittedReferenceMpmText: string;
    /** `performance.mpm` parsed for the demonstration. Goes when the counter-performance moves. */
    referenceMpm: MPM;
    reductionMei?: string;
    reductionNotes?: MeasuredNote[];
};

export type TakeSnapshot = {
    /** The student's instructions, as the exaggeration reads them (`mpm/exaggerate.ts`). */
    studentMpm: InstructionSource;
    referenceMpmClone: MPM;
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
