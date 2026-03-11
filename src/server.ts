import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import OpenAI from 'openai';

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.2';
type CuePrepMode = 'realtime' | 'balanced' | 'studio';
const DEFAULT_CUE_MODELS: Record<CuePrepMode, string> = {
    realtime: process.env.OPENAI_CUE_MODEL_REALTIME || process.env.OPENAI_CUE_MODEL || 'gpt-4.1-mini',
    balanced: process.env.OPENAI_CUE_MODEL_BALANCED || process.env.OPENAI_CUE_MODEL || 'gpt-5-mini',
    studio: process.env.OPENAI_CUE_MODEL_STUDIO || process.env.OPENAI_CUE_MODEL || 'gpt-5.2',
};
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OUTPUT_LANGUAGE = process.env.OUTPUT_LANGUAGE || 'German';

const MPM_GLOSSARY = `MPM reference:
- tempo: bpm = beats per minute; accel/rit = accelerando/ritardando
- dynamics: volume = loudness (pp/p/mp/mf/f/ff); cresc/decresc = crescendo/decrescendo
- articulation: relativeDuration = note duration (1.0=legato, 0.5=staccato); relativeVelocity = emphasis (>1=accent)
- rubato: intensity = agogic strength; frameLength = cycle length
- ornament: arpeggiation of chords. temporalSpread describes the spread, dynamicsGradient the internal dynamic shading.
- accentuationPattern: scale = strength of metric accentuation
- asynchrony: milliseconds.offset = temporal offset of a voice`;

const EXPLANATION_SYSTEM_PROMPT = `You are an encouraging piano teacher speaking directly to the student. Respond in at most 2 short sentences (30 words maximum total). No lists, no numbering, no bullet points. Use musical terms (softer, more legato, less rubato). Summarize the most important deviations.

IMPORTANT: Do NOT mention measure numbers, positions, or numbers (not m2.3, not "measure 3", not "beat 1"). Describe the location musically: "at the beginning", "in the middle", "towards the end", "at the transition", etc. Your response will be read aloud — it must sound natural.

Be proportional in your feedback! Each deviation has a severity (sev column):
slight = minor deviation → "slightly", "a little" (encouraging, almost correct)
mod = noticeable deviation → "more", "less" (matter-of-fact, constructive)
large = major deviation → "much more", "noticeably" (name it clearly, but not harshly)
NEVER use "way too" or "completely wrong" — you are a patient teacher.

Example:
- Only ~: "That sounds quite good already, try connecting the melody a bit more smoothly."

You receive deviations as tables with ref (your interpretation) and student columns, grouped by type:

${MPM_GLOSSARY}

IMPORTANT: Always respond in ${OUTPUT_LANGUAGE}.`;

const CUE_SYSTEM_PROMPT = `You are a piano teacher planning concise spoken micro-cues to be interspersed during the teacher's demonstration.

IMPORTANT:
- Only choose from the given positions.
- The code will set the exact seconds later; you only decide AT WHICH musical position a cue should be spoken.
- Output at most 4 cues.
- Each cue must be extremely short: ideally 1 to 4 words, maximum 5.
- No filler, no full explanations, no introductions.
- Still, do not always use the same one-word commands. Phrase them musically, concisely, and with variety.
- Speak clearly and naturally. Every cue must be immediately understandable to an ordinary piano student.
- You may optionally use exactly ONE leading Eleven-v3 audio tag to color the emotional tone, for example [warmly], [encouragingly], [softly], [whispers], [slowly], [urgent], [curious], [excited], [sad].
- The tag is optional. If you use one, place it only at the beginning and only once.
- Use emotions deliberately to shape a small energetic arc across multiple cues.
- Think in terms of progression: early on more guiding or inviting, later more urgent, warmer, gentler, or more relaxed depending on the music.
- Not every cue needs a tag, but in a sequence of 3-4 cues, usually 3 should be emotionally colored.
- Do not always repeat the same tag. Vary the emotional tone meaningfully.
- The emotion should carry the cue, not replace it: first color emotionally, then stay musically clear.
- When you want emotional coloring, express it PRIMARILY through the Eleven-v3 tag, not just through words like "gently", "urgently", "tenderly" in the cue text itself.
- Prefer concrete vocal tags over abstract concepts. Good tags sound like performance directions for the voice.
- Avoid abstract tags like [inviting], [leading], [resolving], [supportive], [narrative].
- If multiple musical topics appear at the same position, you may combine them into one clear short cue.
- If that is not feasible, prioritize the most musically important topic at that position.
- Never output two separate cues for the same position.
- If multiple anchors would say nearly the same thing, pick only the most musically important one.
- Each candidate has a defaultCue field. This is the safe baseline and already shows the CORRECT musical direction.
- You may creatively vary defaultCue, but MUST NOT reverse its meaning.
- If defaultCue means "softer", you must not write "louder". If defaultCue means "calmer", you must not write "faster".
- When in doubt, adopt defaultCue almost verbatim.

You receive:
1. the complete diff table as context
2. possible position candidates with their position and the musical topics at that location

IMPORTANT: Write all cue texts in ${OUTPUT_LANGUAGE}.

Respond only as JSON in the schema.`;

