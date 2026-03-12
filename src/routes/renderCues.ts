import { Router } from 'express';
import { ELEVEN_V3_MODEL_ID, sanitizeCueForSpeech } from '../shared/tts';
import { synthesizeCueAudio } from '../tts/synthesize';
import { readCueLibrary } from '../tts/cueLibrary';

export const renderCuesRouter = Router();

renderCuesRouter.post('/render-cues', async (req, res) => {
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
