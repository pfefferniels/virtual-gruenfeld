const cueAudioCache = new Map<string, string>();

export const synthesizeCueAudio = async (
    text: string,
    apiKey: string,
    voiceId: string,
    modelId: string,
): Promise<string> => {
    const cacheKey = `${voiceId}::${modelId}::${text}`;
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
        const err = await response.text();
        throw new Error(`TTS error: ${err}`);
    }

    const audio = Buffer.from(await response.arrayBuffer()).toString('base64');
    cueAudioCache.set(cacheKey, audio);
    return audio;
};