const CUE_CONTOUR_SYSTEM_PROMPT = `You shape an existing sequence of very short piano teacher cues into an emotional arc for Eleven v3.

IMPORTANT:
- Keep the positions and core musical meaning of each cue.
- You may smooth the wording slightly, but must not change the musical direction.
- Shape the emotional contour PRIMARILY through a leading Eleven-v3 tag.
- In a sequence of 3-4 cues, usually 3 should be emotionally colored.
- Use at most one leading tag per cue.
- Vary the tags. Do not always use the same one.
- Form a small progression across the sequence: for example inviting -> guiding -> more urgent -> releasing.
- Cues stay very short. No filler.
- Use English v3 tags.
- Prefer concrete vocal or emotional tags like [warmly], [encouragingly], [softly], [whispers], [slowly], [urgent], [curious], [excited], [sad].
- Avoid abstract concept tags like [inviting], [leading], [resolving], [guiding], [poetic].

IMPORTANT: Write all cue texts in ${OUTPUT_LANGUAGE}.

Respond only as JSON in the same schema.`;

const REALTIME_CUE_SYSTEM_PROMPT = `Formulate short spoken piano teacher cues.

You receive musically pre-selected anchors.
Your task is ONLY to:
- express the given direction concisely and naturally
- optionally prepend a concrete Eleven-v3 tag
- shape a small emotional arc across the sequence

Rules:
- Keep exactly the given positions.
- At most one cue per position.
- Very short: ideally 1 to 4 words, maximum 5.
- Clear and natural.
- No explanations, no new musical issues, no measure numbers.
- Use defaultCue as the safe baseline. The direction must not be reversed.
- Optionally exactly ONE leading tag per cue, for example [warmly], [encouragingly], [softly], [whispers], [slowly], [urgent], [curious], [excited], [sad].
- Not every cue needs a tag, but the sequence should feel slightly animated.

IMPORTANT: Write all cue texts in ${OUTPUT_LANGUAGE}.

Respond only as lines in the format:
POSITION | TEXT
Example:
m2.3 | [softly] softer
m3.1 | more legato`;

const JUDGEMENT_MODEL = process.env.OPENAI_JUDGEMENT_MODEL || 'gpt-4.1-mini';
const JUDGEMENT_SYSTEM_PROMPT = `Short piano teacher sentence.
Exactly 1 sentence, 3 to 8 words, maximum 10.
Honest, concise, encouraging.
Either briefly praise or name at most ONE problem area.
Only problem areas from dominantTypes or topIssues.
No numbers, no positions, no justification.
Do not invent anything.
Respond only with the sentence.
IMPORTANT: Always respond in ${OUTPUT_LANGUAGE}.`;

