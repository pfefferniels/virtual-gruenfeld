// Thin re-export layer — all logic lives in services/, cues/, pipeline/, and matcher.
// Consumers (Dialog.tsx, midi.ts) can import from here without changes.

import { MidiFile } from "midifile-ts";
import { exportMPM, MPM } from "mpm-ts";
import type { Range } from "./mpm";
import { implantLocal } from "./matcher";
import { isImplanted, type MeasuredNote } from "./score/measured";
import { buildTimingMap, type TimingMapPoint } from "./teacherCues";
import { perform } from "./services/mpmRenderer";

export const implant = (
    scoreNotes: readonly MeasuredNote[],
    midi: MidiFile,
    log: (msg: string) => void,
    dateHint?: number,
): Promise<{ notes: MeasuredNote[]; range: Range }> => {
    if (dateHint != null) {
        log(`IMPLANT: using date_hint=${dateHint}`);
    }
    log(`IMPLANT: matching ${scoreNotes.length} ref notes against student MIDI…`);

    const { notes, range } = implantLocal(scoreNotes, midi, dateHint);

    log(`IMPLANT: range=[${range.from}, ${range.to}], notes: ${notes.length}, implanted: ${notes.filter(isImplanted).length}`);
    return Promise.resolve({ notes, range });
};

type RenderedTeacherPerformance = {
    midi: MidiFile;
    timingMap: TimingMapPoint[];
};

/**
 * Render `mpm` over `range` and align it to the reference, for the cues. Renders in
 * process (espressivo), so this blocks for the render — ~50 ms for a couple of bars.
 */
export const performTeacherPlayback = (
    mei: string,
    referenceNotes: readonly MeasuredNote[],
    mpm: MPM,
    range: Range,
): RenderedTeacherPerformance | undefined => {
    const midi = perform(mei, exportMPM(mpm), range);
    if (!midi) return undefined;

    return {
        midi,
        timingMap: buildTimingMap(referenceNotes, midi, range),
    };
};
