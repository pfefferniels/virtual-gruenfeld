export const PPQ = 720;
const BEATS_PER_MEASURE = 4;
const TICKS_PER_MEASURE = PPQ * BEATS_PER_MEASURE;

export const tickToPos = (tick: number): string => {
    const m = Math.floor(tick / TICKS_PER_MEASURE) + 1;
    const b = Math.floor((tick % TICKS_PER_MEASURE) / PPQ) + 1;
    return `m${m}.${b}`;
};