const cueAudioCache = new Map<string, string>();
const ELEVEN_V3_MODEL_ID = 'eleven_v3';
const CUE_LIBRARY_PATH = path.resolve(process.cwd(), 'server/cue-library.json');
let cueLibraryCache = new Map<string, string>();
let cueLibraryMtimeMs = -1;
const ALLOWED_V3_TAGS = new Set([
    'warmly',
    'encouragingly',
    'softly',
    'whispers',
    'slowly',
    'urgent',
    'curious',
    'excited',
    'sad',
    'gently',
]);
const V3_TAG_ALIASES: Record<string, string> = {
    inviting: 'warmly',
    leading: 'encouragingly',
    resolving: 'softly',
    releasing: 'softly',
    neutral: 'slowly',
    guiding: 'encouragingly',
    supportive: 'warmly',
    tenderly: 'gently',
};

const normalizeV3Tag = (rawTag: string): string | null => {
    const normalized = rawTag.trim().toLowerCase();
    if (!normalized) return null;
    if (ALLOWED_V3_TAGS.has(normalized)) return normalized;
    return V3_TAG_ALIASES[normalized] ?? null;
};

const sanitizeCueForSpeech = (text: string, modelId: string): string => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return normalized;

    const leadingTagMatch = normalized.match(/^\[([a-zA-Z][a-zA-Z ]{0,23})\]\s*/);
    const normalizedTag = modelId === ELEVEN_V3_MODEL_ID && leadingTagMatch
        ? normalizeV3Tag(leadingTagMatch[1])
        : null;
    const leadingTag = normalizedTag ? `[${normalizedTag}] ` : '';

    const body = normalized
        .slice(leadingTagMatch?.[0].length ?? 0)
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return `${leadingTag}${body}`.trim();
};

const sanitizeJudgementText = (text: string): string => {
    const normalized = text
        .replace(/\s+/g, ' ')
        .replace(/^["'\s]+|["'\s]+$/g, '')
        .split(/\n+/)[0]
        .trim();
    if (!normalized) return '';
    if (/\bm\d+\.\d+\b/i.test(normalized)) return '';
    if (/\d/.test(normalized)) return '';
    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length < 2) return '';
    if (words.length > 10) return words.slice(0, 10).join(' ');
    return normalized;
};

const parseRealtimeCueLines = (text: string): Array<{ position: string; text: string }> => {
    const results: Array<{ position: string; text: string }> = [];
    const seen = new Set<string>();
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        const match = line.match(/^(m\d+\.\d+)\s*[|:-]\s*(.+)$/i);
        if (!match) continue;
        const position = match[1];
        const cueText = match[2].trim();
        if (!cueText || seen.has(position)) continue;
        seen.add(position);
        results.push({ position, text: cueText });
    }
    return results;
};

const readCueLibrary = (): Map<string, string> => {
    try {
        const stat = fs.statSync(CUE_LIBRARY_PATH);
        if (stat.mtimeMs === cueLibraryMtimeMs) return cueLibraryCache;

        const parsed = JSON.parse(fs.readFileSync(CUE_LIBRARY_PATH, 'utf8'));
        const next = new Map<string, string>();
        const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
        for (const entry of entries) {
            if (typeof entry?.text === 'string' && typeof entry?.audio_b64 === 'string') {
                next.set(entry.text, entry.audio_b64);
            }
        }
        cueLibraryCache = next;
        cueLibraryMtimeMs = stat.mtimeMs;
        return cueLibraryCache;
    } catch {
        cueLibraryCache = new Map();
        cueLibraryMtimeMs = -1;
        return cueLibraryCache;
    }
};

const streamExplanation = async (
    diff: string,
    send: (event: string, data: unknown) => void,
): Promise<void> => {
    const stream = await openai.responses.create({
        model: MODEL,
        stream: true,
        instructions: EXPLANATION_SYSTEM_PROMPT,
        input: diff,
    });

    for await (const event of stream as any) {
        if (event.type === 'response.output_text.delta') {
            const delta: string = event.delta ?? '';
            if (!delta) continue;
            send('delta', delta);
        } else if (event.type === 'response.failed' || event.type === 'response.incomplete') {
            send('error', { type: event.type });
            return;
        }
    }
};

