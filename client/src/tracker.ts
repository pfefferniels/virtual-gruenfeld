/**
 * Where the student is, while they are still playing.
 *
 * The matcher is fast enough to be re-run outright — measured 0.4–2 ms on a growing window
 * against 458 reference notes — so this is not an incremental alignment but a policy for driving
 * the existing one: how wide to search, when to trust the answer, and what to do when the student
 * stops in the middle and starts again somewhere else.
 *
 * Two things dates alone cannot tell you, and both are carried here instead:
 *
 *  - **Which pass of a repeat.** Träumerei's first repeat is written out, so A₁ and A₂ have their
 *    own dates and a window narrower than half the 23760-tick offset resolves them. The second,
 *    `||: B A' :||`, is not written out: one set of dates, played twice. No matcher can recover a
 *    distinction the score does not encode, so the pass is tracked as state.
 *  - **A restart.** A student who stops mid-phrase and picks up elsewhere looks, to a window
 *    centred on where they were, exactly like a student playing badly. The answer is to notice the
 *    confidence collapse and search the whole piece again. Nakamura's symbolic study puts recovery
 *    at about two chords with a resumption prior and six to eight without one.
 */
import { matchSubsequence, refNotesFrom, type RefNote, type StudentNote } from './matcher';
import type { MeasuredNote } from './score/measured';

/** A stretch of score with its own dates, and how many times it is played. */
export type SectionSpan = {
    readonly name: string;
    readonly from: number;
    readonly to: number;
    readonly passes: 1 | 2;
};

/**
 * Träumerei as the score encodes it, measured off a render of the reconstruction.
 * A₂ is the written-out repeat of A₁, offset by 23760 ticks; `B A'` carries one set of dates.
 */
export const TRAEUMEREI: readonly SectionSpan[] = [
    { name: 'A1', from: 0, to: 23760, passes: 1 },
    { name: 'A2', from: 23760, to: 46800, passes: 1 },
    { name: 'BA', from: 46800, to: 91440, passes: 2 },
];

export type Position = {
    readonly tick: number;
    readonly section: string;
    /** Which time through. Only a section whose dates are played twice can reach 2. */
    readonly pass: 1 | 2;
    /** Matched fraction of the notes in the search window. */
    readonly confidence: number;
};

export type TrackerOptions = {
    readonly sections: readonly SectionSpan[];
    /** Notes the follower matches on. A bar of Träumerei is about thirteen. */
    readonly windowNotes: number;
    /** Half-width of the follower's search, in ticks. Must stay under half the repeat offset. */
    readonly followTicks: number;
    /** Below this matched fraction the follower does not believe itself. */
    readonly followFloor: number;
    /** Below this, a search of the whole piece is not believed either. */
    readonly acquireFloor: number;
    /** Consecutive poor matches before the whole piece is searched again. */
    readonly missesBeforeReacquire: number;
    /** A backward step larger than this is a repeat or a restart, not tracking noise. */
    readonly backwardToleranceTicks: number;
};

const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
    sections: TRAEUMEREI,
    windowNotes: 24,
    followTicks: 8640,
    followFloor: 0.55,
    acquireFloor: 0.5,
    missesBeforeReacquire: 2,
    backwardToleranceTicks: 1440,
};

export type Tracker = {
    /**
     * Everything the student has played, oldest first. Returns where they are, or null while the
     * tracker has not found them — at the start of a take, or after it has lost them.
     */
    advance(played: readonly StudentNote[]): Position | null;
    /** Forget the position. The next `advance` searches the whole piece. */
    reset(): void;
};

const sectionAt = (sections: readonly SectionSpan[], tick: number): SectionSpan =>
    sections.find((section) => tick >= section.from && tick < section.to) ?? sections[sections.length - 1];

export const createTracker = (
    scoreNotes: readonly MeasuredNote[],
    options: Partial<TrackerOptions> = {},
): Tracker => {
    const policy = { ...DEFAULT_TRACKER_OPTIONS, ...options };
    const reference: RefNote[] = refNotesFrom(scoreNotes);

    let position: Position | null = null;
    let misses = 0;

    /** Matched fraction, which is what "confidence" means everywhere below. */
    const search = (window: readonly StudentNote[], hint: number | undefined) => {
        const result = matchSubsequence(reference, [...window], hint === undefined
            ? {}
            : { dateHint: hint, dateWindow: policy.followTicks });
        return { tick: result.range.to, confidence: window.length === 0 ? 0 : result.matches.length / window.length };
    };

    /**
     * A backward jump inside a section played twice is that section coming round again. Anywhere
     * else it is a restart, and the caller should be told the position is new rather than advanced.
     */
    const afterJump = (from: Position, toTick: number, confidence: number): Position => {
        const section = sectionAt(policy.sections, toTick);
        const sameSection = section.name === from.section;
        const repeating = sameSection && section.passes === 2 && from.pass === 1;
        return { tick: toTick, section: section.name, pass: repeating ? 2 : 1, confidence };
    };

    return {
        advance(played) {
            if (played.length === 0) return null;
            const window = played.slice(-policy.windowNotes);

            if (position === null) {
                const found = search(window, undefined);
                if (found.confidence < policy.acquireFloor) return null;
                const section = sectionAt(policy.sections, found.tick);
                position = { tick: found.tick, section: section.name, pass: 1, confidence: found.confidence };
                misses = 0;
                return position;
            }

            const followed = search(window, position.tick);
            if (followed.confidence >= policy.followFloor) {
                misses = 0;
                const wentBack = followed.tick < position.tick - policy.backwardToleranceTicks;
                // Crossing into the written-out repeat is an ordinary advance, so the section has
                // to be re-read from the tick rather than carried; a section entered by playing
                // forward into it is being played for the first time.
                const section = sectionAt(policy.sections, followed.tick);
                position = wentBack
                    ? afterJump(position, followed.tick, followed.confidence)
                    : {
                        tick: followed.tick,
                        section: section.name,
                        pass: section.name === position.section ? position.pass : 1,
                        confidence: followed.confidence,
                    };
                return position;
            }

            misses += 1;
            if (misses < policy.missesBeforeReacquire) {
                // One poor window is a wrong note or a hesitation, not a lost student.
                return { ...position, confidence: followed.confidence };
            }

            const reacquired = search(window, undefined);
            misses = 0;
            if (reacquired.confidence < policy.acquireFloor) {
                position = null;
                return null;
            }
            position = afterJump(position, reacquired.tick, reacquired.confidence);
            return position;
        },

        reset() {
            position = null;
            misses = 0;
        },
    };
};
