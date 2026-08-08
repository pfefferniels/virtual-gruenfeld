import type { CuePrepMode } from "../cueLibrary";
import type { ImmediateJudgementPayload } from "../judgement";
import type { Range, StructuredDiffEvent } from "../mpm";

// ── AI service availability ──

const TEACHER_URL = import.meta.env.VITE_TEACHER_URL || 'http://localhost:3002';

/** Probe whether the local AI teacher service is reachable (retries for slow startup). */
export const probeTeacherService = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const r = await fetch(`${TEACHER_URL}/teacher-stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
                signal: AbortSignal.timeout(2000),
            });
            // 400 = server is there but rejected our empty payload — that's fine
            if (r.ok || r.status === 400) return true;
        } catch { /* server not ready yet */ }
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return false;
};

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

export type TeacherStreamRequestPayload = {
    judgement: ImmediateJudgementPayload;
    /** Pre-digested ASCII table. Kept as the fallback when the server is older. */
    diff: string;
    candidates: Array<Record<string, unknown>>;
    mode: CuePrepMode;
    /** Every measured deviation, untruncated — the evidence the teacher reasons from. */
    structuredDiff?: StructuredDiffEvent[];
    /** Take range in ticks, so the server can attach the passage's scholarly record. */
    range?: Range;
};

export const fetchTeacherStream = async (
    request: TeacherStreamRequestPayload,
): Promise<TeacherStreamResponsePayload> => {
    const response = await fetch(`${TEACHER_URL}/teacher-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
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
