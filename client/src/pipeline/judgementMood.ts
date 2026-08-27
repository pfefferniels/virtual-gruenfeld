/**
 * The mood chord: a slow arpeggio under the spoken judgement, so the teacher is not talking
 * into silence.
 *
 * Five things are derived, and all five come from Grünfeld (semantics 32):
 *
 * | what | from | rule |
 * |---|---|---|
 * | the chord | `harmonic_reduction.mei` | the latest chord at or before the passage's start |
 * | the roll | the reference's nearest `<ornament>` | exact date first, then ±720 ticks, largest `@scale` on a tie; its def is copied and **slowed** to `clamp((n−1)·300 ms, 700, 1800)` |
 * | the level | the reference's prevailing `<dynamics>` | `@transition.to` before `@volume`, default 72, × 0.35 |
 * | the pulse | nothing | a fixed 30 bpm at `@beatLength` 0.25 — the mood chord does not borrow the passage's tempo |
 * | the pedal | the narration | down at `renderFrom`, up no earlier than the arpeggio's end + 1400 ms **or** the length of what the teacher is saying |
 *
 * Nothing is taken from the student. The port to espressivo's writing surface changed the
 * document in one way and the sound in none: four attributes the old builder copied onto the
 * `<ornament>` element — `@intensity`, `@transition.from`, `@transition.to`, `@noteoff.shift` —
 * are gone, because the renderer reads none of them off an instruction
 * (`OrnamentationMap.readOrnament` answers `scale`, `name.ref`, `note.order`, `noteid` and
 * nothing else). Each already had its rendering twin on the `<ornamentDef>`, which is copied as
 * it always was.
 */
import {
    DYNAMICS_MAP,
    DynamicsMap,
    FrameDomain,
    MovementMap,
    Mpm,
    NoteOffShift,
    ORNAMENTATION_MAP,
    ORNAMENTATION_STYLE,
    OrnamentDef,
    OrnamentationMap,
    Performance,
    Style,
    TempoMap,
    allChildElements,
    isOk,
    type AnyResult,
    type AnyStyle,
    type Element,
    type Normalized,
    type OkOf,
} from 'espressivo';
import type { MeasuredNote } from '../score/measured';
import { PPQ } from '../shared/constants';

const FIXED_JUDGEMENT_BPM = 30;
const FIXED_BEAT_LENGTH = 0.25;
const ORNAMENT_LOOKAHEAD_TICKS = 720;
const PEDAL_RAMP_TICKS = 1;
const ARPEGGIO_STEP_MS = 300;
const MIN_ARPEGGIO_SPAN_MS = 700;
const MAX_ARPEGGIO_SPAN_MS = 1800;
const POST_ARPEGGIO_HOLD_MS = 1400;
const MOOD_STYLE_NAME = 'performance_style';
const DEFAULT_MOOD_ORNAMENT = 'judgement_mood_default_ornament';

type JudgementMoodChord = {
    date: number;
    notes: MeasuredNote[];
    nextDate: number | null;
};

type SpreadWindow = {
    start: number;
    end: number;
};

/** The reference's ornament, as this module needs to see it: raw attributes, nothing defaulted. */
type MoodOrnament = {
    readonly date: number;
    readonly scale: number | null;
    readonly nameRef: string | null;
    readonly noteOrder: string | null;
    readonly frameStart: number | null;
    readonly frameLength: number | null;
};

/** The `<temporalSpread>`/`<dynamicsGradient>` of the def that ornament names. */
type MoodOrnamentDef = {
    readonly name: string;
    readonly frameStart: number | null;
    readonly frameLength: number | null;
    readonly timeUnit: string | null;
    readonly noteOffShift: string | null;
    readonly gradient: { readonly from: number; readonly to: number } | null;
};

type JudgementMoodRenderPlan = {
    /** The mood chord as MPM text — what `performTeacherPlayback` renders. */
    mpm: string;
    range: { from: number; to: number };
    chordDate: number;
    renderFrom: number;
    renderTo: number;
    noteOrder: string;
    noteCount: number;
};

type JudgementMoodOptions = {
    minimumPedalHoldMs?: number;
};

