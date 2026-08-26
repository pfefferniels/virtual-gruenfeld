import type { CuePrepMode } from "../prepMode";
import type { ImmediateJudgementPayload } from "../judgement";
import { readLessonPlan, type LessonPlan } from "../lessonPlan";
import type { Range, StructuredDiffEvent } from "../mpm";

// ── AI service availability ──

/** Documented in SPOKEN_FEEDBACK.md and DEPLOYMENT.md — users type this by hand. */
const TEACHER_URL_KEY = 'TEACHER_URL';

const LOCAL_TEACHER_URL = 'http://localhost:3002';

const tidy = (url: string | undefined | null): string => (url ?? '').trim().replace(/\/$/, '');

/**
 * Where the teacher service lives, most specific first:
 *
 * 1. `localStorage.TEACHER_URL` — one browser pointed somewhere by hand. This is
 *    how you run a local teacher against the deployed page (see SPOKEN_FEEDBACK.md),
 *    and how you try a deployed one without rebuilding the client.
 * 2. `VITE_TEACHER_URL`, baked in at build time (see DEPLOYMENT.md).
 * 3. The local server, but only while developing. A deployed build deliberately
 *    guesses nothing: probing localhost from every visitor's browser buys six
 *    seconds of failing requests for the one visitor in a thousand running a
 *    server, who can opt in with (1).
 */
export const resolveTeacherUrl = (
    env: { VITE_TEACHER_URL?: string; DEV?: boolean },
    override?: string | null,
): string => tidy(override) || tidy(env.VITE_TEACHER_URL) || (env.DEV ? LOCAL_TEACHER_URL : '');

const storedTeacherUrl = (): string | null => {
    try {
        return localStorage.getItem(TEACHER_URL_KEY);
    } catch {
        return null; // Private mode, or no DOM at all under vitest.
    }
};

const TEACHER_URL = resolveTeacherUrl(import.meta.env, storedTeacherUrl());

/** Probe whether the AI teacher service is reachable (retries for slow startup). */
export const probeTeacherService = async (): Promise<boolean> => {
    if (!TEACHER_URL) return false;

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

type TeacherStreamResponsePayload = {
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
    /** Present only when the request asked for it (see `featureFlags.ts`). */
    plan: LessonPlan | null;
    stats: { llmMs: number; ttsMs: number; totalMs: number };
};

type TeacherStreamRequestPayload = {
    judgement: ImmediateJudgementPayload;
    /** Pre-digested ASCII table. Kept as the fallback when the server is older. */
    diff: string;
    candidates: Array<Record<string, unknown>>;
    mode: CuePrepMode;
    /** Every measured deviation, untruncated — the evidence the teacher reasons from. */
    structuredDiff?: StructuredDiffEvent[];
    /** Take range in ticks, so the server can attach the passage's scholarly record. */
    range?: Range;
    /**
     * What this take measured (DESIGN §3.4): what a plan may name, and what the take record is
     * stamped with so later takes know which dimensions were even listened for (risk R7).
     */
    measuredTypes?: readonly string[];
    /** Ties this take to the earlier ones of the same sitting (see `session.ts`). */
    sessionId?: string;
    /** Ask the teacher to plan the demonstration instead of always exaggerating the whole take. */
    agentic?: boolean;
};

// ── Teacher Ask (push-to-talk question) ──

type TeacherAskRequestPayload = {
    /** The question as text. Wins over `audio` when both are sent. */
    question?: string;
    /** The recorded question, base64, as MediaRecorder produced it. */
    audio?: { data: string; mimeType: string };
    /** Puts the question in the same lesson as the takes (see `session.ts`). */
    sessionId?: string;
    mode?: CuePrepMode;
};

type TeacherAskResponsePayload = {
    /** What the server heard. Empty when nothing intelligible was said. */
    transcript: string;
    answerText: string;
    /** Empty when TTS is unavailable or failed — the answer text still stands. */
    audioBase64: string;
    model: string;
    stats: { transcribeMs: number; llmMs: number; ttsMs: number; totalMs: number };
};

export const askTeacher = async (
    request: TeacherAskRequestPayload,
): Promise<TeacherAskResponsePayload> => {
    const response = await fetch(`${TEACHER_URL}/teacher-ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
    });
    await assertOk(response);

    const payload = await response.json();
    return {
        transcript: payload?.transcript ?? '',
        answerText: payload?.answerText ?? '',
        audioBase64: payload?.audioBase64 ?? '',
        model: payload?.model ?? '',
        stats: {
            transcribeMs: payload?.stats?.transcribeMs ?? 0,
            llmMs: payload?.stats?.llmMs ?? 0,
            ttsMs: payload?.stats?.ttsMs ?? 0,
            totalMs: payload?.stats?.totalMs ?? 0,
        },
    };
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
        plan: readLessonPlan(payload?.plan),
        stats: {
            llmMs: payload?.stats?.llmMs ?? 0,
            ttsMs: payload?.stats?.ttsMs ?? 0,
            totalMs: payload?.stats?.totalMs ?? 0,
        },
    };
};
