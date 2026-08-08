/**
 * Server-side twin of `client/src/shared/constants.ts`.
 * Kept separate because the server build has `rootDir: ./src` and cannot import
 * across into `client/`. Both files must agree on PPQ and the position format.
 */

export const PPQ = 720;
const BEATS_PER_MEASURE = 4;
const TICKS_PER_MEASURE = PPQ * BEATS_PER_MEASURE;

export const tickToPos = (tick: number): string => {
    const m = Math.floor(tick / TICKS_PER_MEASURE) + 1;
    const b = Math.floor((tick % TICKS_PER_MEASURE) / PPQ) + 1;
    return `m${m}.${b}`;
};

/** Compact span label: a single position when from === to, otherwise `from–to`. */
export const spanLabel = (from: number, to: number): string =>
    tickToPos(from) === tickToPos(to) ? tickToPos(from) : `${tickToPos(from)}–${tickToPos(to)}`;
