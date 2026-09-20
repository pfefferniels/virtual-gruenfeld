import type { MidiFile } from 'midifile-ts';
import type { InstructionDiff, Range } from '../mpm';
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
     * base, and what the demonstration is shaped out of.
     */
    referenceMpmText: string;
};

/** The evidence a strategy demonstrates from. The rest of the take stays on `Evidence`. */
export type TakeSnapshot = {
    /**
     * What this take actually measured: the audibility gate's list intersected with what the
     * fitter wrote (DESIGN §3.4). The counter-performance exaggerates nothing outside it —
     * a dimension with no student behind it could only caricature the editorial bake.
     */
    measuredTypes: readonly string[];
    /**
     * The take's paired instructions, per attribute, in raw MPM units — what the
     * counter-performance pushes Grünfeld away from, slot by slot (`mpm/counter.ts`).
     */
    peaks: readonly InstructionDiff[];
    range: Range;
};

export type PlayFn = (midi: MidiFile) => void;

export type StrategyControls = {
    log: (msg: string) => void;
    isCancelled: () => boolean;
    play: PlayFn;
    takeStartedAt: number;
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
    isCancelled: () => boolean;
    onDiff: (text: string) => void;
};
