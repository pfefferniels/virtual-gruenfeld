import type { CuePrepMode } from "../cueLibrary";
import type { TeacherCue } from "../teacherCues";
import { fetchRenderCues, fetchRenderJudgement, type RenderCueStats } from "../services/api";

const decodeAudioBase64 = async (
    b64: string,
    audioContext: AudioContext,
): Promise<AudioBuffer> => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (audioContext.state === 'suspended') await audioContext.resume();
    return audioContext.decodeAudioData(bytes.buffer.slice(0));
};

export const renderJudgementAudioBuffer = async (
    text: string,
    audioContext: AudioContext,
): Promise<AudioBuffer | null> => {
    const audio_b64 = await fetchRenderJudgement(text);
    if (!audio_b64) return null;
    return decodeAudioBase64(audio_b64, audioContext);
};

export const renderCueAudioBuffers = async (
    cues: Array<Pick<TeacherCue, 'id' | 'text'>>,
    audioContext: AudioContext,
    mode: CuePrepMode,
    libraryOnly: boolean,
    log?: (msg: string) => void,
): Promise<{ buffers: Map<string, AudioBuffer>; stats: RenderCueStats | null }> => {
    if (cues.length === 0) {
        return { buffers: new Map(), stats: null };
    }

    const { rendered, stats } = await fetchRenderCues(cues, mode, libraryOnly);

    const renderedById = new Map<string, string>();
    for (const cue of rendered) {
        renderedById.set(cue.id, cue.audio_b64);
    }

    const decoded = new Map<string, AudioBuffer>();
    for (const cue of cues) {
        const b64 = renderedById.get(cue.id);
        if (!b64) continue;
        decoded.set(cue.id, await decodeAudioBase64(b64, audioContext));
    }
    if (stats && log) {
        log(
            `CUE audio: mode=${stats.mode} requested=${stats.requested} returned=${stats.returned} ` +
            `library_hits=${stats.library_hits} library_misses=${stats.library_misses} ` +
            `synthesized=${stats.synthesized} cue_audio_ms=${stats.render_cues_ms}`,
        );
    }
    return { buffers: decoded, stats };
};
