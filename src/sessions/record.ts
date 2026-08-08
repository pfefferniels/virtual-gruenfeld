import { spanLabel } from '../shared/musicalTime';
import type { StreamAnchor } from '../shared/teacherStream';
import type { DiffDigest, TakeJudgement, TakeRecord, TeacherSaid } from './types';

/** Deviations kept verbatim in a take record. The rest survives only as a count. */
const LARGEST_KEPT = 3;
const TOP_ISSUES_KEPT = 3;

const SEVERITY_RANK: Record<string, number> = { large: 3, mod: 2, slight: 1 };

const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * Compress a take's diff to something worth carrying across takes: how much of
 * each problem there was, and the handful of deviations that dominated it.
 */
export const buildDiffDigest = (events: Array<Record<string, unknown>> | undefined): DiffDigest => {
    const list = events ?? [];
    const counts = new Map<string, number>();
    for (const event of list) {
        const type = str(event.type) ?? 'unknown';
        counts.set(type, (counts.get(type) ?? 0) + 1);
    }

    const byType = Array.from(counts.entries())
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

    const largest = [...list]
        .sort((a, b) => {
            const severity = (SEVERITY_RANK[str(b.severity) ?? ''] ?? 0) - (SEVERITY_RANK[str(a.severity) ?? ''] ?? 0);
            if (severity !== 0) return severity;
            return (num(b.magnitude) ?? 0) - (num(a.magnitude) ?? 0);
        })
        .slice(0, LARGEST_KEPT)
        .map((event) => ({
            position: str(event.position) ?? '?',
            type: str(event.type) ?? 'unknown',
            severity: str(event.severity) ?? 'slight',
            refValue: num(event.refValue),
            studentValue: num(event.studentValue),
        }));

    return { total: list.length, byType, largest };
};

const buildJudgement = (judgement: Record<string, unknown>): TakeJudgement => {
    const rawIssues = Array.isArray(judgement.topIssues) ? judgement.topIssues : [];
    const topIssues = rawIssues
        .filter((issue): issue is Record<string, unknown> => typeof issue === 'object' && issue !== null)
        .slice(0, TOP_ISSUES_KEPT)
        .map((issue) => ({
            type: str(issue.type) ?? 'unknown',
            severity: str(issue.severity) ?? 'slight',
            position: str(issue.position) ?? '?',
        }));

    return { score: num(judgement.score), verdict: str(judgement.verdict), topIssues };
};

/** Split the parsed anchors into the reaction and the cues that followed it. */
export const buildTeacherSaid = (anchors: StreamAnchor[]): TeacherSaid => {
    const judge = anchors.find((anchor) => anchor.marker === 'JUDGE');
    const cues = anchors
        .filter((anchor) => anchor.marker !== 'JUDGE' && anchor.marker !== 'END')
        .map((anchor) => ({ position: anchor.marker, text: anchor.text }))
        .filter((cue) => cue.text.length > 0);
    return { judge: judge?.text ?? '', cues };
};

export const buildTakeRecord = (input: {
    judgement: Record<string, unknown>;
    structuredDiff?: Array<Record<string, unknown>>;
    range?: { from: number; to: number };
    anchors: StreamAnchor[];
    at?: Date;
}): TakeRecord => ({
    at: (input.at ?? new Date()).toISOString(),
    range: input.range,
    rangeLabel: input.range ? spanLabel(input.range.from, input.range.to) : undefined,
    judgement: buildJudgement(input.judgement),
    diffDigest: buildDiffDigest(input.structuredDiff),
    teacherSaid: buildTeacherSaid(input.anchors),
});
