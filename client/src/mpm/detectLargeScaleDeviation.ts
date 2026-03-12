import type { StructuredDiffEvent, Range } from './types';
import { TICKS_PER_MEASURE } from '../shared/constants';

const MACRO_TYPES = new Set(['tempo', 'dynamics']);
const MIN_CONSECUTIVE_MEASURES = 2;

const severityRank = (sev: string): number =>
    sev === 'large' ? 3 : sev === 'mod' ? 2 : 1;

/**
 * Detect 2+ consecutive measures with substantial (≥mod) tempo or dynamics deviations.
 * Returns a padded tick range covering the deviant section, or null.
 */
export const detectLargeScaleDeviation = (
    events: StructuredDiffEvent[],
    range: Range,
    paddingMeasures: number = 1,
): Range | null => {
    const macroEvents = events.filter(
        e => MACRO_TYPES.has(e.type) && severityRank(e.severity) >= 2,
    );
    if (macroEvents.length === 0) return null;

    const measures = new Set<number>();
    for (const e of macroEvents) {
        measures.add(Math.floor(e.date / TICKS_PER_MEASURE) + 1);
    }

    const sorted = Array.from(measures).sort((a, b) => a - b);
    let bestStart = sorted[0], bestEnd = sorted[0], bestLen = 1;
    let curStart = sorted[0], curEnd = sorted[0], curLen = 1;

    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === curEnd + 1) {
            curEnd = sorted[i];
            curLen++;
        } else {
            if (curLen > bestLen) {
                bestStart = curStart; bestEnd = curEnd; bestLen = curLen;
            }
            curStart = sorted[i]; curEnd = sorted[i]; curLen = 1;
        }
    }
    if (curLen > bestLen) {
        bestStart = curStart; bestEnd = curEnd; bestLen = curLen;
    }

    if (bestLen < MIN_CONSECUTIVE_MEASURES) return null;

    const paddedStart = Math.max(1, bestStart - paddingMeasures);
    const paddedEnd = bestEnd + paddingMeasures;

    return {
        from: Math.max(range.from, (paddedStart - 1) * TICKS_PER_MEASURE),
        to: Math.min(range.to, paddedEnd * TICKS_PER_MEASURE),
    };
};
