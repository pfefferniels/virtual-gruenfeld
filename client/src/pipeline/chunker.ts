export type TeacherStreamAlignment = {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
};

export type StreamAnchor = {
    marker: string;
    charOffset: number;
    text: string;
};

export type TeacherStreamResponse = {
    rawText: string;
    anchors: StreamAnchor[];
    cleanedText: string;
    audioBase64: string;
    alignment: TeacherStreamAlignment;
    model: string;
    stats: {
        llmMs: number;
        ttsMs: number;
        totalMs: number;
    };
};

export type VocalChunk = {
    marker: string;
    text: string;
    startSec: number;
    endSec: number;
    audioBuffer: AudioBuffer;
};

// ── Alignment mapping ──

/** Map a character offset in the cleaned text to a time (seconds) via the alignment array. */
export const charOffsetToTime = (
    charOffset: number,
    alignment: TeacherStreamAlignment,
): number | null => {
    if (
        alignment.characters.length === 0 ||
        alignment.character_start_times_seconds.length === 0
    ) {
        return null;
    }

    if (charOffset <= 0) return alignment.character_start_times_seconds[0];
    if (charOffset >= alignment.characters.length) {
        const last = alignment.character_end_times_seconds;
        return last[last.length - 1] ?? null;
    }

    return alignment.character_start_times_seconds[charOffset] ?? null;
};

// ── Energy analysis ──

const FRAME_SIZE_SEC = 0.01; // 10ms frames
const SILENCE_THRESHOLD_DB = -40;
const SEARCH_WINDOW_SEC = 0.15; // ±150ms search around boundary
const CROSSFADE_SEC = 0.08; // 80ms raised-cosine crossfade

const dbFromRms = (rms: number): number =>
    rms > 0 ? 20 * Math.log10(rms) : -Infinity;

/** Compute RMS energy for a frame starting at the given sample offset. */
const frameRms = (samples: Float32Array, start: number, frameLength: number): number => {
    const end = Math.min(start + frameLength, samples.length);
    if (end <= start) return 0;
    let sum = 0;
    for (let i = start; i < end; i++) {
        sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / (end - start));
};

type CutPoint = {
    timeSec: number;
    silent: boolean;
};

/**
 * Find the best cut point near `targetSec` by searching for silence or minimum energy.
 */
export const findCutPoint = (
    samples: Float32Array,
    sampleRate: number,
    targetSec: number,
): CutPoint => {
    const frameLength = Math.round(sampleRate * FRAME_SIZE_SEC);
    const searchFrames = Math.round(sampleRate * SEARCH_WINDOW_SEC / frameLength);
    const targetFrame = Math.round(targetSec * sampleRate / frameLength);

    const startFrame = Math.max(0, targetFrame - searchFrames);
    const endFrame = Math.min(
        Math.floor(samples.length / frameLength) - 1,
        targetFrame + searchFrames,
    );

    let minRms = Infinity;
    let minFrame = targetFrame;
    let foundSilent = false;

    for (let f = startFrame; f <= endFrame; f++) {
        const rms = frameRms(samples, f * frameLength, frameLength);
        const db = dbFromRms(rms);

        if (db < SILENCE_THRESHOLD_DB && !foundSilent) {
            foundSilent = true;
            minRms = rms;
            minFrame = f;
        } else if (foundSilent && db < SILENCE_THRESHOLD_DB) {
            // Prefer the center of a silent region (pick middle)
            if (rms <= minRms) {
                minRms = rms;
                minFrame = f;
            }
        } else if (!foundSilent && rms < minRms) {
            minRms = rms;
            minFrame = f;
        }
    }

    return {
        timeSec: (minFrame * frameLength) / sampleRate,
        silent: foundSilent,
    };
};

// ── Audio slicing ──

/** Apply a raised-cosine fade-out at the end of a Float32Array (in-place). */
const applyFadeOut = (samples: Float32Array, fadeSamples: number): void => {
    const start = Math.max(0, samples.length - fadeSamples);
    for (let i = start; i < samples.length; i++) {
        const t = (i - start) / fadeSamples;
        samples[i] *= 0.5 * (1 + Math.cos(Math.PI * t)); // raised cosine
    }
};

/** Apply a raised-cosine fade-in at the start of a Float32Array (in-place). */
const applyFadeIn = (samples: Float32Array, fadeSamples: number): void => {
    const end = Math.min(fadeSamples, samples.length);
    for (let i = 0; i < end; i++) {
        const t = i / fadeSamples;
        samples[i] *= 0.5 * (1 - Math.cos(Math.PI * t)); // raised cosine
    }
};

