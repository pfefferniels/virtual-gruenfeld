export const PPQ = 720;
const BEATS_PER_MEASURE = 4;
const TICKS_PER_MEASURE = PPQ * BEATS_PER_MEASURE;

export const tickToPos = (tick: number): string => {
    const m = Math.floor(tick / TICKS_PER_MEASURE) + 1;
    const b = Math.floor((tick % TICKS_PER_MEASURE) / PPQ) + 1;
    return `m${m}.${b}`;
};

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
