import { Router } from 'express';
import { sanitizeJudgementText } from '../prompts/judgement';
import { ELEVEN_V3_MODEL_ID } from '../shared/tts';
import { synthesizeCueAudio } from '../tts/synthesize';

export const renderJudgementRouter = Router();

renderJudgementRouter.post('/render-judgement', async (req, res) => {
    try {
        const startedAt = Date.now();
        const text = sanitizeJudgementText(typeof req.body?.text === 'string' ? req.body.text : '');
        if (!text) {
            res.json({ audio_b64: '' });
            return;
        }

        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) {
            res.json({ audio_b64: '' });
            return;
        }

        const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
        const modelId = process.env.ELEVENLABS_MODEL_ID || ELEVEN_V3_MODEL_ID;
        const audio_b64 = await synthesizeCueAudio(text, apiKey, voiceId, modelId);

        console.log('render-judgement', {
            text,
            render_judgement_ms: Date.now() - startedAt,
        });
        res.json({ audio_b64 });
    } catch (e) {
        console.error('render-judgement error', e);
        res.status(500).json({ error: String(e) });
    }
});
