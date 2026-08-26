import type { DiffSeverity } from '../shared/severity';

export type Range = { from: number; to: number };

export type { DiffSeverity };

export type StructuredDiffEvent = {
    id: string;
    date: number;
    position: string;
    type: string;
    severity: DiffSeverity;
    primaryAttr: string;
    magnitude: number;
    cueText: string;
    direction: 'more' | 'less';
    refValue: number;
    studentValue: number;
};

export type InstructionDiff = {
    date: number;
    type: string;
    nameRef?: string;
    diffs: Record<string, { ref: number; student: number; delta: number }>;
    magnitude: number;
};

/**
 * The seven instruction types the diff, the plan schema and the validator all share.
 *
 * The same list `student/fit.ts` calls `LegacyType` and `src/plan/validate.ts` gates a
 * demonstration against; `asynchrony` stays in it as a contract even though nothing fits it
 * (DESIGN §7). Ordered as `ATTRS_TO_COMPARE` declares them.
 */
export const DIFF_TYPES = [
    'tempo',
    'dynamics',
    'rubato',
    'articulation',
    'accentuationPattern',
    'ornament',
    'asynchrony',
] as const;

export type DiffType = (typeof DIFF_TYPES)[number];

/**
 * What the ASCII table's ornament section says about a figure: `arpeggio`, `dyn-gradient`, or
 * both. Which of the two transformers an `<ornamentDef>` carries, and nothing else —
 * `diff.ts:243-252` only ever asks whether they are there.
 */
export type OrnamentStyle = {
    readonly temporalSpread: boolean;
    readonly dynamicsGradient: boolean;
};

/** `@name.ref` → what that def is made of, or `null` for a name the document does not define. */
export type OrnamentStyleLookup = (nameRef: string) => OrnamentStyle | null;
