/**
 * MEI → MSM conversion and MPM → expressive MIDI, in-process via espressivo.
 *
 * These used to be two HTTP calls to the Java meico server (`/convert` and `/perform`,
 * port 8080). espressivo is a TypeScript port of meico, verified byte for byte against
 * it, so the same pipeline now runs wherever this module is imported: in the browser,
 * and in the Node scripts (`generate_test.ts`, `visualize_implant.ts`, `test_pipeline.ts`).
 * The MPM crosses this boundary as text, as it crosses every boundary in the client.
 *
 * `render` reproduces, step for step, what `PerformService.perform` in mpm-renderer did
 * for this client's requests (`mei`, `mpm`, `from`, `to` and nothing else):
 *
 *   MEI → MSM (ppq 720, rests removed) → apply performance 0 →
 *   drop every dated element outside [from, to) → shift `milliseconds.date` so the
 *   first note starts at 0 → every part on MIDI channel 0 → strip `<section>` →
 *   expressive MIDI.
 */
import { read, type MidiFile } from 'midifile-ts';
import {
    Attribute,
    Mei,
    Mei2MsmConverter,
    Mpm,
    allChildElements,
    getAllDescendantsByName,
    getAllDescendantsWithAttribute,
    parentElement,
    type Element,
    type Msm,
} from 'espressivo';
import type { Range } from '../mpm/types';

/** The tick grid every date in this project speaks — the fit, the diff and the matcher all assume it. */
const PPQ = 720;

const conversions = new Map<string, Msm>();

/**
 * MEI → the MSM of its first movement, rests removed — what the Java `/convert` returned.
 *
 * Memoized on the MEI text: the score is converted once at boot and every later render
 * reuses the document. That is safe because `Performance.perform` works on a clone and
 * never touches its input.
 */
const toMsm = (mei: string): Msm => {
    const cached = conversions.get(mei);
    if (cached) return cached;

    const document = Mei.fromXml(mei);
    if (document.isEmpty()) throw new Error('MEI: not a well-formed document');
    const [msm] = new Mei2MsmConverter(PPQ).convert(document);
    if (!msm) throw new Error('MEI: no convertible movement');
    removeAllNamed(msm, 'rest');

    conversions.set(mei, msm);
    return msm;
};

/**
 * MEI → MSM as XML text: the score every take is measured against (`mpm/compare.ts`'s metric,
 * `student/fit.ts`'s beat grid), and what `score/measured.ts` reads the reduction's notes from.
 */
export const convert = (mei: string): string => toMsm(mei).toXML();

const numberAttribute = (name: string, el: Element): number | null => {
    const value = el.getAttributeValue(name);
    return value === null ? null : Number(value);
};

/**
 * Drop every `<name>` element in the document. What `XmlBase.removeAllElements` does, but
 * walking the tree instead of running an XPath query: on a performed MSM — thousands of
 * sampled pedal positions and volume points — the query costs seconds, the walk milliseconds.
 */
const removeAllNamed = (msm: Msm, name: string): void => {
    const root = msm.getRootElement();
    if (!root) return;
    for (const el of getAllDescendantsByName(name, root) ?? []) parentElement(el)?.removeChild(el);
};

/**
 * Keep only the dated elements inside [from, to) — notes, but also every map entry
 * (tempo, pedal positions, channel volume…) — so the render holds nothing but the passage.
 * Mirrors `PerformService.filterNotesByDate`. (The Java version also clamped each
 * `<section date.end>` to `to`; pointless, since the sections are stripped before export.)
 */
const cutToRange = (msm: Msm, { from, to }: Range): void => {
    const root = msm.getRootElement();
    if (!root) return;

    for (const el of getAllDescendantsWithAttribute('date', root) ?? []) {
        if (el.getLocalName() === 'section') continue;
        const date = numberAttribute('date', el);
        if (date === null || Number.isNaN(date)) continue;
        if (date < from || date >= to) parentElement(el)?.removeChild(el);
    }
};

/**
 * Shift every `milliseconds.date` (and `.end`) so the earliest remaining note starts at
 * 0 ms; whatever came earlier — a pedal position, a volume ramp — is clamped to 0.
 * Mirrors `PerformService.shiftOnsetsToFirstNote`.
 */
const startAtFirstNote = (msm: Msm): void => {
    const root = msm.getRootElement();
    if (!root) return;

    const onsets = (getAllDescendantsByName('note', root) ?? [])
        .map((note) => numberAttribute('milliseconds.date', note))
        .filter((ms): ms is number => ms !== null);
    if (onsets.length === 0) return;
    const first = Math.min(...onsets);
    if (!Number.isFinite(first) || first === 0) return;

    for (const el of getAllDescendantsWithAttribute('milliseconds.date', root) ?? []) {
        for (const name of ['milliseconds.date', 'milliseconds.date.end']) {
            const value = numberAttribute(name, el);
            if (value === null) continue;
            el.addAttribute(new Attribute(name, String(Math.max(0, value - first))));
        }
    }
};

/**
 * Render the passage [from, to) of `mei` as performed by the first performance in `mpm`
 * (XML text: the reference as fetched, or what `mpm/counter.ts` and `pipeline/judgementMood.ts`
 * wrote), to Standard MIDI File bytes. The first note
 * starts at 0 ms and everything plays on channel 0.
 */
export const render = (mei: string, mpm: string, range: Range): Uint8Array | undefined => {
    const document = new Mpm(mpm);
    if (document.isEmpty()) throw new Error('MPM: not a well-formed document');
    const performance = document.getPerformance(0);
    if (!performance) throw new Error('MPM: no performance to apply');

    const performed = performance.perform(toMsm(mei));
    cutToRange(performed, range);
    startAtFirstNote(performed);

    // Yamaha Disklavier expects MIDI channel 0 and ignores other channels.
    const root = performed.getRootElement();
    for (const part of root ? allChildElements(root, 'part') : []) {
        part.addAttribute(new Attribute('midi.channel', '0'));
    }
    removeAllNamed(performed, 'section');

    return performed.exportExpressiveMidi()?.exportMidi();
};

/** `render`, parsed — what the playback and cue scheduling consume. */
export const perform = (mei: string, mpm: string, range: Range): MidiFile | undefined => {
    const bytes = render(mei, mpm, range);
    return bytes && read(bytes);
};
