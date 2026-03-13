import { ELEVEN_V3_MODEL_ID } from '../shared/tts';
import type { TeacherStreamAlignment } from '../shared/teacherStream';

type SynthesisWithTimestampsResult = {
    audioBase64: string;
    alignment: TeacherStreamAlignment;
};

const VOICE_SETTINGS = {
    stability: 0.45,
    similarity_boost: 0.8,
    style: 0.45,
    use_speaker_boost: true,
};

export const synthesizeWithTimestamps = async (
    text: string,
    apiKey: string,
    voiceId: string,
    modelId: string = ELEVEN_V3_MODEL_ID,
): Promise<SynthesisWithTimestampsResult> => {
    const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`,
        {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                text,
                model_id: modelId,
                voice_settings: VOICE_SETTINGS,
            }),
        },
    );

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`TTS with-timestamps error: ${err}`);
    }

    const payload = await response.json() as {
        audio_base64?: string;
        alignment?: {
            characters?: string[];
            character_start_times_seconds?: number[];
            character_end_times_seconds?: number[];
        };
    };

    return {
        audioBase64: payload.audio_base64 ?? '',
        alignment: {
            characters: payload.alignment?.characters ?? [],
            character_start_times_seconds: payload.alignment?.character_start_times_seconds ?? [],
            character_end_times_seconds: payload.alignment?.character_end_times_seconds ?? [],
        },
    };
};