const synthesizeCueAudio = async (
    text: string,
    apiKey: string,
    voiceId: string,
    modelId: string,
): Promise<string> => {
    const sanitizedText = sanitizeCueForSpeech(text, modelId);
    const cacheKey = `${voiceId}::${modelId}::${sanitizedText}`;
    const cached = cueAudioCache.get(cacheKey);
    if (cached) return cached;

    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
            text: sanitizedText,
            model_id: modelId,
            voice_settings: {
                stability: 0.7,
                similarity_boost: 0.8,
                style: 0.2,
                use_speaker_boost: true,
            },
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`TTS error: ${err}`);
    }

    const audio = Buffer.from(await response.arrayBuffer()).toString('base64');
    cueAudioCache.set(cacheKey, audio);
    return audio;
};

const planCueTexts = async (
    diff: string,
    candidates: Array<Record<string, unknown>>,
    mode: CuePrepMode,
): Promise<Array<{ position: string; text: string }>> => {
    const model = DEFAULT_CUE_MODELS[mode];
    if (mode === 'realtime') {
        const response = await openai.responses.create({
            model,
            instructions: REALTIME_CUE_SYSTEM_PROMPT,
            input: JSON.stringify({ candidates }),
            max_output_tokens: 120,
        });
        return parseRealtimeCueLines(response.output_text ?? '');
    }

    const response = await openai.responses.create({
        model,
        instructions: CUE_SYSTEM_PROMPT,
        input: JSON.stringify({
            glossary: MPM_GLOSSARY,
            diff,
            candidates,
        }),
        text: {
            format: {
                type: 'json_schema',
                name: 'cue_plan',
                strict: true,
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        cues: {
                            type: 'array',
                            maxItems: 4,
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    position: { type: 'string' },
                                    text: { type: 'string' },
                                },
                                required: ['position', 'text'],
                            },
                        },
                    },
                    required: ['cues'],
                },
            },
        },
    });

    const outputText = response.output_text?.trim();
    if (!outputText) return [];

    const parsed = JSON.parse(outputText);
    if (!Array.isArray(parsed?.cues)) return [];

    const seen = new Set<string>();
    const deduped: Array<{ position: string; text: string }> = [];
    for (const cue of parsed.cues) {
        if (typeof cue?.position !== 'string' || typeof cue?.text !== 'string') continue;
        if (seen.has(cue.position)) continue;
        seen.add(cue.position);
        deduped.push(cue);
    }
    if (deduped.length < 2) return deduped;

    try {
        const contourResponse = await openai.responses.create({
            model,
            instructions: CUE_CONTOUR_SYSTEM_PROMPT,
            input: JSON.stringify({ cues: deduped }),
            text: {
                format: {
                    type: 'json_schema',
                    name: 'cue_contour',
                    strict: true,
                    schema: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            cues: {
                                type: 'array',
                                maxItems: 4,
                                items: {
                                    type: 'object',
                                    additionalProperties: false,
                                    properties: {
                                        position: { type: 'string' },
                                        text: { type: 'string' },
                                    },
                                    required: ['position', 'text'],
                                },
                            },
                        },
                        required: ['cues'],
                    },
                },
            },
        });

        const contourText = contourResponse.output_text?.trim();
        if (!contourText) return deduped;
        const contourParsed = JSON.parse(contourText);
        if (!Array.isArray(contourParsed?.cues)) return deduped;

        const byPosition = new Map(deduped.map((cue) => [cue.position, cue]));
        const shaped: Array<{ position: string; text: string }> = [];
        for (const cue of contourParsed.cues) {
            if (typeof cue?.position !== 'string' || typeof cue?.text !== 'string') continue;
            if (!byPosition.has(cue.position)) continue;
            if (shaped.some((existing) => existing.position === cue.position)) continue;
            shaped.push({ position: cue.position, text: cue.text });
        }
        return shaped.length > 0 ? shaped : deduped;
    } catch {
        return deduped;
    }
};

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('client/build'));

app.post('/explain', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const send = (event: string, data: any) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    };

    try {
        await streamExplanation(req.body.diff, send);
    } catch (e) {
        console.error('explain error', e);
        send('error', { message: String(e) });
    } finally {
        res.end();
    }
});