const clampMidi = (value: number, fallback: number): number => {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(1, Math.min(127, Math.round(value)));
};

const judgementMoodMillisecondsToTicks = (ms: number): number =>
    Math.round((ms / 1000) * (FIXED_JUDGEMENT_BPM / 60) * (FIXED_BEAT_LENGTH * 4) * PPQ);

const numberAttribute = (element: Element, name: string): number | null => {
    const raw = element.getAttributeValue(name);
    if (raw === null || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
};

const byDateThenPitch = (a: MeasuredNote, b: MeasuredNote): number =>
    a.date - b.date || a['midi.pitch'] - b['midi.pitch'];

const pickReductionChord = (
    reductionNotes: readonly MeasuredNote[],
    targetDate: number,
): JudgementMoodChord | null => {
    const grouped = new Map<number, MeasuredNote[]>();

    for (const note of reductionNotes) {
        if (typeof note.date !== 'number' || typeof note['midi.pitch'] !== 'number') continue;
        const group = grouped.get(note.date) ?? [];
        group.push(note);
        grouped.set(note.date, group);
    }

    const dates = Array.from(grouped.keys()).sort((a, b) => a - b);
    if (dates.length === 0) return null;

    const chosenDate = dates
        .filter((date) => date <= targetDate)
        .sort((a, b) => b - a)[0]
        ?? dates[0];
    const nextDate = dates.find((date) => date > chosenDate) ?? null;
    const notes = (grouped.get(chosenDate) ?? [])
        .slice()
        .sort(byDateThenPitch);

    return notes.length > 0 ? { date: chosenDate, notes, nextDate } : null;
};

/** Every element of one of the reference's maps, in document order. */
const mapElements = (mpm: Mpm, mapName: string, elementName: string): Element[] => {
    const map = mpm.getPerformance(0)?.getGlobal()?.getDated()?.getMap(mapName) ?? null;
    if (!map) return [];
    const elements: Element[] = [];
    for (let index = 0; index < map.size(); index++) {
        const element = map.getElement(index);
        if (element && element.getLocalName() === elementName) elements.push(element);
    }
    return elements;
};

const readOrnaments = (mpm: Mpm): MoodOrnament[] =>
    mapElements(mpm, ORNAMENTATION_MAP, 'ornament')
        .map((element) => ({
            date: numberAttribute(element, 'date'),
            scale: numberAttribute(element, 'scale'),
            nameRef: element.getAttributeValue('name.ref'),
            noteOrder: element.getAttributeValue('note.order'),
            frameStart: numberAttribute(element, 'frame.start'),
            frameLength: numberAttribute(element, 'frameLength'),
        }))
        .filter((ornament): ornament is MoodOrnament => ornament.date !== null);

const pickMoodOrnament = (
    ornaments: readonly MoodOrnament[],
    targetDate: number,
): MoodOrnament | null => {
    const exact = ornaments
        .filter((ornament) => ornament.date === targetDate)
        .sort((a, b) => (b.scale ?? 1) - (a.scale ?? 1));
    if (exact.length > 0) return exact[0];

    const upcoming = ornaments
        .filter((ornament) => ornament.date > targetDate && ornament.date <= targetDate + ORNAMENT_LOOKAHEAD_TICKS)
        .sort((a, b) => a.date - b.date);
    if (upcoming.length > 0) return upcoming[0];

    const previous = ornaments
        .filter((ornament) => ornament.date < targetDate && ornament.date >= targetDate - ORNAMENT_LOOKAHEAD_TICKS)
        .sort((a, b) => b.date - a.date);
    return previous[0] ?? null;
};

/** The `<ornamentDef>` of that name, wherever in the reference's ornamentation styles it sits. */
const readOrnamentDef = (mpm: Mpm, name: string | null): MoodOrnamentDef | null => {
    if (name === null) return null;
    const header = mpm.getPerformance(0)?.getGlobal()?.getHeader() ?? null;
    for (const style of header?.getAllStyleDefs(ORNAMENTATION_STYLE)?.values() ?? []) {
        const def = style.getDef(name)?.getXmlOrNull() ?? null;
        if (!def) continue;
        const spread = allChildElements(def, 'temporalSpread')[0] ?? null;
        const gradient = allChildElements(def, 'dynamicsGradient')[0] ?? null;
        return {
            name,
            frameStart: spread ? numberAttribute(spread, 'frame.start') : null,
            frameLength: spread ? numberAttribute(spread, 'frameLength') : null,
            timeUnit: spread?.getAttributeValue('time.unit') ?? null,
            noteOffShift: spread?.getAttributeValue('noteoff.shift') ?? null,
            gradient: gradient
                ? {
                    from: numberAttribute(gradient, 'transition.from') ?? 0,
                    to: numberAttribute(gradient, 'transition.to') ?? 0,
                }
                : null,
        };
    }
    return null;
};

const MOOD_DYNAMICS_SCALE = 0.35;

const resolveMoodDynamics = (mpm: Mpm, targetDate: number): number => {
    const effective = mapElements(mpm, DYNAMICS_MAP, 'dynamics')
        .map((element) => ({
            date: numberAttribute(element, 'date') ?? 0,
            transitionTo: numberAttribute(element, 'transition.to'),
            volume: numberAttribute(element, 'volume'),
        }))
        .filter((dynamics) => dynamics.date <= targetDate)
        .sort((a, b) => b.date - a.date)[0] ?? null;
    const base = effective ? (effective.transitionTo ?? effective.volume ?? 72) : 72;
    return clampMidi(Math.round(base * MOOD_DYNAMICS_SCALE), 25);
};

const buildPitchById = (notes: readonly MeasuredNote[]): Map<string, number> => {
    const byId = new Map<string, number>();
    for (const note of notes) {
        const id = typeof note['xml:id'] === 'string' ? note['xml:id'] : null;
        const pitch = typeof note['midi.pitch'] === 'number' ? note['midi.pitch'] : null;
        if (id && pitch != null) byId.set(id, pitch);
    }
    return byId;
};

const buildReductionOrder = (
    chordNotes: MeasuredNote[],
    orderText: string | null,
    fullScorePitchById: Map<string, number>,
): string => {
    const ascending = chordNotes
        .slice()
        .sort((a, b) => a['midi.pitch'] - b['midi.pitch'])
        .map((note) => `#${note['xml:id']}`);

    if (!orderText) return ascending.join(' ');

    const normalized = orderText.trim().toLowerCase();
    if (normalized === 'descending pitch') {
        return ascending.slice().reverse().join(' ');
    }
    if (normalized === 'ascending pitch') {
        return ascending.join(' ');
    }

    const sourcePitches = orderText
        .trim()
        .split(/\s+/)
        .map((token) => token.replace(/^#/, ''))
        .map((id) => fullScorePitchById.get(id))
        .filter((pitch): pitch is number => typeof pitch === 'number');

    if (sourcePitches.length < 2) return ascending.join(' ');

    const ranked = sourcePitches
        .map((pitch, index) => ({ pitch, index }))
        .sort((a, b) => a.pitch - b.pitch || a.index - b.index);
    const rankByIndex = new Map<number, number>();
    ranked.forEach((item, rank) => rankByIndex.set(item.index, rank));

    const mapped: string[] = [];
    const used = new Set<string>();
    for (let i = 0; i < sourcePitches.length; i++) {
        const rank = rankByIndex.get(i) ?? i;
        const noteIndex = ascending.length === 1
            ? 0
            : Math.round(rank * (ascending.length - 1) / Math.max(1, sourcePitches.length - 1));
        const noteId = ascending[noteIndex];
        if (used.has(noteId)) continue;
        used.add(noteId);
        mapped.push(noteId);
    }

    for (const noteId of ascending) {
        if (!used.has(noteId)) mapped.push(noteId);
    }
    return mapped.join(' ');
};

const arpeggioSpanMs = (noteCount: number): number =>
    Math.max(
        MIN_ARPEGGIO_SPAN_MS,
        Math.min(MAX_ARPEGGIO_SPAN_MS, Math.max(1, noteCount - 1) * ARPEGGIO_STEP_MS),
    );

/** The source def slowed to the mood chord's own pace, in milliseconds, starting on the beat. */
const slowMoodDef = (source: MoodOrnamentDef | null, noteCount: number): MoodOrnamentDef => ({
    name: source?.name ?? DEFAULT_MOOD_ORNAMENT,
    frameStart: 0,
    frameLength: arpeggioSpanMs(noteCount),
    timeUnit: 'milliseconds',
    noteOffShift: source?.noteOffShift ?? 'false',
    gradient: source?.gradient ?? { from: 0, to: 0 },
});

const estimateSpreadWindow = (
    def: MoodOrnamentDef,
    ornament: MoodOrnament | null,
): SpreadWindow => {
    const sourceStart = ornament?.frameStart ?? def.frameStart ?? 0;
    const sourceLength = ornament?.frameLength ?? def.frameLength ?? 0;
    if (def.timeUnit === 'milliseconds') {
        const startTicks = judgementMoodMillisecondsToTicks(sourceStart);
        const lengthTicks = judgementMoodMillisecondsToTicks(sourceLength);
        return {
            start: startTicks,
            end: startTicks + Math.max(0, lengthTicks),
        };
    }

    const instructionScale = Math.max(1, ornament?.scale ?? 1);
    const start = sourceStart * instructionScale;
    const length = Math.max(0, sourceLength * instructionScale);
    return {
        start,
        end: start + length,
    };
};

const noteOffShiftOf = (value: string | null): NoteOffShift => {
    switch (value) {
        case 'true': return NoteOffShift.True;
        case 'monophonic': return NoteOffShift.Monophonic;
        default: return NoteOffShift.False;
    }
};

const unwrap = <R extends AnyResult>(result: R, what: string): OkOf<R> => {
    if (!isOk(result)) throw new Error(`judgement mood: ${what} could not be created`);
    return result.value as OkOf<R>;
};

/**
 * The mood chord's own MPM: one tempo, one dynamics, one ornament over one def, and a
 * four-`<movement>` pedal envelope.
 */
const writeMoodMpm = (
    def: MoodOrnamentDef,
    dynamicsVolume: number,
    chordDate: number,
    renderFrom: number,
    noteOrder: string,
    pedalDownDate: number,
    pedalUpDate: number,
): string => {
    const mpm = Mpm.createMpm();
    const performance = unwrap(Performance.fromName('judgement_mood', PPQ), 'the performance');
    mpm.addPerformance(performance);

    const global = performance.getGlobal();
    const dated = global?.getDated() ?? null;
    const header = global?.getHeader() ?? null;
    if (!dated || !header) throw new Error('judgement mood: the performance has no <dated>/<header>');

    const style = Style.create('ornamentation', MOOD_STYLE_NAME, 'judgement_mood_ornament_styledef');
    const ornamentDef = unwrap(OrnamentDef.createOrnamentDef(def.name), `ornamentDef ${def.name}`);
    ornamentDef.setTemporalSpreadValues(
        def.frameStart ?? 0,
        def.frameLength ?? 0,
        FrameDomain.Milliseconds,
        1.0,
        noteOffShiftOf(def.noteOffShift),
    );
    if (def.gradient) ornamentDef.setDynamicsGradientValues(def.gradient.from, def.gradient.to);
    style.addDef(ornamentDef);
    header.addStyleDef(ORNAMENTATION_STYLE, style as unknown as AnyStyle);

    const tempoMap = TempoMap.createTempoMap();
    tempoMap.addTempo({
        date: renderFrom,
        bpm: FIXED_JUDGEMENT_BPM,
        beatLength: FIXED_BEAT_LENGTH,
        id: 'judgement_mood_tempo',
    });

    const dynamicsMap = DynamicsMap.createDynamicsMap();
    dynamicsMap.addDynamics({
        date: renderFrom,
        volume: dynamicsVolume,
        id: 'judgement_mood_dynamics',
    });

    const ornamentMap = OrnamentationMap.createOrnamentationMap();
    ornamentMap.addStyleSwitch(renderFrom, MOOD_STYLE_NAME, 'judgement_mood_ornament_style');
    ornamentMap.addOrnamentV3({
        date: chordDate,
        nameRef: def.name,
        scale: 1,
        noteOrder,
        id: 'judgement_mood_ornament',
    });

    // Down, held, released, up — the four positions `prepareMoodChordMidi` then ramps.
    const movementMap = MovementMap.createMovementMap();
    for (const movement of [
        { date: pedalDownDate, position: 0, transitionTo: 1, id: 'judgement_mood_pedal_down' },
        { date: pedalDownDate + PEDAL_RAMP_TICKS, position: 1, id: 'judgement_mood_pedal_down_done' },
        { date: pedalUpDate, position: 1, transitionTo: 0, id: 'judgement_mood_pedal_up' },
        { date: pedalUpDate + PEDAL_RAMP_TICKS, position: 0, id: 'judgement_mood_pedal_up_done' },
    ]) {
        movementMap.addMovement({
            date: movement.date,
            // `Normalized` is a branded number the library mints at its own parse boundaries;
            // these four are literals from the spec's 0..1 domain, so the brand is asserted here.
            position: movement.position as Normalized,
            ...(movement.transitionTo === undefined ? {} : { transitionTo: movement.transitionTo as Normalized }),
            controller: 'sustain',
            id: movement.id,
        });
    }

    for (const map of [tempoMap, dynamicsMap, ornamentMap, movementMap]) dated.addMap(map);

    const text = mpm.writeMpm();
    if (text === null) throw new Error('judgement mood: the document could not be written');
    return text;
};

export const buildJudgementMoodRenderPlan = (
    reductionNotes: readonly MeasuredNote[],
    scoreNotes: readonly MeasuredNote[],
    referenceMpmText: string,
    targetDate: number,
    options: JudgementMoodOptions = {},
): JudgementMoodRenderPlan | null => {
    const chord = pickReductionChord(reductionNotes, targetDate);
    if (!chord) return null;

    const reference = new Mpm(referenceMpmText);
    const ornament = reference.isEmpty() ? null : pickMoodOrnament(readOrnaments(reference), targetDate);
    const sourceDef = reference.isEmpty() ? null : readOrnamentDef(reference, ornament?.nameRef ?? null);
    const effectiveDef = slowMoodDef(sourceDef, chord.notes.length);
    const reductionOrder = buildReductionOrder(chord.notes, ornament?.noteOrder ?? null, buildPitchById(scoreNotes));
    const spread = estimateSpreadWindow(effectiveDef, ornament);

    const renderFrom = Math.max(0, chord.date - PEDAL_RAMP_TICKS);
    const earliestPedalDown = renderFrom;
    const minimumPedalReleaseDate = renderFrom + judgementMoodMillisecondsToTicks(
        Math.max(0, options.minimumPedalHoldMs ?? 0),
    );
    const minReleaseDate = Math.max(
        chord.date + Math.ceil(Math.max(0, spread.end)) + judgementMoodMillisecondsToTicks(POST_ARPEGGIO_HOLD_MS),
        minimumPedalReleaseDate,
        earliestPedalDown + PEDAL_RAMP_TICKS * 2 + 1,
    );
    const constrainedReleaseDate = options.minimumPedalHoldMs != null
        ? minReleaseDate
        : chord.nextDate != null
        ? Math.min(minReleaseDate, chord.nextDate - (PEDAL_RAMP_TICKS * 2 + 1))
        : minReleaseDate;
    const pedalReleaseDate = Math.max(
        earliestPedalDown + PEDAL_RAMP_TICKS * 2 + 1,
        constrainedReleaseDate,
    );
    const renderTo = pedalReleaseDate + PEDAL_RAMP_TICKS + 1;

    const mpm = writeMoodMpm(
        effectiveDef,
        reference.isEmpty() ? clampMidi(Math.round(72 * MOOD_DYNAMICS_SCALE), 25) : resolveMoodDynamics(reference, targetDate),
        chord.date,
        renderFrom,
        reductionOrder,
        earliestPedalDown,
        pedalReleaseDate,
    );

    return {
        mpm,
        range: { from: renderFrom, to: renderTo },
        chordDate: chord.date,
        renderFrom,
        renderTo,
        noteOrder: reductionOrder,
        noteCount: chord.notes.length,
    };
};
