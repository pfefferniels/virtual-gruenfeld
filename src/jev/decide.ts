/**
 * A verdict turned into something the client is allowed to play.
 *
 * Jev answers five independent questions; this composes them into the `demo` object
 * `src/plan/` was built for, and `validatePlan` clamps whatever comes out. That clamping is the
 * point: a probabilistic verdict should not reach a piano that moves its own keys without
 * something between them that refuses the unmusical.
 */
import { validatePlan, type LessonPlan } from '../plan';
import { STRENGTH_MAX, STRENGTH_MIN } from '../plan/types';
import { tickToPos } from '../shared/musicalTime';
import { EXAGGERATION_LEVELS } from './questions';
import { isLiveDimension } from './state';
import type { Verdict } from './client';

type DecisionContext = {
    /** The window the verdict was formed over, in ticks. */
    readonly range: { from: number; to: number };
    /** What the local gate measured, so the plan cannot name a dimension the evidence lacks. */
    readonly measuredTypes: readonly string[];
};

const BAR_TICKS = 4 * 720;

/** `exaggeration` is an expectation over its level indices; the ends map onto the plan's range. */
const strengthFrom = (exaggeration: number): number => {
    const fraction = Math.max(0, Math.min(1, exaggeration / (EXAGGERATION_LEVELS - 1)));
    return STRENGTH_MIN + fraction * (STRENGTH_MAX - STRENGTH_MIN);
};

/**
 * The fragment he plays: the last bar of the window that carried the point.
 *
 * Hullah on Leschetizky in 1906 — "he plays a great deal during the lesson in a fragmentary way,
 * but rarely anything straight through". The window is what was *judged*; it is longer than what
 * is worth playing back.
 */
const fragmentOf = ({ from, to }: { from: number; to: number }) => {
    const start = Math.max(from, to - BAR_TICKS);
    return { from: tickToPos(start), to: tickToPos(to) };
};

export const planFrom = (
    verdict: Verdict,
    context: DecisionContext,
): { plan: LessonPlan; warnings: string[] } => {
    const demonstrable = isLiveDimension(verdict.dimension);
    const demo = {
        mode: demonstrable ? verdict.mode : 'none',
        range: fragmentOf(context.range),
        dimensions: demonstrable ? [{ type: verdict.dimension, strength: strengthFrom(verdict.exaggeration) }] : [],
        edits: null,
    };

    return validatePlan(demo, { takeRange: context.range, measuredTypes: context.measuredTypes });
};
