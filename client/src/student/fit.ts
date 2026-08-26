/**
 * The student's playing, written into Grünfeld's slots.
 *
 * The scaffold (`scaffold.ts`) has already answered *where* every instruction goes and what it
 * is called; what is left is *what value* each slot holds, which turns fitting from a search
 * into an interpolation. Six of the seven dimensions the teacher speaks about are measured
 * here — tempo, dynamics, rubato, articulation, accentuationPattern and ornament — where the
 * old pipeline measured three (`asynchrony` has no elements on the reference and nothing to
 * capture on the student; it is deliberately not fitted).
 *
 * ## Order, and why it is not permutable (semantics 1)
 *
 *   ornament → (tempo → rubato) × 2 → dynamics → ⟨render⟩ → articulation → ⟨render⟩ → accentuation
 *
 * A rolled chord has no single onset, so the spread has to be read and taken off before any
 * tempo can be measured from those onsets. Tempo and rubato are then fitted *twice*: a rubato
 * moves a note within its frame, so a tempo read across a frame boundary carries the warp with
 * it, and a rubato is measured against what the tempo has already explained — one iteration
 * settles it (§2/3 below). Dynamics comes before articulation because `relativeVelocity`'s
 * divisor is the *prescribed* velocity, not the score's (semantics 12), and before accentuation
 * because a metrical pattern is invisible under an unexplained trend (semantics 15). The two
 * ⟨render⟩ marks are where the document is played through espressivo and subtracted — see
 * `residual.ts`.
 *
 * ## Determinism (semantics 5)
 *
 * The same take fitted twice is the same bytes. Every id is `${type}_${date}`, read off the
 * reference; every annealing run gets a generator seeded from the points it is fitting; every
 * written attribute is rounded at the write boundary. No `uuid`, no clock, no `Math.random`.
 *
 * ## The thin-slot rule (risk R1)
 *
 * A take that stops mid-phrase leaves slots with nothing in them. A slot the student did not
 * play through is **not written** and is reported in {@link FitResult.skipped} — never
 * silently filled with a number that came from somewhere else. The comparison answers for
 * those dates from its own curve profile instead.
 */
import {
    ArticulationDef,
    ArticulationMap,
    AccentuationPatternDef,
    DynamicsMap,
    FrameDomain,
    MetricalAccentuationMap,
    Mpm,
    NoteOffShift,
    OrnamentDef,
    OrnamentationMap,
    Performance,
    RubatoMap,
    Style,
    TempoMap,
    ARTICULATION_MAP,
    ARTICULATION_STYLE,
    METRICAL_ACCENTUATION_MAP,
    METRICAL_ACCENTUATION_STYLE,
    ORNAMENTATION_MAP,
    ORNAMENTATION_STYLE,
    computeMillisecondsAt,
    fitTransitionCurve,
    getAllDescendantsByName,
    isOk,
    Msm,
    pulsesPerWhole,
    type AddTempoOptions,
    type AnyResult,
    type AnyStyle,
    type CurveSample,
    type Element,
    type GenericMap,
    type OkOf,
} from 'espressivo';
import type { MeasuredNote } from '../score/measured';
import { PPQ } from '../shared/constants';
import { hashSeed, seededRandom } from './random';
import { detectArpeggio, gradientScale, type Arpeggio } from './ornament';
import {
    calculateRubatoOnDate,
    renderStudent,
    tempoClock,
    type AnchoredTempo,
    type RubatoFrame,
} from './residual';
import type { AccSlot, DefSlot, Scaffold, Slot } from './scaffold';

/** The seven dimension names the diff, the plan schema and the validator all share. */
export type LegacyType =
    | 'tempo'
    | 'dynamics'
    | 'rubato'
    | 'articulation'
    | 'accentuationPattern'
    | 'ornament'
    | 'asynchrony';

/** The student's own levels, for the counter-performance's pivot (semantics 27). */
export type Levels = { student: { bpm: number[]; volume: number[] } };

/** A slot the take could not answer for, and why. Logged per take, never silent. */
export type SkippedSlot = {
    readonly type: LegacyType;
    readonly xmlId: string;
    readonly date: number;
    readonly reason: string;
};

export type FitResult = {
    /** The student's performance, as MPM text — the boundary every document crosses. */
    readonly studentMpmText: string;
    /** Which dimensions actually got a written element. */
    readonly filled: Set<LegacyType>;
    readonly levels: Levels;
    readonly skipped: readonly SkippedSlot[];
};

export type FitOptions = {
    /** Ticks per quarter. The project speaks 720 everywhere; this is here to be stated, not varied. */
    readonly ppq?: number;
    /** How short a chord spread may be and still be the recording's jitter rather than a roll, ms. */
    readonly rollThresholdMs?: number;
    /**
     * How much of the within-slot timing residual a `<rubato>` has to explain before it is
     * written at all. Risk R5: a tempo ramp and a rubato warp are partly redundant, and tempo
     * already has the slot's three degrees of freedom.
     */
    readonly rubatoGain?: number;
    /** Half the span a boundary tempo is read over, ticks. Defaults to {@link TEMPO_WINDOW_TICKS}. */
    readonly tempoWindow?: number;
};

/** Risk R5's threshold: a rubato is written only if it cuts the residual RMS by this much. */
export const RUBATO_MIN_GAIN = 0.2;

/**
 * Half the span a boundary tempo is read over, in ticks — one rubato frame, which is one
 * quarter note in this reconstruction (all 56 of Grünfeld's `<rubato>` frames are 720 ticks).
 * See {@link localBpm} for why the width is a frame and not the nearest onsets.
 */
export const TEMPO_WINDOW_TICKS = 720;

