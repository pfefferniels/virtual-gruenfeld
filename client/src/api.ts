import { MidiFile } from "midifile-ts";
import type { Range } from "./mpm";
import { implantLocal } from "./matcher";
import { isImplanted, type MeasuredNote } from "./score/measured";

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
