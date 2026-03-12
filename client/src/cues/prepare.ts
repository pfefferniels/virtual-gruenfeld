import type { CuePrepMode } from "../cueLibrary";
import { REALTIME_CUE_AUDIO_BUDGET_MS } from "../cueLibrary";
import type { TeacherCue } from "../teacherCues";
import { renderCueAudioBuffers } from "./render";

export type PreparedTeacherCue = TeacherCue & {
    audioBuffer: AudioBuffer;
};

const CUE_OVERLAP_PADDING_SEC = 0.08;
const MAX_MERGED_CUE_WORDS = 8;

const splitCueText = (text: string): { tag: string | null; body: string } => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    const tagMatch = normalized.match(/^\[([^\]]+)\]\s*/);
    const tag = tagMatch ? `[${tagMatch[1].trim()}]` : null;
    const body = normalized.slice(tagMatch?.[0].length ?? 0).trim();
    return { tag, body };
};

const cueWordCount = (text: string): number =>
    splitCueText(text).body.split(/[ ,]+/).filter(Boolean).length;

const mergeCueTexts = (first: string, second: string): string | null => {
    const left = splitCueText(first);
    const right = splitCueText(second);
    if (!left.body || !right.body) return null;

    if (cueWordCount(left.body) + cueWordCount(right.body) > MAX_MERGED_CUE_WORDS) {
        return null;
    }

    if (left.tag && right.tag && left.tag === right.tag) {
        return `${left.tag} ${left.body}, ${right.body}`.trim();
    }
    if (left.tag && right.tag) {
        return `${left.tag} ${left.body}, ${right.tag} ${right.body}`.trim();
    }
    if (left.tag) {
        return `${left.tag} ${left.body}, ${right.body}`.trim();
    }
    if (right.tag) {
        return `${left.body}, ${right.tag} ${right.body}`.trim();
    }
    return `${left.body}, ${right.body}`.trim();
};

const chooseStrongerCue = (left: PreparedTeacherCue, right: PreparedTeacherCue): PreparedTeacherCue => {
    if (left.priority !== right.priority) {
        return left.priority > right.priority ? left : right;
    }
    return left.atSec <= right.atSec ? left : right;
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> => {
    if (timeoutMs <= 0) return fallback;
    return await Promise.race([
        promise,
        new Promise<T>((resolve) => window.setTimeout(() => resolve(fallback), timeoutMs)),
    ]);
};

const resolvePreparedCueCollisions = async (
    prepared: PreparedTeacherCue[],
    audioContext: AudioContext,
    log: (msg: string) => void,
    mode: CuePrepMode,
    deadlineAtMs?: number,
): Promise<PreparedTeacherCue[]> => {
    const cues = prepared.slice().sort((a, b) => a.atSec - b.atSec);

    for (let i = 0; i < cues.length - 1;) {
        const current = cues[i];
        const next = cues[i + 1];
        const currentEnd = current.atSec + current.audioBuffer.duration + CUE_OVERLAP_PADDING_SEC;
        if (next.atSec >= currentEnd) {
            i++;
            continue;
        }

        const mergedText = mergeCueTexts(current.text, next.text);
        const canMergeNow = mode !== 'realtime' || (deadlineAtMs != null && Date.now() < deadlineAtMs);
        if (mergedText && canMergeNow) {
            const mergedCue: TeacherCue = {
                id: `${current.id}__${next.id}`,
                atSec: current.atSec,
                text: mergedText,
                anchorDate: current.anchorDate,
                severity: chooseStrongerCue(current, next).severity,
                type: chooseStrongerCue(current, next).type,
                priority: current.priority + next.priority,
            };
            const rendered = await renderCueAudioBuffers([mergedCue], audioContext, mode, false, log);
            const audioBuffer = rendered.buffers.get(mergedCue.id);
            if (audioBuffer) {
                log(`CUE: merged overlap "${current.text}" + "${next.text}" -> "${mergedText}"`);
                cues.splice(i, 2, { ...mergedCue, audioBuffer });
                continue;
            }
        }

        const stronger = chooseStrongerCue(current, next);
        const weaker = stronger === current ? next : current;
        log(`CUE: dropped overlapping cue "${weaker.text}" in favor of "${stronger.text}"`);
        cues.splice(stronger === current ? i + 1 : i, 1);
    }

    return cues;
};

export const prepareTeacherCues = async (
    cues: TeacherCue[],
    audioContext: AudioContext,
    log: (msg: string) => void,
    mode: CuePrepMode = 'balanced',
    deadlineAtMs?: number,
): Promise<PreparedTeacherCue[]> => {
    if (cues.length === 0) return [];

    log(`CUE: rendering ${cues.length} cue clips…`);
    const startedAt = Date.now();
    let renderedById: Map<string, AudioBuffer>;
    if (mode === 'realtime') {
        const initial = await renderCueAudioBuffers(cues, audioContext, mode, true, log);
        const missing = cues.filter((cue) => !initial.buffers.has(cue.id));
        renderedById = new Map(initial.buffers);

        if (missing.length > 0) {
            const remainingMs = deadlineAtMs != null
                ? Math.max(0, Math.min(deadlineAtMs - Date.now(), REALTIME_CUE_AUDIO_BUDGET_MS))
                : REALTIME_CUE_AUDIO_BUDGET_MS;
            const late = await withTimeout(
                renderCueAudioBuffers(missing, audioContext, mode, false, log),
                remainingMs,
                { buffers: new Map<string, AudioBuffer>(), stats: null },
            );
            for (const [id, buffer] of late.buffers.entries()) {
                renderedById.set(id, buffer);
            }
        }
    } else {
        renderedById = (await renderCueAudioBuffers(cues, audioContext, mode, false, log)).buffers;
    }

    const prepared: PreparedTeacherCue[] = [];
    for (const cue of cues) {
        const audioBuffer = renderedById.get(cue.id);
        if (!audioBuffer) continue;
        prepared.push({
            ...cue,
            audioBuffer,
        });
    }
    const collisionFree = await resolvePreparedCueCollisions(prepared, audioContext, log, mode, deadlineAtMs);
    log(`CUE: total cue_audio_ms=${Date.now() - startedAt}`);
    log(`CUE: ready ${collisionFree.length}/${cues.length}`);
    return collisionFree;
};
