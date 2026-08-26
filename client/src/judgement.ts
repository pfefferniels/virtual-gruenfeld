import type { Range, StructuredDiffEvent } from './mpm';
import { PPQ } from './shared/constants';
import { severityRank } from './shared/severity';

/**
 * What the comparison knows about the take that the counted events cannot say.
 *
 * Two numbers off `compareMpm`'s report (`mpm/evidence.ts`), and both are *optional*: the score,
 * the verdict and the `√(rangeBeats/4)` normalisation above are unchanged and answer without
 * them (semantics 24), and a session record written before this existed stays readable.
 */
export type JudgementDistance = {
    /**
     * `report.aggregate.mean` — the whole window's difference in just-noticeable differences.
     * Under 1 is a difference nobody hears; the event counts have no such scale.
     */
    distanceJnd?: number;
    /**
     * `report.equivalence.subThresholdMassFraction` — the share of that difference sitting below
     * the threshold of audibility. 0.9 means almost none of it can be heard, however many events
     * cleared the raw floor.
     */
    subThresholdFraction?: number;
};

export type ImmediateJudgementPayload = JudgementDistance & {
    score: number;
    verdict: 'excellent' | 'good' | 'mixed' | 'needs_work';
    rangeBeats: number;
    eventCount: number;
    dominantTypes: Array<{
        type: string;
        penalty: number;
        count: number;
        worstSeverity: StructuredDiffEvent['severity'];
    }>;
    topIssues: Array<{
        type: string;
        severity: StructuredDiffEvent['severity'];
        cueText: string;
        position: string;
    }>;
};

const severityPenalty = (severity: StructuredDiffEvent['severity']): number =>
    severity === 'large' ? 4 : severity === 'mod' ? 2.5 : 1;

const typeLabel = (type: string): string => {
    switch (type) {
        case 'tempo': return 'am Tempo';
        case 'dynamics': return 'an der Dynamik';
        case 'articulation': return 'an der Artikulation';
        case 'rubato': return 'am Puls';
        case 'ornament': return 'an der Figur';
        case 'accentuationPattern': return 'an den Akzenten';
        case 'asynchrony': return 'am Zusammenspiel';
        default: return 'an der Stelle';
    }
};

export const summarizeImmediateJudgement = (
    diffEvents: StructuredDiffEvent[],
    range: Range,
    /** The comparison's two numbers, where the take has them. Omitted, the payload is Phase 2's. */
    distance: JudgementDistance = {},
): ImmediateJudgementPayload => {
    const rangeBeats = Math.max(1, (range.to - range.from) / PPQ);
    const byType = new Map<string, {
        penalty: number;
        count: number;
        worstSeverity: StructuredDiffEvent['severity'];
    }>();

    let totalPenalty = 0;
    for (const event of diffEvents) {
        const penalty = severityPenalty(event.severity);
        totalPenalty += penalty;
        const existing = byType.get(event.type) ?? { penalty: 0, count: 0, worstSeverity: 'slight' as const };
        byType.set(event.type, {
            penalty: existing.penalty + penalty,
            count: existing.count + 1,
            worstSeverity: severityRank(event.severity) > severityRank(existing.worstSeverity)
                ? event.severity
                : existing.worstSeverity,
        });
    }

    const scaledPenalty = totalPenalty / Math.max(1, Math.sqrt(rangeBeats / 4));
    const score = Math.max(0, Math.min(100, Math.round(100 - scaledPenalty * 10)));
    const verdict =
        score >= 88 ? 'excellent' :
            score >= 74 ? 'good' :
                score >= 58 ? 'mixed' :
                    'needs_work';

    const dominantTypes = Array.from(byType.entries())
        .map(([type, value]) => ({ type, ...value }))
        .sort((a, b) => {
            if (b.penalty !== a.penalty) return b.penalty - a.penalty;
            return severityRank(b.worstSeverity) - severityRank(a.worstSeverity);
        })
        .slice(0, 2);

    const topIssues = diffEvents
        .slice()
        .sort((a, b) => {
            const sevDelta = severityRank(b.severity) - severityRank(a.severity);
            if (sevDelta !== 0) return sevDelta;
            return b.magnitude - a.magnitude;
        })
        .slice(0, 3)
        .map((event) => ({
            type: event.type,
            severity: event.severity,
            cueText: event.cueText,
            position: event.position,
        }));

    return {
        score,
        verdict,
        rangeBeats,
        eventCount: diffEvents.length,
        dominantTypes,
        topIssues,
        // Spread last and only where they exist: a take with no comparison behind it produces
        // exactly the payload it always did, key for key.
        ...(distance.distanceJnd === undefined ? {} : { distanceJnd: distance.distanceJnd }),
        ...(distance.subThresholdFraction === undefined
            ? {}
            : { subThresholdFraction: distance.subThresholdFraction }),
    };
};

export const fallbackImmediateJudgement = (payload: ImmediateJudgementPayload): string => {
    const dominant = payload.dominantTypes[0];
    if (payload.eventCount === 0 || payload.verdict === 'excellent') {
        return 'Das war schon ziemlich gut.';
    }
    if (payload.verdict === 'good') {
        return dominant ? `Schon gut, ${typeLabel(dominant.type)} noch.` : 'Das war schon gut.';
    }
    if (payload.verdict === 'mixed') {
        return dominant ? `Wir feilen noch ${typeLabel(dominant.type)}.` : 'Da geht noch mehr.';
    }
    return dominant ? `Wir arbeiten weiter ${typeLabel(dominant.type)}.` : 'Da arbeiten wir weiter dran.';
};
