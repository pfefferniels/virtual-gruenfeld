import type { MidiFile } from 'midifile-ts';
import type { MSM } from 'mpmify';
import type { MPM } from 'mpm-ts';
import type { Range, StructuredDiffEvent } from '../mpm';
import type { CuePrepMode } from '../prepMode';
import type { ImmediateJudgementPayload } from '../judgement';

export type PipelineContext = {
    mei: string;
    transformations: string;
    baseMsm: MSM;
    referenceMpm: MPM;
    reductionMei?: string;
    reductionMsm?: MSM;
};

export type TakeSnapshot = {
    studentMpm: MPM;
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
