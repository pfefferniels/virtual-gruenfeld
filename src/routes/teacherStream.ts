import { Router } from 'express';
import { openai, DEFAULT_CUE_MODELS, CORPUS_DEPTH, parseCuePrepMode, type CuePrepMode } from '../config';
import { buildTeacherSystemPrompt } from '../prompts/teacherStream';
import { sanitizeJudgementText } from '../prompts/judgement';
import { getRangeDetail } from '../corpus';
import {
    buildTakeRecord,
    formatSessionHistory,
    isValidSessionId,
    readSession,
    recordTake,
    scheduleProfileUpdate,
} from '../sessions';
import { synthesizeWithTimestamps } from '../tts/synthesizeWithTimestamps';
import { synthesizeCueAudio } from '../tts/synthesize';
import { ELEVEN_V3_MODEL_ID } from '../shared/tts';
import type { StreamAnchor, TeacherStreamResponse } from '../shared/teacherStream';

export const teacherStreamRouter = Router();

const ANCHOR_RE = /«([^»]+)»\s*/g;

export type TeacherStreamRequest = {
    judgement: Record<string, unknown>;
    candidates: Array<Record<string, unknown>>;
    /** Legacy pre-digested ASCII table. Used when `structuredDiff` is absent. */
    diff?: string;
    /** Full `diffStructured()` output — every measured deviation, untruncated. */
    structuredDiff?: Array<Record<string, unknown>>;
    /** Take range in ticks; unlocks the passage's scholarly record. */
    range?: { from: number; to: number };
    mode: CuePrepMode;
    /**
     * Ties this take to the student's earlier ones. Absent (a legacy client, or
     * the probe) means a stateless take: no history in, nothing recorded out.
     */
    sessionId?: string;
    /** Skip TTS — used by the smoke script to time the LLM call alone. */
    skipTts?: boolean;
};

const parseAnchors = (rawText: string): { anchors: StreamAnchor[]; cleanedText: string } => {
    const anchors: StreamAnchor[] = [];
    let cleanedText = '';
    let lastIndex = 0;

    for (const match of rawText.matchAll(ANCHOR_RE)) {
        // Normalize whitespace as we go so charOffsets match the final collapsed text
        const segment = rawText.slice(lastIndex, match.index).replace(/\s+/g, ' ');
        cleanedText += segment;
        if (anchors.length === 0) cleanedText = cleanedText.trimStart();

        const charOffset = cleanedText.length;
        const marker = match[1].trim();

        // Find the text for this anchor: everything until the next anchor or end
        const nextMatch = rawText.indexOf('«', match.index! + match[0].length);
        const segmentEnd = nextMatch !== -1 ? nextMatch : rawText.length;
        const text = rawText.slice(match.index! + match[0].length, segmentEnd).trim();

        anchors.push({ marker, charOffset, text });
        lastIndex = match.index! + match[0].length;
    }

    cleanedText += rawText.slice(lastIndex).replace(/\s+/g, ' ');
    cleanedText = cleanedText.trim();

    return { anchors, cleanedText };
};

const isRange = (value: unknown): value is { from: number; to: number } => {
    if (typeof value !== 'object' || value === null) return false;
    const { from, to } = value as { from?: unknown; to?: unknown };
    return typeof from === 'number' && Number.isFinite(from)
        && typeof to === 'number' && Number.isFinite(to)
        && to >= from;
};

/**
 * Assemble the per-take input. The scholarly record comes first (it only changes
 * when the take range changes, so it extends the cacheable prefix), the measured
 * take next, and the session history last — it changes on every single take.
 */
export const buildUserInput = (
    body: TeacherStreamRequest,
    withRangeDetail: boolean,
    historySection = '',
): string => {
    const parts: string[] = [];

    if (withRangeDetail && isRange(body.range)) {
        parts.push(getRangeDetail(body.range));
        parts.push('');
    }

    parts.push('=== JUDGEMENT SUMMARY ===');
    parts.push(JSON.stringify(body.judgement));

    if (body.structuredDiff && body.structuredDiff.length > 0) {
        parts.push(`\n=== DIFF (${body.structuredDiff.length} measured deviations) ===`);
        for (const event of body.structuredDiff) parts.push(JSON.stringify(event));
    } else {
        parts.push('\n=== DIFF ===');
        parts.push(body.diff ?? 'No significant differences found.');
    }

    if (body.candidates.length > 0) {
        parts.push('\n=== CUE CANDIDATES ===');
        for (const candidate of body.candidates) {
            parts.push(JSON.stringify(candidate));
        }
    }

    if (historySection) {
        parts.push('');
        parts.push(historySection);
    }

    return parts.join('\n');
};

/**
 * The whole teacher turn: prompt assembly, one LLM call, anchor parsing, TTS.
 * Exported so tests and the smoke script can drive it without a socket.
 */
