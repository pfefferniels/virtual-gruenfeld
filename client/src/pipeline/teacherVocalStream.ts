import type { ImmediateJudgementPayload } from '../judgement';
import type { CuePrepMode } from '../prepMode';
import { describePlan, type LessonPlan } from '../lessonPlan';
import type { Range, StructuredDiffEvent } from '../mpm';
import { pickCueCandidates, secAtDate, type TimingMapPoint } from '../teacherCues';
import { cueDelay } from '../teacherCues';
import { positionToTick } from '../shared/constants';
import { fetchTeacherStream } from '../services/api';
import { getSessionId } from '../session';
import { chunkVocalStream, type VocalChunk } from './chunker';
import type { ScheduledCue } from './types';

// ── Request ──

export type VocalStreamResult = {
    chunks: VocalChunk[];
    /** The teacher's demonstration plan, or null when it was not asked for one. */
    plan: LessonPlan | null;
};

export const requestVocalStream = async (
    judgement: ImmediateJudgementPayload,
    diffSummary: string,
    diffEvents: StructuredDiffEvent[],
    range: Range,
    timingMap: TimingMapPoint[] | undefined,
    mode: CuePrepMode,
    audioContext: AudioContext,
    log: (msg: string) => void,
    agentic: boolean = false,
): Promise<VocalStreamResult> => {
    // Build candidates from diff events (same format as cue planning)
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

    log(`VOCAL: requesting stream (anchors=${candidates.length}, evidence=${diffEvents.length}, mode=${mode}${agentic ? ', agentic' : ''})`);
    const startedAt = Date.now();

    // The candidate list is narrowed for cue placement; the diff sent as evidence is not.
    const response = await fetchTeacherStream({
        judgement,
        diff: diffSummary,
        candidates,
        mode,
        structuredDiff: diffEvents,
        range,
        sessionId: getSessionId(),
        ...(agentic ? { agentic: true } : {}),
    });
    log(`VOCAL: stream received (llm_ms=${response.stats.llmMs}, tts_ms=${response.stats.ttsMs}, anchors=${response.anchors.length})`);
    if (response.plan) log(`VOCAL: plan ${describePlan(response.plan)}`);

    const chunks = await chunkVocalStream(response, audioContext);
    log(`VOCAL: chunked into ${chunks.length} segments (total_ms=${Date.now() - startedAt})`);

    return { chunks, plan: response.plan };
};

// ── Layout (Pool Adjacent Violators) ──

const MIN_CUE_GAP_SEC = 0.25;
const CUE_DELAY_DEFAULT_REGION = 2.0;

type LayoutItem = {
    ideal: number;
    duration: number;
    gapAfter: number;
};

/**
 * Optimally position cues to minimize total squared drift from ideal times
 * while preventing overlap. Uses isotonic regression (PAVA): each cue is a
 * bead on a rail connected by a spring to its ideal position; beads can't
 * pass through each other. The equilibrium minimizes Σ(actual − ideal)².
 */
export const layoutCues = (items: LayoutItem[]): number[] => {
    if (items.length === 0) return [];
    if (items.length === 1) return [items[0].ideal];

    // Cumulative offset so the no-overlap constraint becomes monotonicity.
    // cumOff[i] = Σ_{j<i} (duration[j] + gapAfter[j])
    const cumOff = new Array<number>(items.length);
    cumOff[0] = 0;
    for (let i = 1; i < items.length; i++) {
        cumOff[i] = cumOff[i - 1] + items[i - 1].duration + items[i - 1].gapAfter;
    }

    // Transform: target[i] = ideal[i] − cumOff[i]
    // Constraint actual[i]+dur[i]+gap ≤ actual[i+1] becomes y[i] ≤ y[i+1]
    const targets = items.map((item, i) => item.ideal - cumOff[i]);

    // Pool Adjacent Violators: enforce monotone non-decreasing
    const groups: { sum: number; count: number; value: number }[] = [];
    for (const t of targets) {
        groups.push({ sum: t, count: 1, value: t });
        while (groups.length >= 2) {
            const last = groups[groups.length - 1];
            const prev = groups[groups.length - 2];
            if (prev.value <= last.value) break;
            prev.sum += last.sum;
            prev.count += last.count;
            prev.value = prev.sum / prev.count;
            groups.pop();
        }
    }

    // Expand groups back to actual positions
    const result: number[] = [];
    let idx = 0;
    for (const group of groups) {
        for (let i = 0; i < group.count; i++) {
            result.push(group.value + cumOff[idx]);
            idx++;
        }
    }

    return result;
};

