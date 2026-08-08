export type Range = { from: number; to: number };

export type Span = { from: number; to: number };

/**
 * The canonical motivation vocabulary (mpmify's `activityMotivations`): a four-step
 * intensity scale — intensify (++), move (+), calm (-), relax (--). Older info.json
 * exports carry a finer pre-reduction vocabulary, mapped onto the scale at parse time.
 */
export const CANONICAL_MOTIVATIONS = ['intensify', 'move', 'calm', 'relax'] as const;

export type Motivation = (typeof CANONICAL_MOTIVATIONS)[number] | 'unknown';

/** One transformer invocation recorded in an argumentation. */
export type CorpusCall = {
    name: string;
    /** Human-readable MPM concept the transformer produces (e.g. "rubato"). */
    concept: string;
    options: Record<string, unknown>;
    /** Tick extent this single call touches; null when it addresses notes by ID. */
    span: Span | null;
};

/**
 * One scholarly argumentation from info.json: a claim about how Grünfeld played
 * a passage, the transformers that realise it, and how certain the editor is.
 */
export type Argumentation = {
    id: string;
    /** Merged, sorted tick spans the argumentation applies to. Empty when unknown. */
    spans: Span[];
    /** `global` = applies to (almost) the whole piece; `unplaced` = no position derivable. */
    scope: 'ranged' | 'global' | 'unplaced';
    /** MPM concepts touched, in canonical order. */
    concepts: string[];
    certainty: string;
    motivation: Motivation;
    /** Short claim (conclusion note) — the interpretive one-liner. */
    claim: string;
    /** Longer editorial commentary (argumentation note). */
    commentary: string;
    calls: CorpusCall[];
};

/** A dated instruction from the reference MPM. */
export type MpmElement = {
    kind: string;
    date: number;
    endDate: number;
    attrs: Record<string, string>;
    corresp: string;
};

export type Corpus = {
    argumentations: Argumentation[];
    elements: MpmElement[];
    /** Last tick covered by the corpus — used to recognise piece-wide argumentations. */
    lastTick: number;
};