export const runTeacherStream = async (body: TeacherStreamRequest): Promise<TeacherStreamResponse> => {
    const totalStartedAt = Date.now();
    const model = DEFAULT_CUE_MODELS[body.mode];
    const depth = CORPUS_DEPTH[body.mode];

    const sessionId = body.sessionId;
    const history = sessionId ? formatSessionHistory(readSession(sessionId)) : '';

    const llmStartedAt = Date.now();
    const response = await openai.responses.create({
        model,
        instructions: buildTeacherSystemPrompt({
            compactCorpus: depth.compactCorpus,
            memory: Boolean(sessionId),
        }),
        input: buildUserInput(body, depth.rangeDetail, history),
    });

    const rawText = response.output_text ?? '';
    const llmMs = Date.now() - llmStartedAt;
    console.log('teacher-stream llm', { model, llm_ms: llmMs, raw_length: rawText.length, history_chars: history.length });

    let { anchors, cleanedText } = parseAnchors(rawText);

    // Ensure JUDGE ends with a period → falling intonation in ElevenLabs TTS
    const judgeIdx = anchors.findIndex(a => a.marker === 'JUDGE');
    if (judgeIdx !== -1) {
        const judge = anchors[judgeIdx];
        if (judge.text && !/[.!?…]$/.test(judge.text)) {
            const insertAt = judge.charOffset + judge.text.length;
            cleanedText = cleanedText.slice(0, insertAt) + '.' + cleanedText.slice(insertAt);
            judge.text += '.';
            for (const a of anchors) {
                if (a.charOffset > judge.charOffset) a.charOffset += 1;
            }
        }
    }

    // Fallback: if no anchors, treat entire text as JUDGE
    if (anchors.length === 0 && cleanedText.trim()) {
        const sanitized = sanitizeJudgementText(cleanedText) || cleanedText.trim();
        anchors = [{ marker: 'JUDGE', charOffset: 0, text: sanitized }];
        cleanedText = sanitized;
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || 'a4oYSRgmiY0auDgVfso5';
    const modelId = process.env.ELEVENLABS_MODEL_ID || ELEVEN_V3_MODEL_ID;

    let audioBase64 = '';
    let alignment = {
        characters: [] as string[],
        character_start_times_seconds: [] as number[],
        character_end_times_seconds: [] as number[],
    };

    if (apiKey && cleanedText && !body.skipTts) {
        const ttsStartedAt = Date.now();
        try {
            const result = await synthesizeWithTimestamps(cleanedText, apiKey, voiceId, modelId);
            audioBase64 = result.audioBase64;
            alignment = result.alignment;
            console.log('teacher-stream tts', {
                tts_ms: Date.now() - ttsStartedAt,
                chars: alignment.characters.length,
            });
        } catch (ttsErr) {
            console.error('teacher-stream tts with-timestamps failed, falling back to standard TTS', ttsErr);
            // Fallback to standard TTS without alignment
            try {
                audioBase64 = await synthesizeCueAudio(cleanedText, apiKey, voiceId, modelId);
            } catch (fallbackErr) {
                console.error('teacher-stream standard TTS fallback also failed', fallbackErr);
            }
        }
    }

    // Remember the take, then refresh the student picture off the critical path.
    if (sessionId) {
        const takeNumber = recordTake(sessionId, buildTakeRecord({
            judgement: body.judgement,
            structuredDiff: body.structuredDiff,
            range: body.range,
            anchors,
        }));
        console.log('teacher-stream session', { session: sessionId, take: takeNumber });
        scheduleProfileUpdate(sessionId);
    }

    const totalMs = Date.now() - totalStartedAt;
    const ttsMs = totalMs - llmMs;

    return { rawText, anchors, cleanedText, audioBase64, alignment, model, stats: { llmMs, ttsMs, totalMs } };
};

/**
 * Validate a POST body. A take must bring a judgement plus at least one form of
 * diff: the structured events (grounded path) or the legacy ASCII table. Returns
 * null when the request cannot be served, which the route reports as 400 —
 * `probeTeacherService` relies on an empty body producing exactly that.
 */
export const parseTeacherStreamBody = (raw: unknown): TeacherStreamRequest | null => {
    const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const { judgement, candidates, diff, structuredDiff, range, mode, sessionId } = body;

    const hasStructuredDiff = Array.isArray(structuredDiff) && structuredDiff.length > 0;
    if (typeof judgement !== 'object' || judgement === null) return null;
    if (typeof diff !== 'string' && !hasStructuredDiff) return null;

    return {
        judgement: judgement as Record<string, unknown>,
        candidates: Array.isArray(candidates) ? (candidates as Array<Record<string, unknown>>) : [],
        diff: typeof diff === 'string' ? diff : undefined,
        structuredDiff: hasStructuredDiff ? (structuredDiff as Array<Record<string, unknown>>) : undefined,
        range: isRange(range) ? range : undefined,
        mode: parseCuePrepMode(mode),
        sessionId: isValidSessionId(sessionId) ? sessionId : undefined,
    };
};

teacherStreamRouter.post('/teacher-stream', async (req, res) => {
    try {
        const request = parseTeacherStreamBody(req.body);
        if (!request) {
            res.status(400).json({ error: 'Missing required fields: judgement, and diff or structuredDiff' });
            return;
        }

        const result = await runTeacherStream(request);

        console.log('teacher-stream', {
            model: result.model,
            mode: request.mode,
            anchors: result.anchors.length,
            grounded: Boolean(request.structuredDiff && request.range),
            session: request.sessionId ?? 'none',
            total_ms: result.stats.totalMs,
            llm_ms: result.stats.llmMs,
            tts_ms: result.stats.ttsMs,
        });

        res.json(result);
    } catch (e) {
        console.error('teacher-stream error', e);
        res.status(500).json({ error: String(e) });
    }
});