const sliceAudioBuffer = (
    source: AudioBuffer,
    startSec: number,
    endSec: number,
    audioContext: AudioContext,
    crossfade: { fadeIn: boolean; fadeOut: boolean },
): AudioBuffer => {
    const sampleRate = source.sampleRate;
    const startSample = Math.max(0, Math.round(startSec * sampleRate));
    const endSample = Math.min(source.length, Math.round(endSec * sampleRate));
    const length = Math.max(0, endSample - startSample);

    if (length === 0) {
        return audioContext.createBuffer(source.numberOfChannels, 1, sampleRate);
    }

    const buffer = audioContext.createBuffer(source.numberOfChannels, length, sampleRate);
    const fadeSamples = Math.round(CROSSFADE_SEC * sampleRate);

    for (let ch = 0; ch < source.numberOfChannels; ch++) {
        const sourceData = source.getChannelData(ch);
        const chunk = new Float32Array(length);
        chunk.set(sourceData.subarray(startSample, endSample));

        if (crossfade.fadeIn) applyFadeIn(chunk, fadeSamples);
        if (crossfade.fadeOut) applyFadeOut(chunk, fadeSamples);

        buffer.copyToChannel(chunk, ch);
    }

    return buffer;
};

// ── Main entry point ──

export const decodeAudioBase64 = async (
    b64: string,
    audioContext: AudioContext,
): Promise<AudioBuffer> => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (audioContext.state === 'suspended') await audioContext.resume();
    return audioContext.decodeAudioData(bytes.buffer.slice(0));
};

export const chunkVocalStream = async (
    response: TeacherStreamResponse,
    audioContext: AudioContext,
): Promise<VocalChunk[]> => {
    if (!response.audioBase64) return [];

    let fullAudio: AudioBuffer;
    try {
        fullAudio = await decodeAudioBase64(response.audioBase64, audioContext);
    } catch {
        return [];
    }

    const { anchors, alignment } = response;
    if (anchors.length === 0) return [];

    // Empty alignment → single JUDGE chunk from full audio
    const hasAlignment = alignment.characters.length > 0;

    if (!hasAlignment || anchors.length === 1) {
        return [{
            marker: anchors[0].marker,
            text: anchors[0].text,
            startSec: 0,
            endSec: fullAudio.duration,
            audioBuffer: fullAudio,
        }];
    }

    // Map anchor charOffsets to times
    const anchorTimes: Array<{ anchor: StreamAnchor; timeSec: number | null }> = anchors.map(
        (anchor) => ({
            anchor,
            timeSec: charOffsetToTime(anchor.charOffset, alignment),
        }),
    );

    // Filter out anchors with invalid times
    const validAnchors = anchorTimes.filter(
        (a): a is { anchor: StreamAnchor; timeSec: number } => a.timeSec !== null,
    );

    if (validAnchors.length === 0) {
        return [{
            marker: anchors[0].marker,
            text: anchors[0].text,
            startSec: 0,
            endSec: fullAudio.duration,
            audioBuffer: fullAudio,
        }];
    }

    // Mix down to mono for energy analysis
    const monoSamples = new Float32Array(fullAudio.length);
    for (let ch = 0; ch < fullAudio.numberOfChannels; ch++) {
        const channelData = fullAudio.getChannelData(ch);
        for (let i = 0; i < fullAudio.length; i++) {
            monoSamples[i] += channelData[i];
        }
    }
    if (fullAudio.numberOfChannels > 1) {
        const scale = 1 / fullAudio.numberOfChannels;
        for (let i = 0; i < monoSamples.length; i++) {
            monoSamples[i] *= scale;
        }
    }

    // Find cut points between adjacent anchors
    const cutPoints: number[] = [0]; // start of audio
    for (let i = 1; i < validAnchors.length; i++) {
        const boundaryTime = validAnchors[i].timeSec;
        const cut = findCutPoint(monoSamples, fullAudio.sampleRate, boundaryTime);
        cutPoints.push(cut.timeSec);
    }
    cutPoints.push(fullAudio.duration); // end of audio

    // Slice into chunks
    const chunks: VocalChunk[] = [];
    for (let i = 0; i < validAnchors.length; i++) {
        const startSec = cutPoints[i];
        const endSec = cutPoints[i + 1];

        if (endSec <= startSec) continue;

        const isFirst = i === 0;
        const isLast = i === validAnchors.length - 1;
        const needsCrossfade = !findCutPoint(
            monoSamples,
            fullAudio.sampleRate,
            isFirst ? endSec : startSec,
        ).silent;

        const audioBuffer = sliceAudioBuffer(
            fullAudio,
            startSec,
            endSec,
            audioContext,
            {
                fadeIn: !isFirst && needsCrossfade,
                fadeOut: !isLast && needsCrossfade,
            },
        );

        chunks.push({
            marker: validAnchors[i].anchor.marker,
            text: validAnchors[i].anchor.text,
            startSec,
            endSec,
            audioBuffer,
        });
    }

    return chunks;
};