app.post('/render-cues', async (req, res) => {
    try {
        const startedAt = Date.now();
        const cues = Array.isArray(req.body?.cues) ? req.body.cues : [];
        const mode = req.body?.mode === 'studio' || req.body?.mode === 'balanced' || req.body?.mode === 'realtime'
            ? req.body.mode
            : 'balanced';
        const libraryOnly = req.body?.libraryOnly === true;
        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (cues.length === 0) {
            res.json({ cues: [] });
            return;
        }

        const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
        const modelId = process.env.ELEVENLABS_MODEL_ID || ELEVEN_V3_MODEL_ID;
        const cueLibrary = mode === 'studio' ? new Map<string, string>() : readCueLibrary();
        let libraryHits = 0;
        let synthesized = 0;

        const rendered: Array<{ id?: string; text: string; audio_b64: string } | null> = [];
        for (const cue of cues as Array<{ id?: string; text?: string }>) {
            const text = typeof cue.text === 'string' ? cue.text.trim() : '';
            if (!text) {
                rendered.push(null);
                continue;
            }

            const sanitizedText = sanitizeCueForSpeech(text, modelId);
            const fromLibrary = cueLibrary.get(sanitizedText);
            if (fromLibrary) {
                libraryHits++;
                rendered.push({
                    id: cue.id,
                    text,
                    audio_b64: fromLibrary,
                });
                continue;
            }

            if (libraryOnly || !apiKey) {
                rendered.push(null);
                continue;
            }

            const audio_b64 = await synthesizeCueAudio(text, apiKey, voiceId, modelId);
            synthesized++;
            rendered.push({
                id: cue.id,
                text,
                audio_b64,
            });
        }

        const returned = rendered.filter(Boolean);
        const stats = {
            mode,
            requested: cues.length,
            returned: returned.length,
            library_hits: libraryHits,
            synthesized,
            library_misses: cues.length - libraryHits,
            render_cues_ms: Date.now() - startedAt,
        };
        console.log('render-cues', stats);
        res.json({ cues: returned, stats });
    } catch (e) {
        console.error('render-cues error', e);
        res.status(500).json({ error: String(e) });
    }
});

app.post('/plan-cues', async (req, res) => {
    try {
        const startedAt = Date.now();
        const diff = typeof req.body?.diff === 'string' ? req.body.diff : '';
        const candidates = Array.isArray(req.body?.candidates) ? req.body.candidates : [];
        const mode: CuePrepMode = req.body?.mode === 'studio' || req.body?.mode === 'balanced' || req.body?.mode === 'realtime'
            ? req.body.mode
            : 'balanced';
        if (!diff || candidates.length === 0) {
            res.json({ cues: [] });
            return;
        }

        const cues = await planCueTexts(diff, candidates, mode);
        console.log('plan-cues', {
            mode,
            model: DEFAULT_CUE_MODELS[mode],
            candidates: candidates.length,
            returned: cues.length,
            plan_cues_ms: Date.now() - startedAt,
        });
        res.json({ cues });
    } catch (e) {
        console.error('plan-cues error', e);
        res.status(500).json({ error: String(e) });
    }
});

app.post('/judge', async (req, res) => {
    try {
        const startedAt = Date.now();
        const summary = req.body?.summary;
        if (typeof summary !== 'object' || summary === null) {
            res.json({ text: '' });
            return;
        }

        const response = await openai.responses.create({
            model: JUDGEMENT_MODEL,
            instructions: JUDGEMENT_SYSTEM_PROMPT,
            input: JSON.stringify(summary),
            max_output_tokens: 18,
        });

        const text = sanitizeJudgementText(response.output_text ?? '');
        console.log('judge', {
            model: JUDGEMENT_MODEL,
            judgement_ms: Date.now() - startedAt,
            text,
        });
        res.json({ text });
    } catch (e) {
        console.error('judge error', e);
        res.status(500).json({ error: String(e) });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
    console.log(`Virtual Grünfeld server running on port ${PORT}`);
});
