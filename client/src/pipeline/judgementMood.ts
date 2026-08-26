import { MPM, type Dynamics, type Movement, type Ornament, type Tempo, type Style, type OrnamentDef, type Scope, type AnyInstruction } from 'mpm-ts';
import type { MeasuredNote } from '../score/measured';

const FIXED_JUDGEMENT_BPM = 30;
const FIXED_BEAT_LENGTH = 0.25;
const ORNAMENT_LOOKAHEAD_TICKS = 720;
const PEDAL_RAMP_TICKS = 1;
const ARPEGGIO_STEP_MS = 300;
const MIN_ARPEGGIO_SPAN_MS = 700;
const MAX_ARPEGGIO_SPAN_MS = 1800;
const POST_ARPEGGIO_HOLD_MS = 1400;

type JudgementMoodChord = {
    date: number;
    notes: MeasuredNote[];
    nextDate: number | null;
};

type SpreadWindow = {
    start: number;
    end: number;
};

type JudgementMoodRenderPlan = {
    mpm: MPM;
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

const clonePlain = <T,>(value: T): T =>
    JSON.parse(JSON.stringify(value)) as T;

const clampMidi = (value: number, fallback: number): number => {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(1, Math.min(127, Math.round(value)));
};

const judgementMoodMillisecondsToTicks = (ms: number): number =>
    Math.round((ms / 1000) * (FIXED_JUDGEMENT_BPM / 60) * (FIXED_BEAT_LENGTH * 4) * 720);

const numericValue = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
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

const pickMoodOrnament = (
    referenceMpm: MPM,
    targetDate: number,
): Ornament | null => {
    const ornaments = referenceMpm.getInstructions<Ornament>('ornament');
    const exact = ornaments
        .filter((ornament) => ornament.date === targetDate)
        .sort((a, b) => (numericValue(b.scale) ?? 1) - (numericValue(a.scale) ?? 1));
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

const findEffectiveInstruction = <T extends AnyInstruction>(
    items: T[],
    targetDate: number,
): T | null =>
    items
        .filter((item) => item.date <= targetDate)
        .sort((a, b) => b.date - a.date)[0] ?? null;

const MOOD_DYNAMICS_SCALE = 0.35;

const resolveMoodDynamics = (
    referenceMpm: MPM,
    targetDate: number,
): number => {
    const effective = findEffectiveInstruction(referenceMpm.getInstructions<Dynamics>('dynamics'), targetDate);
    const base = effective
        ? (numericValue(effective['transition.to']) ?? numericValue(effective.volume) ?? 72)
        : 72;
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
    orderText: string | undefined,
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

const buildSlowMoodOrnamentDef = (
    sourceDef: OrnamentDef | null,
    noteCount: number,
): OrnamentDef => ({
    type: 'ornamentDef',
    name: sourceDef?.name ?? 'judgement_mood_default_ornament',
    temporalSpread: {
        type: 'temporalSpread',
        'frame.start': 0,
        frameLength: arpeggioSpanMs(noteCount),
        'time.unit': 'milliseconds',
        'noteoff.shift': sourceDef?.temporalSpread?.['noteoff.shift'] ?? false,
    },
    dynamicsGradient: sourceDef?.dynamicsGradient
        ? {
            type: 'dynamicsGradient',
            'transition.from': sourceDef.dynamicsGradient['transition.from'],
            'transition.to': sourceDef.dynamicsGradient['transition.to'],
        }
        : {
            type: 'dynamicsGradient',
            'transition.from': 0,
            'transition.to': 0,
        },
});

const estimateSpreadWindow = (
    ornamentDef: OrnamentDef,
    ornament: Ornament | null,
): SpreadWindow => {
    const spread = ornamentDef.temporalSpread;
    if (!spread) return { start: 0, end: 0 };

    const sourceStart = numericValue(ornament?.['frame.start']) ?? spread['frame.start'] ?? 0;
    const sourceLength = numericValue(ornament?.frameLength) ?? spread.frameLength ?? 0;
    if (spread['time.unit'] === 'milliseconds') {
        const startTicks = judgementMoodMillisecondsToTicks(sourceStart);
        const lengthTicks = judgementMoodMillisecondsToTicks(sourceLength);
        return {
            start: startTicks,
            end: startTicks + Math.max(0, lengthTicks),
        };
    }

    const instructionScale = Math.max(1, numericValue(ornament?.scale) ?? 1);
    const start = sourceStart * instructionScale;
    const length = Math.max(0, sourceLength * instructionScale);
    return {
        start,
        end: start + length,
    };
};

const insertPedalEnvelope = (
    mpm: MPM,
    scope: Scope,
    downDate: number,
    upDate: number,
) => {
    const pedalDown: Movement = {
        type: 'movement',
        'xml:id': 'judgement_mood_pedal_down',
        date: downDate,
        position: 0,
        'transition.to': 1,
        controller: 'sustain',
    };
    const pedalReached: Movement = {
        type: 'movement',
        'xml:id': 'judgement_mood_pedal_down_done',
        date: downDate + PEDAL_RAMP_TICKS,
        position: 1,
        controller: 'sustain',
    };
    const pedalUp: Movement = {
        type: 'movement',
        'xml:id': 'judgement_mood_pedal_up',
        date: upDate,
        position: 1,
        'transition.to': 0,
        controller: 'sustain',
    };
    const pedalReleased: Movement = {
        type: 'movement',
        'xml:id': 'judgement_mood_pedal_up_done',
        date: upDate + PEDAL_RAMP_TICKS,
        position: 0,
        controller: 'sustain',
    };
    mpm.insertInstructions([pedalDown, pedalReached, pedalUp, pedalReleased], scope);
};

export const buildJudgementMoodRenderPlan = (
    reductionNotes: readonly MeasuredNote[],
    scoreNotes: readonly MeasuredNote[],
    referenceMpm: MPM,
    targetDate: number,
    options: JudgementMoodOptions = {},
): JudgementMoodRenderPlan | null => {
    const chord = pickReductionChord(reductionNotes, targetDate);
    if (!chord) return null;

    const ornament = pickMoodOrnament(referenceMpm, targetDate);
    const ornamentDef = ornament?.['name.ref']
        ? clonePlain(referenceMpm.getDefinition('ornamentDef', ornament['name.ref']) as OrnamentDef | null)
        : null;
    const effectiveDef = buildSlowMoodOrnamentDef(ornamentDef, chord.notes.length);
    const reductionOrder = buildReductionOrder(chord.notes, ornament?.['note.order'], buildPitchById(scoreNotes));
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

    const mpm = new MPM();
    mpm.setPerformanceName('judgement_mood');
    mpm.insertDefinition(effectiveDef, 'global');

    const tempo: Tempo = {
        type: 'tempo',
        'xml:id': 'judgement_mood_tempo',
        date: renderFrom,
        bpm: FIXED_JUDGEMENT_BPM,
        beatLength: FIXED_BEAT_LENGTH,
    };
    const ornamentStyle: Style = {
        type: 'style',
        'xml:id': 'judgement_mood_ornament_style',
        date: renderFrom,
        'name.ref': 'performance_style',
    };
    const dynamics: Dynamics = {
        type: 'dynamics',
        'xml:id': 'judgement_mood_dynamics',
        date: renderFrom,
        volume: resolveMoodDynamics(referenceMpm, targetDate),
    };
    const moodOrnament: Ornament = {
        type: 'ornament',
        'xml:id': 'judgement_mood_ornament',
        date: chord.date,
        'name.ref': effectiveDef.name,
        'note.order': reductionOrder,
        scale: 1,
    };

    if (ornament) {
        const intensity = numericValue(ornament.intensity);
        const transitionFrom = numericValue(ornament['transition.from']);
        const transitionTo = numericValue(ornament['transition.to']);
        if (intensity != null) moodOrnament.intensity = intensity;
        if (transitionFrom != null) moodOrnament['transition.from'] = transitionFrom;
        if (transitionTo != null) moodOrnament['transition.to'] = transitionTo;
        if (ornament['noteoff.shift'] != null) moodOrnament['noteoff.shift'] = ornament['noteoff.shift'];
    }

    mpm.insertStyle(ornamentStyle, 'ornament', 'global');
    mpm.insertInstructions([tempo, dynamics, moodOrnament], 'global');
    insertPedalEnvelope(mpm, 'global', earliestPedalDown, pedalReleaseDate);

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
