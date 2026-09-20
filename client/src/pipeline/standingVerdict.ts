/**
 * Whether Grünfeld comes in, and when.
 *
 * Nothing here touches the network. A verdict takes 367 ms at the median and 883 ms at the 99th
 * percentile, which is not a reflex — so the model's answer is a *standing* one, recomputed as the
 * student plays, and this is what decides whether the one in hand may be acted on now.
 *
 * Every threshold was calibrated against this pipeline's own evidence in
 * `scripts/simulate-lesson.ts`, not taken from the model's scale. `LIVE.md` §4a has the numbers.
 */

export type Policy = {
    /**
     * Measured over the real fit: ordinary human unevenness and a 15 % rush both top out at 0.51,
     * while a 25 % rush, a 30 % drag and a 60 % dynamics departure all clear 0.52.
     */
    readonly fireAbove: number;
    /** The dead band is wider than the ±0.05 Jev moves on identical input. */
    readonly releaseBelow: number;
    /** He does not come in again inside this, however wrong the playing. */
    readonly refractoryMs: number;
    /** A verdict older than this describes music the student has left behind. */
    readonly ttlMs: number;
    /** Windows a dimension must survive before it is worth asking about: noise wanders, a reading persists. */
    readonly persistenceWindows: number;
    /** Hands off the keys for this long is a place he may come in. */
    readonly silenceMs: number;
};

export const LIVE_POLICY: Policy = {
    fireAbove: 0.52,
    releaseBelow: 0.45,
    refractoryMs: 8000,
    ttlMs: 6000,
    persistenceWindows: 2,
    silenceMs: 1200,
};

export type Verdict = {
    readonly interrupt: number;
    readonly dimension: string;
    readonly severity: number;
    readonly exaggeration: number;
};

export type Standing<TPlan> = {
    readonly verdict: Verdict;
    readonly plan: TPlan;
    readonly range: { from: number; to: number };
    readonly landedAtMs: number;
};

export type Correction = { readonly bar: number; readonly dimension: string; readonly times: number };

export type VerdictStore<TPlan> = {
    /** What the local gate measured. Returns the dimensions that have survived long enough to ask about. */
    observe(measuredTypes: readonly string[]): string[];
    record(standing: Standing<TPlan>): void;
    /** The standing verdict, if it may be acted on at `nowMs`. Null otherwise. */
    due(nowMs: number, msSinceLastNote: number): Standing<TPlan> | null;
    /** He came in. Arms the refractory period and remembers the point was made. */
    committed(standing: Standing<TPlan>, nowMs: number, bar: number): void;
    corrections(): readonly Correction[];
};

export const createVerdictStore = <TPlan>(policy: Policy = LIVE_POLICY): VerdictStore<TPlan> => {
    const streak = new Map<string, number>();
    const corrections: Correction[] = [];
    let standing: Standing<TPlan> | null = null;
    let armed = false;
    let lastCommitMs = -Infinity;

    return {
        observe(measuredTypes) {
            measuredTypes.forEach((type) => streak.set(type, (streak.get(type) ?? 0) + 1));
            [...streak.keys()]
                .filter((type) => !measuredTypes.includes(type))
                .forEach((type) => streak.delete(type));
            return measuredTypes.filter((type) => (streak.get(type) ?? 0) >= policy.persistenceWindows);
        },

        record(next) {
            standing = next;
        },

        due(nowMs, msSinceLastNote) {
            if (standing === null) return null;
            if (nowMs < standing.landedAtMs) return null;
            if (nowMs - standing.landedAtMs > policy.ttlMs) return null;
            if (standing.verdict.dimension === 'none') return null;

            armed = armed
                ? standing.verdict.interrupt > policy.releaseBelow
                : standing.verdict.interrupt > policy.fireAbove;
            if (!armed) return null;
            if (nowMs - lastCommitMs < policy.refractoryMs) return null;

            // He comes in when the hands are off the keys. On one instrument he cannot sound a key
            // the student is holding, and the moving action is itself the interruption.
            return msSinceLastNote >= policy.silenceMs ? standing : null;
        },

        committed(committedStanding, nowMs, bar) {
            const dimension = committedStanding.verdict.dimension;
            const already = corrections.find((c) => c.bar === bar && c.dimension === dimension);
            if (already) {
                corrections[corrections.indexOf(already)] = { ...already, times: already.times + 1 };
            } else {
                corrections.push({ bar, dimension, times: 1 });
            }
            lastCommitMs = nowMs;
            armed = false;
            standing = null;
        },

        corrections: () => corrections,
    };
};
