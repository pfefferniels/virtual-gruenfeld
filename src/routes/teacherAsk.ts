import { Router } from 'express';

import { transcribeQuestion, type QuestionAudio } from '../audio/transcribe';
import { openai, CORPUS_DEPTH, DEFAULT_CUE_MODELS, parseCuePrepMode, type CuePrepMode } from '../config';
import { buildTeacherSystemPrompt } from '../prompts/teacherStream';
import { formatSessionHistory, isValidSessionId, readSession, recordQa } from '../sessions';
import { ELEVEN_ASK_MODEL_ID } from '../shared/tts';
import type { TeacherAskResponse } from '../shared/teacherAsk';
import { synthesizeCueAudio } from '../tts/synthesize';

export const teacherAskRouter = Router();

/** Long enough for any spoken question; short enough that nobody pastes an essay. */
const MAX_QUESTION_CHARS = 800;

type TeacherAskRequest = {
    /** Ties the question to the takes of the same sitting. */
    sessionId?: string;
    /** The question as text. Takes precedence over `audio` when both arrive. */
    question?: string;
    /** The question as a recording, to be transcribed first. */
    audio?: QuestionAudio;
    mode: CuePrepMode;
    /** Skip TTS — used by the smoke script to time the text path alone. */
    skipTts?: boolean;
};

/** «MARKER» belongs to the demonstration. If one slips through, it is not spoken. */
const MARKER_RE = /«[^»]*»/g;

const stripMarkers = (text: string): string => {
    if (!text.includes('«')) return text.trim();
    console.warn('teacher-ask answer carried cue markers, stripping them');
    return text.replace(MARKER_RE, ' ').replace(/\s+/g, ' ').trim();
};

const parseAudio = (raw: unknown): QuestionAudio | undefined => {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const { data, mimeType } = raw as { data?: unknown; mimeType?: unknown };
    if (typeof data !== 'string' || data.length === 0) return undefined;
    return { data, mimeType: typeof mimeType === 'string' && mimeType ? mimeType : 'audio/webm' };
};

/**
 * Validate a POST body. A question must arrive one way or the other; neither is
 * a 400, the same shape of refusal `/teacher-stream` gives an empty body.
 */
export const parseTeacherAskBody = (raw: unknown): TeacherAskRequest | null => {
    const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

    const question = typeof body.question === 'string'
        ? body.question.trim().slice(0, MAX_QUESTION_CHARS)
        : '';
    const audio = parseAudio(body.audio);
    if (!question && !audio) return null;

    return {
        ...(question ? { question } : {}),
        ...(audio ? { audio } : {}),
        sessionId: isValidSessionId(body.sessionId) ? body.sessionId : undefined,
        mode: parseCuePrepMode(body.mode),
    };
};

/**
 * The question goes last: it is what the teacher has to answer, and the history
 * before it is the same block the take path builds.
 */
export const buildAskInput = (question: string, historySection = ''): string => {
    const parts: string[] = [];
    if (historySection) {
        parts.push(historySection);
        parts.push('');
    }
    parts.push('=== STUDENT QUESTION ===');
    parts.push(question);
    return parts.join('\n');
};

/**
 * Transcribe, answer, speak. Exported so tests and the smoke script can drive the
 * whole turn without a socket, exactly as `runTeacherStream` is.
 */
export const runTeacherAsk = async (body: TeacherAskRequest): Promise<TeacherAskResponse> => {
    const totalStartedAt = Date.now();
    const model = DEFAULT_CUE_MODELS[body.mode];
    const depth = CORPUS_DEPTH[body.mode];

    let transcribeMs = 0;
    let question = body.question ?? '';
    if (!question && body.audio) {
        const startedAt = Date.now();
        question = await transcribeQuestion(body.audio);
        transcribeMs = Date.now() - startedAt;
        console.log('teacher-ask transcript', { transcribe_ms: transcribeMs, chars: question.length });
    }

    // Nothing intelligible was said. Answering anyway would mean inventing the question.
    if (!question) {
        console.warn('teacher-ask heard nothing');
        return {
            transcript: '',
            answerText: '',
            audioBase64: '',
            model,
            stats: { transcribeMs, llmMs: 0, ttsMs: 0, totalMs: Date.now() - totalStartedAt },
        };
    }

    const history = body.sessionId ? formatSessionHistory(readSession(body.sessionId)) : '';

    const llmStartedAt = Date.now();
    const response = await openai.responses.create({
        model,
        instructions: buildTeacherSystemPrompt({ compactCorpus: depth.compactCorpus, qa: true }),
        input: buildAskInput(question, history),
    });
    const llmMs = Date.now() - llmStartedAt;

    const answerText = stripMarkers(response.output_text ?? '');
    console.log('teacher-ask llm', { model, llm_ms: llmMs, answer_chars: answerText.length, history_chars: history.length });

    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || 'a4oYSRgmiY0auDgVfso5';
    // An answer is prose with no cue timestamps to slice, so it does not need v3.
    // Deliberately not falling back to ELEVENLABS_MODEL_ID: that variable belongs
    // to the take path, and inheriting it here would silently hand the answer back
    // to the 10s model (see ELEVEN_ASK_MODEL_ID).
    const modelId = process.env.ELEVENLABS_ASK_MODEL_ID || ELEVEN_ASK_MODEL_ID;

    let audioBase64 = '';
    let ttsMs = 0;
    if (apiKey && answerText && !body.skipTts) {
        const ttsStartedAt = Date.now();
        try {
            audioBase64 = await synthesizeCueAudio(answerText, apiKey, voiceId, modelId);
        } catch (err) {
            // A silent teacher is still an answer; the text carries it.
            console.error('teacher-ask tts failed, answering in text only', err);
        }
        ttsMs = Date.now() - ttsStartedAt;
    }

    if (body.sessionId && answerText) {
        const count = recordQa(body.sessionId, {
            kind: 'qa',
            at: new Date().toISOString(),
            question,
            answer: answerText,
        });
        console.log('teacher-ask session', { session: body.sessionId, questions: count });
    }

    return {
        transcript: question,
        answerText,
        audioBase64,
        model,
        stats: { transcribeMs, llmMs, ttsMs, totalMs: Date.now() - totalStartedAt },
    };
};

teacherAskRouter.post('/teacher-ask', async (req, res) => {
    try {
        const request = parseTeacherAskBody(req.body);
        if (!request) {
            res.status(400).json({ error: 'Missing required field: question or audio' });
            return;
        }

        const result = await runTeacherAsk(request);

        console.log('teacher-ask', {
            model: result.model,
            mode: request.mode,
            spoken: Boolean(request.audio && !request.question),
            session: request.sessionId ?? 'none',
            answered: result.answerText.length > 0,
            audio: result.audioBase64.length > 0,
            total_ms: result.stats.totalMs,
            transcribe_ms: result.stats.transcribeMs,
            llm_ms: result.stats.llmMs,
            tts_ms: result.stats.ttsMs,
        });

        res.json(result);
    } catch (e) {
        console.error('teacher-ask error', e);
        res.status(500).json({ error: String(e) });
    }
});
