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
