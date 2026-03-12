import type { CuePrepMode } from "../cueLibrary";
import type { StructuredDiffEvent } from "../mpm/types";
import { pickCueCandidates, planTeacherCues, resolveTeacherCuePlan, type TeacherCue, type TeacherCueDraft, type TimingMapPoint } from "../teacherCues";
import { fetchPlanCues } from "../services/api";

export const resolveTeacherCues = (
    diffEvents: StructuredDiffEvent[],
    timingMap: TimingMapPoint[],
    drafts: TeacherCueDraft[] = [],
): TeacherCue[] => (
    drafts.length > 0
        ? resolveTeacherCuePlan(diffEvents, timingMap, drafts)
        : planTeacherCues(diffEvents, timingMap)
);

export const requestTeacherCuePlan = async (
    diffSummary: string,
    diffEvents: StructuredDiffEvent[],
    mode: CuePrepMode,
    timingMap: TimingMapPoint[] | undefined,
    log: (msg: string) => void,
): Promise<TeacherCueDraft[]> => {
    if (diffEvents.length === 0) return [];

    const positions = new Map<string, StructuredDiffEvent[]>();
    if (mode === 'realtime' && timingMap) {
        for (const candidate of pickCueCandidates(diffEvents, timingMap)) {
            positions.set(candidate.position, [candidate.event]);
        }
    } else {
        for (const event of diffEvents) {
            const group = positions.get(event.position) ?? [];
            group.push(event);
            positions.set(event.position, group);
        }
    }

    log(`CUE: planning ${positions.size} beat anchors via LLM…`);
    const candidates = Array.from(positions.entries()).map(([position, events]) => ({
        position,
        issues: events.map((event) => ({
            type: event.type,
            severity: event.severity,
            direction: event.direction,
            primaryAttr: event.primaryAttr,
            refValue: event.refValue,
            studentValue: event.studentValue,
        })),
    }));

    return fetchPlanCues(diffSummary, candidates, mode);
};