// ── Scheduling ──

/**
 * How long the teacher talks when there is nothing to play under it: every chunk
 * back to back, separated by the same gap the positional layout uses.
 */
export const talkOnlyDurationSec = (chunks: VocalChunk[]): number =>
    chunks.reduce((total, chunk) => total + chunk.audioBuffer.duration + MIN_CUE_GAP_SEC, 0);

/**
 * The `none` demo: no performance to anchor cues against, so the monologue is
 * simply spoken through in order. The positional markers lose their meaning
 * here — they are kept in sequence rather than dropped.
 */
export const scheduleTalkOnly = (
    chunks: VocalChunk[],
    scheduleAudioCue: (cue: ScheduledCue) => void,
    log: (msg: string) => void,
): void => {
    let atSec = 0;
    for (const chunk of chunks) {
        log(`VOCAL: schedule "${chunk.marker}" at ${atSec.toFixed(2)}s (talk-only)`);
        scheduleAudioCue({
            atSec,
            audioBuffer: chunk.audioBuffer,
            onStart: () => log(`VOCAL: playing "${chunk.marker}" "${chunk.text.slice(0, 30)}"`),
        });
        atSec += chunk.audioBuffer.duration + MIN_CUE_GAP_SEC;
    }
};

export const scheduleVocalStream = (
    chunks: VocalChunk[],
    timingMap: TimingMapPoint[],
    scheduleAudioCue: (cue: ScheduledCue) => void,
    log: (msg: string) => void,
    judgementDurationOffset: number = 0,
): void => {
    // JUDGE is fixed at t=0 (separate phase over mood chord)
    const judgeChunk = chunks.find((c) => c.marker === 'JUDGE');
    if (judgeChunk) {
        log(`VOCAL: schedule "JUDGE" at 0.00s (duration=${judgeChunk.audioBuffer.duration.toFixed(2)}s)`);
        scheduleAudioCue({
            atSec: 0,
            audioBuffer: judgeChunk.audioBuffer,
            onStart: () => log(`VOCAL: playing "JUDGE" "${judgeChunk.text.slice(0, 30)}"`),
        });
    }

    // Collect positional cues with ideal times
    const positional: { chunk: VocalChunk; ideal: number }[] = [];
    for (const chunk of chunks) {
        if (chunk.marker === 'JUDGE' || chunk.marker === 'END') continue;
        const tick = positionToTick(chunk.marker);
        if (tick === null) {
            log(`VOCAL: skipping chunk with unknown marker "${chunk.marker}"`);
            continue;
        }
        const anchorSec = secAtDate(timingMap, tick);
        const delay = cueDelay(CUE_DELAY_DEFAULT_REGION);
        positional.push({ chunk, ideal: anchorSec + delay + judgementDurationOffset });
    }
    positional.sort((a, b) => a.ideal - b.ideal);

    // Build layout items (positional cues only — no END marker)
    const layoutItems: { chunk: VocalChunk; ideal: number; gapAfter: number }[] = positional.map(
        (p) => ({ ...p, gapAfter: MIN_CUE_GAP_SEC }),
    );

    if (layoutItems.length === 0) return;

    // Optimal non-overlapping positions via PAVA
    const positions = layoutCues(
        layoutItems.map((item) => ({
            ideal: item.ideal,
            duration: item.chunk.audioBuffer.duration,
            gapAfter: item.gapAfter,
        })),
    );

    for (let i = 0; i < layoutItems.length; i++) {
        const { chunk } = layoutItems[i];
        const atSec = positions[i];
        const drift = atSec - layoutItems[i].ideal;
        log(
            `VOCAL: schedule "${chunk.marker}" at ${atSec.toFixed(2)}s ` +
            `(ideal=${layoutItems[i].ideal.toFixed(2)}s, drift=${drift >= 0 ? '+' : ''}${drift.toFixed(2)}s, ` +
            `duration=${chunk.audioBuffer.duration.toFixed(2)}s)`,
        );
        scheduleAudioCue({
            atSec,
            audioBuffer: chunk.audioBuffer,
            onStart: () => log(`VOCAL: playing "${chunk.marker}" "${chunk.text.slice(0, 30)}"`),
        });
    }
};
