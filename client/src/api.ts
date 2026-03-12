// Thin re-export layer — all logic lives in services/, cues/, and matcher.
// Consumers (Dialog.tsx, midi.ts) can import from here without changes.

import { MidiFile } from "midifile-ts";
import { MPM } from "mpm-ts";
import { MSM } from "mpmify";
import type { Range } from "./mpm";
import { implantLocal } from "./matcher";
import { buildTimingMap, type TimingMapPoint } from "./teacherCues";
import { renderJudgementAudioBuffer } from "./cues/render";
import { perform, warmPerformEndpoint } from "./services/mpmRenderer";
import { assertOk, fetchJudgement } from "./services/api";
import type { ImmediateJudgementPayload } from "./judgement";

// Re-exports from cues/
export { prepareTeacherCues, type PreparedTeacherCue } from "./cues/prepare";
export { resolveTeacherCues, requestTeacherCuePlan } from "./cues/planning";

// Re-exports from services/
export { assertOk, warmPerformEndpoint };

export const implant = (
    msm: MSM,
    midi: MidiFile,
    log: (msg: string) => void,
    dateHint?: number,
): Promise<{ studentMsm: MSM; range: Range }> => {
    if (dateHint != null) {
        log(`IMPLANT: using date_hint=${dateHint}`);
    }
    log(`IMPLANT: matching ${msm.allNotes?.length ?? 0} ref notes against student MIDI…`);

    const { studentMsm, range } = implantLocal(msm, midi, dateHint);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    log(`IMPLANT: range=[${range.from}, ${range.to}], notes: ${studentMsm.allNotes.length}, implanted: ${studentMsm.allNotes.filter((n: any) => n.source === 'implanted').length}`);
    return Promise.resolve({ studentMsm, range });
};

type RenderedTeacherPerformance = {
    midi: MidiFile;
    timingMap: TimingMapPoint[];
};

export const performTeacherPlayback = async (
    mei: string,
    referenceMsm: MSM,
    mpm: MPM,
    range: Range,
    opts?: { sketchiness?: number },
): Promise<RenderedTeacherPerformance | undefined> => {
    const midi = await perform(mei, mpm, range, opts);
    if (!midi) return undefined;

    return {
        midi,
        timingMap: buildTimingMap(referenceMsm, midi, range),
    };
};

export const requestImmediateJudgement = async (
    summary: ImmediateJudgementPayload,
    log: (msg: string) => void,
): Promise<string> => {
    const text = await fetchJudgement(summary);
    log(`JUDGE: text="${text}"`);
    return text;
};

export const requestSpokenJudgement = async (
    text: string,
    audioContext: AudioContext,
    log: (msg: string) => void,
): Promise<AudioBuffer | null> => {
    const startedAt = Date.now();
    const buffer = await renderJudgementAudioBuffer(text, audioContext);
    log(`JUDGE audio: render_ms=${Date.now() - startedAt} text="${text}" ready=${buffer ? 1 : 0}`);
    return buffer;
};
