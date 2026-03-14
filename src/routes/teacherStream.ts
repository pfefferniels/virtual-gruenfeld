import { Router } from 'express';
import { openai, DEFAULT_CUE_MODELS, parseCuePrepMode, OUTPUT_LANGUAGE } from '../config';
import { TEACHER_STREAM_SYSTEM_PROMPT } from '../prompts/teacherStream';
import { sanitizeJudgementText } from '../prompts/judgement';
import { synthesizeWithTimestamps } from '../tts/synthesizeWithTimestamps';
import { synthesizeCueAudio } from '../tts/synthesize';
import { ELEVEN_V3_MODEL_ID } from '../shared/tts';
import type { StreamAnchor, TeacherStreamResponse } from '../shared/teacherStream';

export const teacherStreamRouter = Router();

const ANCHOR_RE = /«([^»]+)»\s*/g;

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

const buildUserInput = (body: {
    judgement: Record<string, unknown>;
    candidates: Array<Record<string, unknown>>;
    diff: string;
}): string => {
    const parts: string[] = [];

    parts.push('=== JUDGEMENT SUMMARY ===');
    parts.push(JSON.stringify(body.judgement));

    parts.push('\n=== DIFF ===');
    parts.push(body.diff);

    if (body.candidates.length > 0) {
        parts.push('\n=== CUE CANDIDATES ===');
        for (const candidate of body.candidates) {
            parts.push(JSON.stringify(candidate));
        }
    }

    return parts.join('\n');
};

teacherStreamRouter.post('/teacher-stream', async (req, res) => {
    const totalStartedAt = Date.now();

    try {
        const { judgement, candidates, diff, mode: rawMode } = req.body ?? {};
        const mode = parseCuePrepMode(rawMode);

        if (typeof judgement !== 'object' || judgement === null || typeof diff !== 'string') {
            res.status(400).json({ error: 'Missing required fields: judgement, diff' });
            return;
        }

        const validCandidates = Array.isArray(candidates) ? candidates : [];
        const model = DEFAULT_CUE_MODELS[mode];

        // 1. LLM call
        const llmStartedAt = Date.now();
        const response = await openai.responses.create({
            model,
            instructions: TEACHER_STREAM_SYSTEM_PROMPT,
            input: buildUserInput({ judgement, candidates: validCandidates, diff }),
        });

        const rawText = response.output_text ?? '';
        const llmMs = Date.now() - llmStartedAt;
        console.log('teacher-stream llm', { model, llm_ms: llmMs, raw_length: rawText.length });

        // 2. Parse anchors
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

        // 3. TTS with timestamps
        const apiKey = process.env.ELEVENLABS_API_KEY;
        const voiceId = process.env.ELEVENLABS_VOICE_ID || 'a4oYSRgmiY0auDgVfso5';
        const modelId = process.env.ELEVENLABS_MODEL_ID || ELEVEN_V3_MODEL_ID;

        let audioBase64 = '';
        let alignment = {
            characters: [] as string[],
            character_start_times_seconds: [] as number[],
            character_end_times_seconds: [] as number[],
        };

        if (apiKey && cleanedText) {
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

        const totalMs = Date.now() - totalStartedAt;
        const ttsMs = totalMs - llmMs;

        const result: TeacherStreamResponse = {
            rawText,
            anchors,
            cleanedText,
            audioBase64,
            alignment,
            model,
            stats: { llmMs, ttsMs, totalMs },
        };

        console.log('teacher-stream', {
            model,
            mode,
            anchors: anchors.length,
            total_ms: totalMs,
            llm_ms: llmMs,
            tts_ms: ttsMs,
        });

        res.json(result);
    } catch (e) {
        console.error('teacher-stream error', e);
        res.status(500).json({ error: String(e) });
    }
});
