/**
 * Server-side twin of `client/src/shared/constants.ts`.
 * Kept separate because the server build has `rootDir: ./src` and cannot import
 * across into `client/`. Both files must agree on PPQ and the position format.
 */

const PPQ = 720;
const BEATS_PER_MEASURE = 4;
const TICKS_PER_MEASURE = PPQ * BEATS_PER_MEASURE;

export const tickToPos = (tick: number): string => {
    const m = Math.floor(tick / TICKS_PER_MEASURE) + 1;
    const b = Math.floor((tick % TICKS_PER_MEASURE) / PPQ) + 1;
    return `m${m}.${b}`;
};

/** Inverse of `tickToPos`. Null for anything that is not a `mN.B` position. */
export const positionToTick = (position: string): number | null => {
    const match = /^m(\d+)\.(\d+)$/.exec(position.trim());
    if (!match) return null;

    const measure = Number(match[1]);
    const beat = Number(match[2]);
    if (!Number.isFinite(measure) || !Number.isFinite(beat) || measure < 1 || beat < 1 || beat > BEATS_PER_MEASURE) {
        return null;
    }

    return ((measure - 1) * BEATS_PER_MEASURE + (beat - 1)) * PPQ;
};

/** Compact span label: a single position when from === to, otherwise `from–to`. */
export const spanLabel = (from: number, to: number): string =>
    tickToPos(from) === tickToPos(to) ? tickToPos(from) : `${tickToPos(from)}–${tickToPos(to)}`;
