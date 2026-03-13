// Thin re-export layer — all logic lives in services/, cues/, pipeline/, and matcher.
// Consumers (Dialog.tsx, midi.ts) can import from here without changes.

import { MidiFile } from "midifile-ts";
import { MPM } from "mpm-ts";
import { MSM } from "mpmify";
import type { Range } from "./mpm";
import { implantLocal } from "./matcher";
import { buildTimingMap, type TimingMapPoint } from "./teacherCues";
import { perform, warmPerformEndpoint } from "./services/mpmRenderer";
import { assertOk } from "./services/api";

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
