import type { CuePrepMode } from "../cueLibrary";
import type { ImmediateJudgementPayload } from "../judgement";

export const assertOk = async (r: Response) => {
    if (r.ok) return;
    let text = '';
    try { text = await r.text(); } catch { /* ignore */ }
    throw new Error(`HTTP ${r.status} ${r.statusText}${text ? `: ${text}` : ''}`);
};

// ── Teacher Stream (unified vocal) ──

export type TeacherStreamResponsePayload = {
    rawText: string;
    anchors: Array<{ marker: string; charOffset: number; text: string }>;
    cleanedText: string;
    audioBase64: string;
    alignment: {
        characters: string[];
        character_start_times_seconds: number[];
        character_end_times_seconds: number[];
    };
    model: string;
    stats: { llmMs: number; ttsMs: number; totalMs: number };
};

export const fetchTeacherStream = async (
    judgement: ImmediateJudgementPayload,
    diff: string,
    candidates: Array<Record<string, unknown>>,
    mode: CuePrepMode,
): Promise<TeacherStreamResponsePayload> => {
    const response = await fetch('/teacher-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ judgement, diff, candidates, mode }),
    });
    await assertOk(response);

    const payload = await response.json();
    return {
        rawText: payload?.rawText ?? '',
        anchors: Array.isArray(payload?.anchors) ? payload.anchors : [],
        cleanedText: payload?.cleanedText ?? '',
        audioBase64: payload?.audioBase64 ?? '',
        alignment: {
            characters: payload?.alignment?.characters ?? [],
            character_start_times_seconds: payload?.alignment?.character_start_times_seconds ?? [],
            character_end_times_seconds: payload?.alignment?.character_end_times_seconds ?? [],
        },
        model: payload?.model ?? '',
        stats: {
            llmMs: payload?.stats?.llmMs ?? 0,
            ttsMs: payload?.stats?.ttsMs ?? 0,
            totalMs: payload?.stats?.totalMs ?? 0,
        },
    };
};
