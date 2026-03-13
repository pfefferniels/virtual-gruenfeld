import type { CuePrepMode } from "../cueLibrary";
import type { ImmediateJudgementPayload } from "../judgement";

export const assertOk = async (r: Response) => {
    if (r.ok) return;
    let text = '';
    try { text = await r.text(); } catch { /* ignore */ }
    throw new Error(`HTTP ${r.status} ${r.statusText}${text ? `: ${text}` : ''}`);
};

export type RenderCueStats = {
    requested: number;
    returned: number;
    library_hits: number;
    library_misses: number;
    synthesized: number;
    render_cues_ms: number;
    mode: CuePrepMode;
};

type TeacherCueDraft = {
    position: string;
    text: string;
};

export const fetchRenderCues = async (
    cues: Array<{ id: string; text: string }>,
    mode: CuePrepMode,
    libraryOnly: boolean,
): Promise<{ rendered: Array<{ id: string; audio_b64: string }>; stats: RenderCueStats | null }> => {
    if (cues.length === 0) return { rendered: [], stats: null };

    const response = await fetch('/render-cues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mode,
            libraryOnly,
            cues: cues.map(({ id, text }) => ({ id, text })),
        }),
    });
    await assertOk(response);

    const payload = await response.json();
    const rendered = Array.isArray(payload?.cues) ? payload.cues : [];
    const stats = typeof payload?.stats === 'object' && payload.stats !== null
        ? payload.stats as RenderCueStats
        : null;

    return {
        rendered: rendered.filter(
            (cue: unknown): cue is { id: string; audio_b64: string } =>
                typeof cue === 'object' && cue !== null &&
                typeof (cue as { id?: unknown }).id === 'string' &&
                typeof (cue as { audio_b64?: unknown }).audio_b64 === 'string'
        ),
        stats,
    };
};

export const fetchPlanCues = async (
    diffSummary: string,
    candidates: Array<Record<string, unknown>>,
    mode: CuePrepMode,
): Promise<TeacherCueDraft[]> => {
    const response = await fetch('/plan-cues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, diff: diffSummary, candidates }),
    });
    await assertOk(response);

    const payload: unknown = await response.json();
    const cues: unknown[] =
        typeof payload === 'object' && payload !== null &&
        Array.isArray((payload as { cues?: unknown[] }).cues)
            ? (payload as { cues: unknown[] }).cues
            : [];

    return cues.filter((cue): cue is TeacherCueDraft => {
        if (typeof cue !== 'object' || cue === null) return false;
        const candidate = cue as { position?: unknown; text?: unknown };
        return typeof candidate.position === 'string' && typeof candidate.text === 'string';
    });
};

export const fetchJudgement = async (
    summary: ImmediateJudgementPayload,
): Promise<string> => {
    const response = await fetch('/judge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary }),
    });
    await assertOk(response);

    const payload = await response.json();
    return typeof payload?.text === 'string' ? payload.text.trim() : '';
};

export const fetchRenderJudgement = async (
    text: string,
): Promise<string> => {
    const response = await fetch('/render-judgement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
    });
    await assertOk(response);

    const payload = await response.json();
    return typeof payload?.audio_b64 === 'string' ? payload.audio_b64 : '';
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
