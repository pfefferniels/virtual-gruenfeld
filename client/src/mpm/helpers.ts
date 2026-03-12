import type { MPM } from 'mpm-ts';
import type { Range } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const inRange = (i: any, range: Range) => {
    const date = i.date ?? i["date"];
    return typeof date === 'number' && date >= range.from && date <= range.to;
};

export const indexInstructions = (mpm: MPM) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const idx = new Map<string, any>();
    for (const i of mpm.getInstructions()) {
        idx.set(`${i.type}::${i["xml:id"]}`, i);
    }
    return idx;
};