const DEFAULTS = {
    ppq: PPQ,
    rollThresholdMs: 35,
    rubatoGain: RUBATO_MIN_GAIN,
    tempoWindow: TEMPO_WINDOW_TICKS,
};

// ── the write boundary ───────────────────────────────────────────────────────────────────

/**
 * Every number that reaches the document goes through here.
 *
 * Rounding at the *write* boundary rather than during the fit is what makes "the same take
 * twice" a statement about bytes: two runs that agree to 1e-15 would otherwise serialize
 * differently. The digit counts are one order finer than the diff's own noise floor for each
 * attribute (`THRESHOLDS`, semantics 19), so nothing the teacher can see is rounded away.
 */
const ROUNDING = {
    bpm: 3,
    meanTempoAt: 4,
    volume: 2,
    curve: 4,
    intensity: 4,
    relativeDuration: 4,
    relativeVelocity: 4,
    scale: 4,
    frameLength: 0,
} as const;

const round = (value: number, digits: number): number => Number(value.toFixed(digits));

const unwrap = <R extends AnyResult>(result: R, what: string): OkOf<R> => {
    if (!isOk(result)) throw new Error(`student MPM: ${what} could not be created`);
    return result.value as OkOf<R>;
};

const median = (values: readonly number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

// ── the measurement, grouped ─────────────────────────────────────────────────────────────

/** All the notes of one score date — a chord, which is the unit dynamics is measured in. */
type Chord = { readonly date: number; readonly notes: readonly MeasuredNote[]; onsetMs: number };

const chordsOf = (notes: readonly MeasuredNote[]): Chord[] => {
    const byDate = new Map<number, MeasuredNote[]>();
    for (const note of notes) {
        if (!Number.isFinite(note['milliseconds.date'])) continue;
        const group = byDate.get(note.date);
        if (group) group.push(note);
        else byDate.set(note.date, [note]);
    }
    return [...byDate.entries()]
        .sort(([a], [b]) => a - b)
        .map(([date, group]) => ({
            date,
            notes: group,
            onsetMs: group.reduce((sum, note) => sum + note['milliseconds.date'], 0) / group.length,
        }));
};

/**
 * Where a score tick was played, read off the take by interpolating between the onsets that
 * bracket it. Outside the take it extrapolates from the nearest pair, which is what lets a
 * slot boundary sitting just past the last note still be timed.
 */
const onsetReader = (chords: readonly Chord[]) => {
    const dates = chords.map((chord) => chord.date);
    const times = chords.map((chord) => chord.onsetMs);

    return (tick: number): number => {
        if (chords.length === 0) return tick;
        if (chords.length === 1) return times[0];

        let i = dates.findIndex((date) => date >= tick);
        if (i === -1) i = dates.length - 1;
        const hi = Math.max(1, i);
        const lo = hi - 1;
        const span = dates[hi] - dates[lo];
        if (span === 0) return times[lo];
        return times[lo] + ((tick - dates[lo]) / span) * (times[hi] - times[lo]);
    };
};

/**
 * The tempo at one boundary, from the onsets that *straddle* it.
 *
 * `bpm = Δticks · 15000 / (Δms · beatLength · ppq)` is `ticksForConstantTempo` solved for the
 * tempo. Two things decide whether the answer is the tempo *at* the date or something else:
 *
 * - the window is **centred** on the boundary, not laid after it. A secant centred on a point
 *   estimates the derivative there to second order where a one-sided one is first-order, and
 *   under a curve that swings 45 bpm inside a bar that is the difference between a number and
 *   a guess.
 * - the window is **one rubato frame wide either side** ({@link TEMPO_WINDOW_TICKS}). A rubato
 *   moves notes *within* a frame without moving the frame, so two points a whole frame apart
 *   sit at the same position inside their frames and the warp cancels between them. Read over
 *   the two nearest onsets instead — a third of a frame apart — the warp is simply added to
 *   the tempo, and a student's rubato would be reported as their tempo (risk R5, from the
 *   other side).
 *
 * Where the window would leave the take it is slid back inside rather than shortened, so every
 * boundary is measured over the same span.
 */
const localBpm = (
    chords: readonly Chord[],
    msAtTick: (tick: number) => number,
    date: number,
    beatLength: number,
    ppq: number,
    halfWidth: number,
): number | null => {
    if (chords.length < 2) return null;

    const first = chords[0].date;
    const last = chords[chords.length - 1].date;
    let lo = date - halfWidth;
    let hi = date + halfWidth;
    if (lo < first) {
        hi += first - lo;
        lo = first;
    }
    if (hi > last) {
        lo -= hi - last;
        hi = last;
    }
    lo = Math.max(lo, first);
    hi = Math.min(hi, last);

    const ticks = hi - lo;
    const ms = msAtTick(hi) - msAtTick(lo);
    if (ticks <= 0 || ms <= 0) return null;

    const bpm = (ticks * 15000) / (ms * beatLength * ppq);
    return Number.isFinite(bpm) ? clamp(bpm, 10, 400) : null;
};

/** How many chords a slot actually contains — the thin-slot rule's counter (risk R1). */
const chordsIn = (chords: readonly Chord[], slot: Slot): Chord[] =>
    chords.filter((chord) => chord.date >= slot.date && chord.date < slot.endDate);

/** One slot with the span it will actually be written over, once the empty ones are out. */
export type SlotSpan<T extends Slot> = { readonly slot: T; readonly end: number };

/**
 * Which slots the take can answer for, and what each one's span becomes once the others are
 * dropped.
 *
 * The thin-slot rule cannot be applied slot by slot, because dropping one *widens* its
 * neighbour: an instruction prevails until the next one, so a `<tempo>` whose successor was
 * never written keeps ramping into the successor's territory. Solved slot by slot, that ramp
 * arrives at the wrong tempo halfway through the next bar and every onset after it is late —
 * measured at 68 ms RMS on a four-bar take before this was closed.
 *
 * So the spans are recomputed after every drop and the rule re-applied, until what is left is
 * a gapless chain of spans that each hold at least two chords. The last one ends where the
 * playing does rather than where the reference says, because a duration nobody played through
 * cannot be measured.
 */
export const spansOf = <T extends Slot>(slots: readonly T[], chords: readonly Chord[]): SlotSpan<T>[] => {
    if (chords.length === 0) return [];
    const lastChord = chords[chords.length - 1].date;

    let kept = [...slots];
    for (;;) {
        const spans: SlotSpan<T>[] = kept.map((slot, i) => ({
            slot,
            end: i + 1 < kept.length ? kept[i + 1].date : Math.min(slot.endDate, lastChord),
        }));
        const thin = spans.findIndex(
            ({ slot, end }) =>
                end <= slot.date ||
                chords.filter((chord) => chord.date >= slot.date && chord.date < end).length < 2,
        );
        if (thin === -1) return spans;
        kept = kept.filter((_, i) => i !== thin);
        if (kept.length === 0) return [];
    }
};

/**
 * How many *instructions* a map holds — a `<style>` switch is scaffolding, not a statement
 * about the playing, so a map carrying nothing else has said nothing.
 */
const instructionCount = (map: GenericMap): number => {
    let count = 0;
    for (let i = 0; i < map.size(); i++) {
        if (map.getElement(i)?.getLocalName() !== 'style') count++;
    }
    return count;
};

// ── the document under construction ──────────────────────────────────────────────────────

/**
 * The student's MPM as it is being filled in.
 *
 * One document, written to in stages and serialized at each render point, rather than three
 * documents assembled and thrown away: the renderer needs text, and the maps have to accrete
 * in the order the fit discovers them.
 */
class StudentDocument {
    private readonly mpm = Mpm.createMpm();
    private readonly dated;
    private readonly header;

    readonly tempoMap = TempoMap.createTempoMap();
    readonly dynamicsMap = DynamicsMap.createDynamicsMap();
    readonly rubatoMap = RubatoMap.createRubatoMap();
    readonly articulationMap = ArticulationMap.createArticulationMap();
    readonly accentuationMap = MetricalAccentuationMap.createMetricalAccentuationMap();
    readonly ornamentMap = OrnamentationMap.createOrnamentationMap();

    private readonly styles = new Map<string, Style>();

    constructor(ppq: number) {
        const performance = unwrap(Performance.fromName('student', ppq), 'the performance');
        this.mpm.addPerformance(performance);
        const global = performance.getGlobal();
        if (!global) throw new Error('student MPM: the performance has no <global>');
        const dated = global.getDated();
        const header = global.getHeader();
        if (!dated || !header) throw new Error('student MPM: the performance has no <dated>/<header>');
        this.dated = dated;
        this.header = header;

        this.ordered = [
            // The reference's own order, so the two documents read alike.
            this.tempoMap,
            this.ornamentMap,
            this.rubatoMap,
            this.dynamicsMap,
            this.accentuationMap,
            this.articulationMap,
        ];
    }

    private readonly ordered: readonly GenericMap[];

    /** The `styleDef` a collection's defs go into, created once, under the reference's own name. */
    style<K extends 'articulation' | 'ornamentation' | 'metricalAccentuation'>(
        kind: K,
        collection: string,
        name: string,
    ): Style<K> {
        const key = `${collection}::${name}`;
        const existing = this.styles.get(key);
        if (existing) return existing as Style<K>;

        const style = Style.create(kind, name, `style_${collection}_${name}`);
        // `AnyStyle` is a union over the seven kinds and a generic `Style<K>` is assignable to
        // none of its members individually, though it is one of them at every call site here.
        this.header.addStyleDef(collection, style as unknown as AnyStyle);
        this.styles.set(key, style as unknown as Style);
        return style;
    }

    /**
     * The document as it stands. Callable at any point in the fit, and repeatedly: the two
     * residual renders read it half-finished and the caller reads it at the end.
     *
     * `<dated>` is rebuilt from the map objects each time rather than written to once, for two
     * reasons. A map with nothing in it would still serialize as an element, and `compareMpm`
     * reads an empty `<rubatoMap>` as a performance declaring "no rubato" rather than as one
     * that never spoke about it — dropping them is what keeps `both-neutral` reachable. And a
     * map dropped at the *first* render would then stay detached while the stages after it
     * kept adding to an object no longer in the tree, which is exactly how the articulation
     * map silently vanished.
     */
    text(): string {
        for (const [name] of [...this.dated.getAllMaps()]) this.dated.removeMap(name);
        for (const map of this.ordered) if (instructionCount(map) > 0) this.dated.addMap(map);

        const text = this.mpm.writeMpm();
        if (text === null) throw new Error('student MPM: the document could not be written');
        return text;
    }
}

// ── the time signature, for the accentuation grid ────────────────────────────────────────

/**
 * The denominator in force at a date, read from the score.
 *
 * `denominator · beat + 1` is the grid espressivo's `MetricalAccentuationMap` reads a pattern
 * back on (semantics 16), so a pattern counted in the wrong unit is indexed against a meter
 * nobody hears. Träumerei opens on a 1/4 anacrusis and is 4/4 thereafter; both answer 4, but
 * reading it is what keeps that a fact rather than an assumption.
 */
const denominatorReader = (scoreMsmText: string) => {
    const root = new Msm(scoreMsmText).getRootElement();
    const signatures = (root ? (getAllDescendantsByName('timeSignature', root) ?? []) : [])
        .map((element: Element) => ({
            date: Number(element.getAttributeValue('date')),
            denominator: Number(element.getAttributeValue('denominator')),
        }))
        .filter((entry) => Number.isFinite(entry.date) && Number.isFinite(entry.denominator))
        .sort((a, b) => a.date - b.date);

    return (date: number): number => {
        let denominator = 4;
        for (const entry of signatures) {
            if (entry.date > date) break;
            denominator = entry.denominator;
        }
        return denominator;
    };
};

// ── the fit ──────────────────────────────────────────────────────────────────────────────

/**
 * Turn one take into the student's MPM.
 *
 * @param notes the take, already matched to score notes and timed in milliseconds
 * @param scaffold Grünfeld's slots over the same range
 * @param scoreMsmText the score, for the two residual renders and the metrical grid
 */
export const fitStudent = (
    notes: readonly MeasuredNote[],
    scaffold: Scaffold,
    scoreMsmText: string,
    options: FitOptions = {},
): FitResult => {
    const { ppq, rollThresholdMs, rubatoGain, tempoWindow } = { ...DEFAULTS, ...options };
    const document = new StudentDocument(ppq);
    const filled = new Set<LegacyType>();
    const skipped: SkippedSlot[] = [];
    const skip = (type: LegacyType, slot: Slot, reason: string): void => {
        skipped.push({ type, xmlId: slot.xmlId, date: slot.date, reason });
    };

    // ── 1. ornament: the rolled chords, read and taken off ───────────────────────────────
    const arpeggios = new Map<number, Arpeggio>();
    for (const slot of scaffold.ornament) {
        const chord = notes.filter((note) => note.date === slot.date);
        const arpeggio = detectArpeggio(slot.date, chord, rollThresholdMs);
        if (!arpeggio) {
            skip('ornament', slot, chord.length < 2 ? 'fewer than two notes played' : 'no measurable roll');
            continue;
        }
        arpeggios.set(slot.date, arpeggio);
    }

    // The spread is now the ornament's to render, so the chord collapses onto one onset and a
    // tempo can be read off it. A copy: the take belongs to the caller (semantics 30).
    const collapsed: MeasuredNote[] = notes.map((note) => {
        const shift = arpeggios.get(note.date)?.shiftMs.get(note['xml:id']);
        if (shift === undefined || shift === 0) return note;
        return {
            ...note,
            'milliseconds.date': note['milliseconds.date'] + shift,
            'milliseconds.date.end': note['milliseconds.date.end'] + shift,
        };
    });

    const chords = chordsOf(collapsed);

    // ── 2 and 3. tempo and rubato, in that order and then once again ─────────────────────
    //
    // These two describe the same onsets and cannot be fitted independently. A `<rubato>`
    // moves a note *within* its frame, so a tempo read across a frame boundary carries the
    // warp with it and reports it as tempo; and a rubato is measured against what the tempo
    // has already explained. Grünfeld's tempo boundaries do not fall on his rubato frames
    // (they sit 2.5 frames apart in places), so neither ordering escapes the other by itself.
    //
    // The answer is the residual chain, run once: fit the tempo as if there were no rubato,
    // fit the rubato against that tempo, then fit the tempo again over onsets whose frame
    // positions the fitted rubato accounts for, and the rubato once more against *that*. One
    // iteration is enough because the correction is a fraction of a frame; a second changes
    // nothing measurable and costs another pass.

    /** One pass of the tempo fit, over onsets placed by `warp`. */
    const tempoPass = (warp: (date: number) => number) => {
        const placed = chords.map((chord) => ({ ...chord, date: warp(chord.date) }));
        const msAtTick = onsetReader(placed);
        const spans = spansOf(scaffold.tempo, placed);
        const tempos: AnchoredTempo[] = [];
        const missed: SkippedSlot[] = [];

        for (const slot of scaffold.tempo) {
            if (!spans.some((span) => span.slot === slot)) {
                missed.push({
                    type: 'tempo',
                    xmlId: slot.xmlId,
                    date: slot.date,
                    reason: 'fewer than two chords in the slot',
                });
            }
        }

        for (const { slot, end } of spans) {
            const beatLength = slot.beatLength ?? 0.25;
            const bpm = localBpm(placed, msAtTick, slot.date, beatLength, ppq, tempoWindow);
            const transitionTo = localBpm(placed, msAtTick, end, beatLength, ppq, tempoWindow) ?? bpm;
            if (bpm === null || transitionTo === null) {
                missed.push({
                    type: 'tempo',
                    xmlId: slot.xmlId,
                    date: slot.date,
                    reason: 'no onsets bracketing the boundary',
                });
                continue;
            }

            const startMs = msAtTick(slot.date);
            const targetMs = msAtTick(end) - startMs;
            const interior = placed
                .filter((chord) => chord.date > slot.date && chord.date < end)
                .map((chord) => ({ date: chord.date, fraction: (chord.onsetMs - startMs) / targetMs }));
            const shaped = fitSpanDuration(
                { date: slot.date, bpm, transitionTo, beatLength, endDate: end },
                targetMs,
                ppq,
                interior,
            );

            tempos.push({
                tempo: {
                    date: slot.date,
                    bpm: round(shaped.bpm as number, ROUNDING.bpm),
                    transitionTo: round(shaped.transitionTo as number, ROUNDING.bpm),
                    meanTempoAt: round(shaped.meanTempoAt ?? 0.5, ROUNDING.meanTempoAt),
                    beatLength,
                    endDate: end,
                    id: slot.xmlId,
                },
                anchorMs: startMs,
            });
        }
        return { tempos, missed };
    };

    /** One pass of the rubato fit, against a tempo clock. */
    const rubatoPass = (clock: ReturnType<typeof tempoClock>) => {
        const frames: (RubatoFrame & { id: string })[] = [];
        const missed: SkippedSlot[] = [];
        const note = (slot: Slot, reason: string) =>
            missed.push({ type: 'rubato', xmlId: slot.xmlId, date: slot.date, reason });

        for (const slot of scaffold.rubato) {
            const inSlot = chordsIn(chords, slot);
            if (inSlot.length < 2) {
                note(slot, 'fewer than two chords in the frame');
                continue;
            }
            if (slot.frameLength === undefined) {
                note(slot, 'the reference frame states no @frameLength');
                continue;
            }

            // Where each chord actually landed on the score grid, once the tempo is taken off.
            const landed = inSlot.map((chord) => ({ date: chord.date, tick: clock.tickAt(chord.onsetMs) }));
            const frame = (intensity: number): RubatoFrame => ({
                date: slot.date,
                frameLength: slot.frameLength,
                intensity,
                lateStart: slot.lateStart,
                earlyEnd: slot.earlyEnd,
                loop: slot.loop,
            });
            const rms = (intensity: number): number => {
                const total = landed.reduce((sum, point) => {
                    const modelled = calculateRubatoOnDate(point.date, frame(intensity));
                    const error = point.tick - modelled;
                    return sum + (Number.isFinite(error) ? error * error : 0);
                }, 0);
                return Math.sqrt(total / landed.length);
            };

            const intensity = goldenSection(rms, 0.1, 5);
            const neutral = rms(1);
            if (!(neutral > 0) || rms(intensity) > (1 - rubatoGain) * neutral) {
                // Risk R5: the tempo ramp already has the slot's three degrees of freedom, so a
                // rubato that barely improves on the identity warp is the tempo fit re-described.
                note(slot, `explains under ${Math.round(rubatoGain * 100)} % of the residual`);
                continue;
            }

            frames.push({ ...frame(round(intensity, ROUNDING.intensity)), id: slot.xmlId });
        }
        return { frames, missed };
    };

    let tempo = tempoPass((date) => date);
    let rubato = rubatoPass(tempoClock(tempo.tempos, ppq));
    if (rubato.frames.length > 0) {
        tempo = tempoPass(warpFromFrames(rubato.frames));
        rubato = rubatoPass(tempoClock(tempo.tempos, ppq));
    }

    const writtenBpm: number[] = [];
    for (const { tempo: element } of tempo.tempos) {
        document.tempoMap.addTempo(element);
        writtenBpm.push(element.bpm as number);
        filled.add('tempo');
    }
    for (const frame of rubato.frames) {
        document.rubatoMap.addRubato({ ...frame, id: frame.id });
        filled.add('rubato');
    }
    skipped.push(...tempo.missed, ...rubato.missed);

    // ── 4. dynamics ──────────────────────────────────────────────────────────────────────
    const writtenVolume: number[] = [];
    const volumeAt = (slot: Slot): number | null => {
        const inSlot = chordsIn(chords, slot);
        const first = inSlot[0];
        if (!first) return null;
        // Per-chord MEAN velocity (semantics 10) — one struck chord is one dynamic observation.
        return first.notes.reduce((sum, note) => sum + note.velocity, 0) / first.notes.length;
    };

    for (const [index, slot] of scaffold.dynamics.entries()) {
        const inSlot = chordsIn(chords, slot);
        if (inSlot.length < 2) {
            skip('dynamics', slot, 'fewer than two chords in the slot');
            continue;
        }
        const volume = volumeAt(slot);
        if (volume === null) continue;
        const next = scaffold.dynamics[index + 1];
        const transitionTo = (next ? volumeAt(next) : null) ?? volumeAt({ ...slot, date: slot.endDate }) ?? volume;

        const samples: CurveSample[] = inSlot.map((chord) => ({
            date: chord.date,
            value: chord.notes.reduce((sum, note) => sum + note.velocity, 0) / chord.notes.length,
        }));
        // Seeded from the points themselves, so the bend is a pure function of what was played
        // (semantics 5) — `fitTransitionCurve` anneals, and its default source is `Math.random`.
        const random = seededRandom(hashSeed(JSON.stringify(samples)));
        const bend = fitTransitionCurve(
            { startDate: slot.date, endDate: slot.endDate, from: volume, to: transitionTo },
            samples,
            { random },
        );

        document.dynamicsMap.addDynamics({
            date: slot.date,
            volume: round(volume, ROUNDING.volume),
            transitionTo: round(transitionTo, ROUNDING.volume),
            curvature: round(bend.curvature, ROUNDING.curve),
            protraction: round(bend.protraction, ROUNDING.curve),
            id: slot.xmlId,
        });
        writtenVolume.push(round(volume, ROUNDING.volume));
        filled.add('dynamics');
    }

    // ── 5. the ornament defs, now that a tempo exists to convert their frames ─────────────
    if (arpeggios.size > 0 && scaffold.styleNames.ornamentation) {
        const style = document.style('ornamentation', ORNAMENTATION_STYLE, scaffold.styleNames.ornamentation);
        for (const slot of scaffold.ornament) {
            const arpeggio = arpeggios.get(slot.date);
            if (!arpeggio) continue;

            // The reference states its frames in ticks (`time.unit="ticks"`), so the student's
            // have to be ticks too or the two sides are not in one unit. The conversion is the
            // tempo the fit just found at that date.
            const toTicks = ticksPerMs(tempo.tempos, slot.date, ppq);
            // The gradient's SHAPE is the reference's editorial choice — mpm-desk offers a
            // human a crescendo/decrescendo pair to pick from — so it is copied, and the size
            // of the ramp is what the student's playing decides. Fitting the shape too would
            // report a difference that is only a different way of writing the same roll:
            // `scale 7` over `1 → 0` and `scale 3.5` over `1 → −1` are one velocity ramp.
            const scale = gradientScale(notes.filter((note) => note.date === slot.date), slot.gradient);

            const def = unwrap(OrnamentDef.createOrnamentDef(slot.defName), `ornamentDef ${slot.defName}`);
            def.setTemporalSpreadValues(
                round(arpeggio.frameStartMs * toTicks, ROUNDING.frameLength),
                round(arpeggio.frameLengthMs * toTicks, ROUNDING.frameLength),
                FrameDomain.Ticks,
                round(arpeggio.intensity, ROUNDING.intensity),
                noteOffShiftOf(arpeggio.noteOffShift),
            );
            if (slot.gradient) {
                def.setDynamicsGradientValues(slot.gradient.from, slot.gradient.to);
            }
            style.addDef(def);

            // `@scale` is omitted, not written as 0, where the chord had no ramp to measure:
            // `addOrnamentV3` writes an explicit `undefined` as `scale="0"`, and a zero here
            // would read as "played perfectly evenly" rather than "not measured".
            document.ornamentMap.addOrnamentV3({
                date: slot.date,
                nameRef: slot.defName,
                ...(scale === null ? {} : { scale: round(scale, ROUNDING.scale) }),
                noteOrder: arpeggio.noteOrder,
                id: slot.xmlId,
            });
            filled.add('ornament');
        }
    }

    // ── the first residual render: what the document prescribes so far ───────────────────
    //
    // The `<style>` switches go in first: without them the `@name.ref` of every ornament the
    // render is about to read would dangle, and the rolls would not sound.
    addStyleSwitches(scaffold, {
        [ORNAMENTATION_MAP]: document.ornamentMap,
        [METRICAL_ACCENTUATION_MAP]: document.accentuationMap,
        [ARTICULATION_MAP]: document.articulationMap,
    });
    const prescribed = renderStudent(scoreMsmText, document.text());

    // ── 6. articulation ──────────────────────────────────────────────────────────────────
    const measuredById = new Map(notes.map((note) => [note['xml:id'], note]));
    type Ratio = { duration: number[]; velocity: number[] };
    const perDef = new Map<string, Ratio>();
    const slotsPerDef = new Map<string, DefSlot[]>();

    for (const slot of scaffold.articulation) {
        const group = slotsPerDef.get(slot.defName) ?? [];
        group.push(slot);
        slotsPerDef.set(slot.defName, group);

        if (slot.defStates.includes('absoluteDuration') && !slot.defStates.includes('relativeDuration')) {
            // Risk R6: an absolute duration is a length in ticks, not a ratio. Coercing it into
            // one would report an articulation nobody played.
            skip('articulation', slot, 'the reference def states @absoluteDuration, which v1 does not fit');
            continue;
        }

        const ratios = perDef.get(slot.defName) ?? { duration: [], velocity: [] };
        for (const id of slot.noteIds ?? []) {
            const measured = measuredById.get(id);
            const rendered = prescribed.get(id);
            if (!measured || !rendered) continue;

            const renderedMs = rendered.msEnd - rendered.msDate;
            const measuredMs = measured['milliseconds.date.end'] - measured['milliseconds.date'];
            if (renderedMs > 0 && measuredMs > 0) ratios.duration.push(measuredMs / renderedMs);
            // semantics 12: the divisor is the PRESCRIBED velocity, not the score's.
            if (rendered.velocity > 0) ratios.velocity.push(measured.velocity / rendered.velocity);
        }
        perDef.set(slot.defName, ratios);
    }

    if (scaffold.styleNames.articulation) {
        const style = document.style('articulation', ARTICULATION_STYLE, scaffold.styleNames.articulation);
        for (const [defName, ratios] of perDef) {
            const slots = slotsPerDef.get(defName) ?? [];
            if (ratios.duration.length === 0) {
                for (const slot of slots) skip('articulation', slot, 'none of its notes were played');
                continue;
            }

            const def = unwrap(ArticulationDef.createArticulationDef(defName), `articulationDef ${defName}`);
            def.setRelativeDuration(round(median(ratios.duration), ROUNDING.relativeDuration));
            if (ratios.velocity.length > 0) {
                def.setRelativeVelocity(round(median(ratios.velocity), ROUNDING.relativeVelocity));
            }
            style.addDef(def);

            for (const slot of slots) {
                document.articulationMap.addArticulation({
                    date: slot.date,
                    nameRef: defName,
                    noteid: (slot.noteIds ?? []).map((id) => `#${id}`).join(' ') || undefined,
                    id: slot.xmlId,
                });
                filled.add('articulation');
            }
        }
    }

    // ── the second residual render: velocity, with articulation now explained ────────────
    const afterArticulation = filled.has('articulation')
        ? renderStudent(scoreMsmText, document.text())
        : prescribed;

    // ── 7. accentuation ──────────────────────────────────────────────────────────────────
    if (scaffold.accentuation.length > 0 && scaffold.styleNames.metricalAccentuation) {
        const denominatorAt = denominatorReader(scoreMsmText);
        const style = document.style(
            'metricalAccentuation',
            METRICAL_ACCENTUATION_STYLE,
            scaffold.styleNames.metricalAccentuation,
        );
        const writtenDefs = new Set<string>();

        for (const slot of scaffold.accentuation) {
            const pattern = scaffold.patterns.get(slot.defName);
            if (!pattern) {
                skip('accentuationPattern', slot, `the reference has no def named ${slot.defName}`);
                continue;
            }
            const scale = accentuationScale(slot, chords, measuredById, afterArticulation, denominatorAt(slot.date));
            if (scale === null) {
                skip('accentuationPattern', slot, 'fewer than two beats carry a played note');
                continue;
            }

            if (!writtenDefs.has(pattern.name)) {
                // The pattern's SHAPE is Grünfeld's and is copied; @scale is the one attribute
                // the student's playing decides, and the one the diff compares (semantics 15).
                const def = unwrap(
                    AccentuationPatternDef.fromNameLength(pattern.name, pattern.length, `def_${pattern.name}`),
                    `accentuationPatternDef ${pattern.name}`,
                );
                pattern.accentuations.forEach(([beat, value, from, to], i) => {
                    def.addAccentuation(beat, value, from, to, `accentuation_${pattern.name}_${i}`);
                });
                style.addDef(def);
                writtenDefs.add(pattern.name);
            }

            document.accentuationMap.addAccentuationPattern({
                date: slot.date,
                accentuationPatternDefName: pattern.name,
                scale: round(scale, ROUNDING.scale),
                id: slot.xmlId,
            });
            filled.add('accentuationPattern');
        }
    }

    return {
        studentMpmText: document.text(),
        filled,
        levels: { student: { bpm: writtenBpm, volume: writtenVolume } },
        skipped,
    };
};

// ── the pieces the stages lean on ────────────────────────────────────────────────────────

/**
 * `@meanTempoAt` such that the slot takes exactly as long as it took the student.
 *
 * `bpm` and `@transition.to` are already decided — they are the tempo measured *at* the two
 * boundaries — so the only freedom left is where in the span the mean tempo falls, and that is
 * exactly the freedom that makes the slot's duration come out right. `computeMillisecondsAt`
 * is monotone in it (measured: 1122 ms at 0.05 to 1906 ms at 0.95 on a 60→120 ramp), so a
 * bisection is well-posed; where the target lies outside what the two boundary tempi can
 * reach, the clamp keeps the nearer end rather than inventing an exponent.
 */
const solveMeanTempoAt = (
    tempo: AddTempoOptions & { endDate: number },
    targetMs: number,
    ppq: number,
): number => {
    if (typeof tempo.bpm !== 'number') return 0.5;
    const at = (meanTempoAt: number): number =>
        computeMillisecondsAt(tempo.endDate, { ...tempo, meanTempoAt }, ppq);

    const low = 0.02;
    const high = 0.98;
    const atLow = at(low);
    const atHigh = at(high);
    if (!Number.isFinite(atLow) || !Number.isFinite(atHigh) || atLow === atHigh) return 0.5;

    const rising = atHigh > atLow;
    if (targetMs <= Math.min(atLow, atHigh)) return rising ? low : high;
    if (targetMs >= Math.max(atLow, atHigh)) return rising ? high : low;

    let lo = low;
    let hi = high;
    for (let step = 0; step < 60; step++) {
        const mid = (lo + hi) / 2;
        const value = at(mid);
        if (value < targetMs === rising) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
};

/**
 * One `<tempo>` whose span takes exactly as long as the student took over it.
 *
 * `@meanTempoAt` alone cannot always deliver that: it can only move the duration between what
 * the two boundary tempi bracket, and where the playing inside a slot went outside that
 * bracket the bisection clamps and the slot comes out short or long. Left there, the error is
 * not local — the renderer accumulates milliseconds from the start of the document, so a slot
 * that runs 40 ms long puts every note after it 40 ms late, and the take drifts. (Measured
 * before this was closed: 203 ms RMS onset error on a four-bar take, against 30 ms after.)
 *
 * The correction is closed form, and it is exact. Scaling both tempi of a span by `k` scales
 * every instantaneous tempo by `k`, so it scales the elapsed time by exactly `1/k` and leaves
 * the *shape* — the ratio between the two ends, and the exponent `@meanTempoAt` derives —
 * untouched. So the shape is chosen first, then the level is set to make the duration right;
 * one bisection and one multiplication, no iteration.
 *
 * This is semantics 3 made structural. mpmify re-anchored every tempo boundary on the recorded
 * onset because a fitted tempo that is merely close leaves rubato and `relativeDuration`
 * measuring accumulated tempo error instead of playing; here the boundary lands on the recorded
 * onset because the span between two boundaries is exactly as long as it was played.
 */
export const fitSpanDuration = (
    tempo: AddTempoOptions & { endDate: number },
    targetMs: number,
    ppq: number,
    interior: readonly { date: number; fraction: number }[] = [],
): AddTempoOptions & { endDate: number } => {
    const meanTempoAt =
        interior.length > 0
            ? solveMeanTempoShape(tempo, interior, ppq)
            : solveMeanTempoAt(tempo, targetMs, ppq);
    const shaped = { ...tempo, meanTempoAt };
    if (typeof shaped.bpm !== 'number' || typeof shaped.transitionTo !== 'number') return shaped;

    const modelled = computeMillisecondsAt(shaped.endDate, shaped, ppq);
    if (!(targetMs > 0) || !(modelled > 0)) return shaped;

    const k = modelled / targetMs;
    if (!Number.isFinite(k) || k <= 0) return shaped;
    return { ...shaped, bpm: shaped.bpm * k, transitionTo: shaped.transitionTo * k };
};

/**
 * `@meanTempoAt` from the onsets *inside* the span, not from its total.
 *
 * Once {@link fitSpanDuration}'s level correction guarantees the total, the exponent is free to
 * describe what it is actually for: where in the span the tempo turns. Both sides of the
 * objective are normalized by their own total, so it compares pure shape — how far through the
 * span each onset fell — and is unaffected by the level correction that follows it.
 *
 * Freeing it is worth ~20 ms of onset error on a four-bar take. Spent on the duration instead,
 * it left every interior onset of a slot with a steep ramp up to 130 ms out of place while the
 * slot's two ends were exact.
 */
const solveMeanTempoShape = (
    tempo: AddTempoOptions & { endDate: number },
    interior: readonly { date: number; fraction: number }[],
    ppq: number,
): number => {
    const error = (meanTempoAt: number): number => {
        const candidate = { ...tempo, meanTempoAt };
        const total = computeMillisecondsAt(candidate.endDate, candidate, ppq);
        if (!(total > 0)) return Number.POSITIVE_INFINITY;
        return interior.reduce((sum, point) => {
            const modelled = computeMillisecondsAt(point.date, candidate, ppq) / total;
            const difference = modelled - point.fraction;
            return sum + difference * difference;
        }, 0);
    };
    return goldenSection(error, 0.02, 0.98);
};

/**
 * Golden-section search over a single parameter — the same routine `determineIntensity` uses,
 * and for the same reason: the objective is unimodal, it costs no derivative, and it visits
 * the same points in the same order every run.
 */
export const goldenSection = (
    error: (x: number) => number,
    lower: number,
    upper: number,
    tolerance = 1e-6,
): number => {
    const goldenRatio = (Math.sqrt(5) + 1) / 2;
    let low = lower;
    let high = upper;
    let c = high - (high - low) / goldenRatio;
    let d = low + (high - low) / goldenRatio;

    while (high - low > tolerance) {
        if (error(c) < error(d)) high = d;
        else low = c;
        c = high - (high - low) / goldenRatio;
        d = low + (high - low) / goldenRatio;
    }
    return (low + high) / 2;
};

/**
 * Where the fitted rubato puts each score date — the coordinate the tempo map actually times.
 *
 * MPM applies a rubato in the tick domain and the tempo map times what comes out, so a note
 * written at `d` is timed at `rubatoAt(d)`. Handing the tempo fit those positions instead of
 * the score's own is what stops it reading a warp as a tempo change: without it, a take played
 * at a dead-steady 60 bpm with a known rubato on it reported tempo elements 4.4 bpm apart,
 * which is over the diff's own noise floor and would have told a student to change something
 * they did correctly.
 *
 * A frame governs only its own span unless `@loop` says otherwise; outside it the identity.
 */
export const warpFromFrames = (frames: readonly RubatoFrame[]): ((date: number) => number) => {
    if (frames.length === 0) return (date) => date;
    const ordered = [...frames].sort((a, b) => a.date - b.date);

    return (date) => {
        let governing: RubatoFrame | null = null;
        for (const frame of ordered) {
            if (frame.date > date) break;
            governing = frame;
        }
        if (!governing || governing.frameLength === undefined) return date;
        if (!governing.loop && date >= governing.date + governing.frameLength) return date;
        const warped = calculateRubatoOnDate(date, governing);
        return Number.isFinite(warped) ? warped : date;
    };
};

/** Ticks per millisecond at a date, under the fitted tempo — the roll frame's unit conversion. */
const ticksPerMs = (anchored: readonly AnchoredTempo[], date: number, ppq: number): number => {
    const covering = anchored.filter((span) => span.tempo.date <= date).slice(-1)[0] ?? anchored[0];
    const bpm = typeof covering?.tempo.bpm === 'number' ? covering.tempo.bpm : 100;
    const beatLength = covering?.tempo.beatLength ?? 0.25;
    return (bpm * beatLength * ppq) / 15000;
};

const noteOffShiftOf = (value: 'false' | 'true' | 'monophonic'): NoteOffShift =>
    value === 'true'
        ? NoteOffShift.True
        : value === 'monophonic'
          ? NoteOffShift.Monophonic
          : NoteOffShift.False;

const addStyleSwitches = (
    scaffold: Scaffold,
    maps: Record<string, { addStyleSwitch: (date: number, name: string, id?: string) => number }>,
): void => {
    for (const style of scaffold.styleSwitches) {
        maps[style.map]?.addStyleSwitch(style.date, style.nameRef, `style_${style.map}_${style.date}`);
    }
};

/**
 * `@scale` for one accentuation slot: the largest residual velocity any beat of its cell
 * carries, once dynamics and articulation have been taken off (semantics 15).
 *
 * The grid is counted in **integers** and converted to ticks once per beat rather than
 * accumulated, because a triplet basis is not representable in binary and an accumulated
 * position drifts off the dates it is meant to select. An eighth-note grid, which is what the
 * reference's own patterns are written on (`beat="1.5"` under a denominator of 4).
 */
const accentuationScale = (
    slot: AccSlot,
    chords: readonly Chord[],
    measuredById: ReadonlyMap<string, MeasuredNote>,
    rendered: ReadonlyMap<string, { velocity: number }>,
    denominator: number,
): number | null => {
    const beatLength = 1 / (2 * denominator);
    const pulsesPerWholeNote = pulsesPerWhole(PPQ);
    const residuals: number[] = [];

    for (let index = 0; ; index++) {
        const date = slot.date + Math.round(index * beatLength * pulsesPerWholeNote);
        if (date >= slot.endDate) break;

        const chord = chords.find((candidate) => candidate.date === date);
        if (!chord) continue;

        const changes = chord.notes
            .map((note) => {
                const played = measuredById.get(note['xml:id']);
                const prescribed = rendered.get(note['xml:id']);
                return played && prescribed ? played.velocity - prescribed.velocity : null;
            })
            .filter((change): change is number => change !== null);
        if (changes.length === 0) continue;

        residuals.push(changes.reduce((sum, change) => sum + change, 0) / changes.length);
    }

    if (residuals.length < 2) return null;
    const scale = Math.max(...residuals.map(Math.abs));
    return scale > 0 ? scale : null;
};

