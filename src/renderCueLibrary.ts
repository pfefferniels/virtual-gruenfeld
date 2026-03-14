import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { DEFAULT_CUE_LIBRARY_TEXTS } from './cueLibraryManifest';
import { ELEVEN_V3_MODEL_ID } from './shared/tts';

const synthesizeCueAudio = async (
    text: string,
    apiKey: string,
    voiceId: string,
    modelId: string,
): Promise<string> => {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
            text,
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
        throw new Error(await response.text());
    }

    return Buffer.from(await response.arrayBuffer()).toString('base64');
};

const main = async () => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
        throw new Error('Missing ELEVENLABS_API_KEY');
    }

    const voiceId = process.env.ELEVENLABS_VOICE_ID || 'a4oYSRgmiY0auDgVfso5';
    const modelId = process.env.ELEVENLABS_MODEL_ID || ELEVEN_V3_MODEL_ID;
    const entries: Array<{ text: string; audio_b64: string }> = [];

    for (const text of DEFAULT_CUE_LIBRARY_TEXTS) {
        const audio_b64 = await synthesizeCueAudio(text, apiKey, voiceId, modelId);
        entries.push({ text, audio_b64 });
        console.log(`rendered ${text}`);
    }

    const outPath = path.resolve(process.cwd(), 'server/cue-library.json');
    fs.writeFileSync(outPath, JSON.stringify({ version: 1, entries }, null, 2));
    console.log(`wrote ${outPath}`);
};

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
