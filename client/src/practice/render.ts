/**
 * A practice pass, as something the piano can play.
 *
 * The roll's document is exaggerated as the pass asks (`exaggerateMpm`), rendered over the whole
 * piece (`performMsmToData`), and the pass's bars cut out of that render — so a loop over two
 * bars is played with the tempo and dynamics the whole exaggerated piece arrives at them with,
 * not restarted from nothing. Then the hand, the voicing, the touch and the speed are applied to
 * the notes, and the result is written as a MIDI file with one tick to the millisecond, which
 * both the Disklavier path and the sampler already take.
 *
 * The harmonic reduction is played with the roll's own tempo, dynamics and rubato, and with those
 * of his arpeggios that fall on its chords. espressivo, like meico, hands an ornament whose date
 * carries no note to the next note of each part instead, so the others are removed.
 */
import { exaggerateMpm, performMsmToData } from 'espressivo';
import type { AnyEvent, MidiFile } from 'midifile-ts';
import { END, type Hand, type Pass } from './planner';

const CC_SUSTAIN = 64;
const CC_SOFT = 67;

/** A note further than this from its beat was thrown out of place by an extreme rubato or spread. */
const STRAY_MS = 2500;
/** How long the last notes are let ring past the end of the pass. */
const RING_MS = 320;
/** A render is a few hundred milliseconds; a session's worth of them stays cached. */
const CACHE_SIZE = 40;

type Note = {
    readonly part: number;
    readonly pitch: number;
    readonly velocity: number;
    readonly date: number;
    readonly duration: number;
    readonly onMs: number;
    readonly offMs: number;
    /** Nothing higher is sounding when it starts. */
    melody: boolean;
    /** Nothing lower is sounding when it starts. */
    bass: boolean;
};

type Interval = readonly [number, number];

type Rendered = {
    readonly source: Pass['source'];
    readonly notes: readonly Note[];
    /** Date → milliseconds: the median onset at each date, kept monotone. */
    readonly map: readonly (readonly [number, number])[];
    readonly pedal: readonly Interval[];
    readonly soft: readonly Interval[];
};

export type RenderedPass = {
    readonly midi: MidiFile;
    /** From the first strike to the last release. */
    readonly durationMs: number;
};

type PracticeSources = {
    readonly scoreMsm: string;
    readonly referenceMpmText: string;
    /** `convert(harmonic_reduction.mei)`: one part, the repeat written out, 92 880 ticks like the score. */
    readonly reductionMsm: string;
};

/** The roll's document, as the reduction can carry it. */
export const reductionMpmOf = (referenceMpm: string, reductionMsm: string): string => {
    const onsets = new Set([...reductionMsm.matchAll(/<note [^>]*\bdate="([\d.]+)"/g)].map((m) => Number(m[1])));
    return referenceMpm
        .replace(/<(articulationMap|movementMap|metricalAccentuationMap)\b[^>]*?(\/>|>[\s\S]*?<\/\1>)/g, '')
        .replace(/<ornament\b[^>]*?\bdate="([\d.]+)"[^>]*?\/>/g, (element, date: string) => onsets.has(Number(date)) ? element : '');
};

const HAND: Record<Hand, (note: Note) => boolean> = {
    both: () => true,
    rh: (n) => n.part === 0,
    lh: (n) => n.part === 1,
    melody: (n) => n.melody,
    bass: (n) => n.bass,
    outer: (n) => n.melody || n.bass,
};

const interpolate = (map: readonly (readonly [number, number])[], x: number): number => {
    if (map.length === 1) return map[0][1];
    if (x <= map[0][0]) {
        const [p, q] = [map[0], map[1]];
        return p[1] + (x - p[0]) * (q[1] - p[1]) / (q[0] - p[0]);
    }
    let lo = 0, hi = map.length - 1;
    if (x >= map[hi][0]) return map[hi][1];
    while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (map[m][0] <= x) lo = m; else hi = m;
    }
    const p = map[lo], q = map[hi];
    return p[1] + (x - p[0]) * (q[1] - p[1]) / (q[0] - p[0]);
};

const intervals = (points: readonly { milliseconds: number; value: number }[] | undefined): Interval[] => {
    const out: Interval[] = [];
    let down: number | null = null;
    for (const point of [...(points ?? [])].sort((x, y) => x.milliseconds - y.milliseconds)) {
        const isDown = point.value >= 64;
        if (isDown && down === null) down = point.milliseconds;
        else if (!isDown && down !== null) { out.push([down, point.milliseconds]); down = null; }
    }
    if (down !== null) out.push([down, Number.POSITIVE_INFINITY]);
    return out;
};

const cleanFactors = (factors: Pass['factors']): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(factors)) if (v !== undefined && Math.abs(v - 1) > 1e-6) out[k] = Math.round(v * 1000) / 1000;
    return out;
};

type PracticeRenderer = {
    render(pass: Pass): RenderedPass;
};

export const createPracticeRenderer = ({ scoreMsm, referenceMpmText, reductionMsm }: PracticeSources): PracticeRenderer => {
    const reductionMpm = reductionMpmOf(referenceMpmText, reductionMsm);
    const cache = new Map<string, Rendered>();

    const renderWhole = (pass: Pass): Rendered => {
        const factors = cleanFactors(pass.factors);
        const key = `${pass.source}|${pass.scope}|${JSON.stringify(factors)}`;
        const cached = cache.get(key);
        if (cached) {
            cache.delete(key);
            cache.set(key, cached);
            return cached;
        }

        let mpm = pass.source === 'perf' ? referenceMpmText : reductionMpm;
        if (Object.keys(factors).length) mpm = exaggerateMpm(mpm, { factors, scope: pass.scope }).mpm;
        const data = performMsmToData({ msm: pass.source === 'perf' ? scoreMsm : reductionMsm, mpm });

        const notes: Note[] = data.parts.flatMap((part, index) => part.notes.map((n) => ({
            part: index,
            pitch: n.pitch,
            velocity: n.velocity,
            date: n.date,
            duration: n.duration,
            onMs: n.milliseconds.date,
            offMs: n.milliseconds.end,
            melody: true,
            bass: true,
        })));
        for (const n of notes) {
            for (const m of notes) {
                if (m === n || m.date > n.date || n.date >= m.date + m.duration) continue;
                if (m.pitch > n.pitch) n.melody = false;
                else if (m.pitch < n.pitch) n.bass = false;
                if (!n.melody && !n.bass) break;
            }
        }

        const byDate = new Map<number, number[]>();
        for (const n of notes) {
            const at = byDate.get(n.date);
            if (at) at.push(n.onMs); else byDate.set(n.date, [n.onMs]);
        }
        const map: [number, number][] = [];
        for (const date of [...byDate.keys()].sort((x, y) => x - y)) {
            const onsets = byDate.get(date)!.sort((x, y) => x - y);
            const ms = onsets[(onsets.length - 1) >> 1];
            if (!map.length || ms > map[map.length - 1][1]) map.push([date, ms]);
        }
        const lastOff = Math.max(...notes.map((n) => n.offMs));
        if (map[map.length - 1][0] < END) map.push([END, Math.max(lastOff, map[map.length - 1][1] + 1)]);

        const controls = data.parts[0]?.controlChanges ?? [];
        const rendered: Rendered = {
            source: pass.source,
            notes,
            map,
            pedal: pass.source === 'perf' ? intervals(controls.find((c) => c.ccNumber === CC_SUSTAIN)?.points) : [],
            soft: pass.source === 'perf' ? intervals(controls.find((c) => c.ccNumber === CC_SOFT)?.points) : [],
        };
        cache.set(key, rendered);
        if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
        return rendered;
    };

    const render = (pass: Pass): RenderedPass => {
        const whole = renderWhole(pass);
        const [a, b] = pass.range;
        const msAt = (date: number) => interpolate(whole.map, date);
        const sane = whole.notes.filter((n) => Math.abs(n.onMs - msAt(n.date)) < STRAY_MS);

        let notes = sane.filter((n) => n.date >= a && n.date < b && HAND[pass.hand](n));
        if (!notes.length) notes = sane.filter((n) => n.date >= a && n.date < b);
        if (!notes.length) return { midi: midiOf([], [], []), durationMs: 0 };
        notes.sort((x, y) => x.onMs - y.onMs || x.pitch - y.pitch);

        const start = Math.min(msAt(a), notes[0].onMs);
        const endMs = b >= END ? Math.max(...notes.map((n) => n.offMs)) : msAt(b);
        const hold = endMs + RING_MS;
        const at = (ms: number) => Math.max(0, (Math.min(ms, hold) - start) * pass.timeScale);

        const struck = notes.map((n) => {
            let velocity = n.velocity * pass.vel * (whole.source === 'red' ? 0.9 : 1);
            if (pass.voice) velocity = n.melody ? velocity * 1.3 + 6 : velocity * 0.78;
            const offMs = whole.source === 'red' ? n.offMs + 60 : n.offMs;
            return {
                pitch: n.pitch,
                velocity: Math.round(Math.max(4, Math.min(127, velocity))),
                on: at(n.onMs),
                off: at(Math.max(offMs, n.onMs + 30)),
            };
        });
        // A key struck again while it is still down: the earlier sounding ends just before.
        const lastByPitch = new Map<number, { on: number; off: number }>();
        for (const note of struck) {
            const previous = lastByPitch.get(note.pitch);
            if (previous && previous.off > note.on - 4) previous.off = Math.max(previous.on + 20, note.on - 4);
            lastByPitch.set(note.pitch, note);
        }

        const clip = (iv: readonly Interval[]): Interval[] => iv
            .filter(([down, up]) => up > start && down < hold)
            .map(([down, up]) => [at(Math.max(down, start)), at(up)]);

        const durationMs = (hold - start) * pass.timeScale;
        return { midi: midiOf(struck, clip(whole.pedal), clip(whole.soft)), durationMs };
    };

    return { render };
};

type Struck = { readonly pitch: number; readonly velocity: number; readonly on: number; readonly off: number };

/** One tick to the millisecond: 1000 ticks a beat at one beat a second. */
const midiOf = (notes: readonly Struck[], pedal: readonly Interval[], soft: readonly Interval[]): MidiFile => {
    type Timed = { at: number; order: number; event: AnyEvent };
    const timed: Timed[] = [];
    const control = (at: number, controllerType: number, value: number) => timed.push({
        at: Math.round(at), order: 1,
        event: { deltaTime: 0, type: 'channel', subtype: 'controller', channel: 0, controllerType, value },
    });
    for (const n of notes) {
        timed.push({ at: Math.round(n.on), order: 2, event: { deltaTime: 0, type: 'channel', subtype: 'noteOn', channel: 0, noteNumber: n.pitch, velocity: n.velocity } });
        timed.push({ at: Math.round(n.off), order: 0, event: { deltaTime: 0, type: 'channel', subtype: 'noteOff', channel: 0, noteNumber: n.pitch, velocity: 0 } });
    }
    for (const [down, up] of pedal) { control(down, CC_SUSTAIN, 127); control(up, CC_SUSTAIN, 0); }
    for (const [down, up] of soft) { control(down, CC_SOFT, 127); control(up, CC_SOFT, 0); }
    // At one instant: keys up, then the pedal, then keys down.
    timed.sort((x, y) => x.at - y.at || x.order - y.order);

    const track: AnyEvent[] = [{ deltaTime: 0, type: 'meta', subtype: 'setTempo', microsecondsPerBeat: 1_000_000 }];
    let previous = 0;
    for (const { at, event } of timed) {
        track.push({ ...event, deltaTime: at - previous });
        previous = at;
    }
    track.push({ deltaTime: 0, type: 'meta', subtype: 'endOfTrack' });
    return { header: { formatType: 0, trackCount: 1, ticksPerBeat: 1000 }, tracks: [track] };
};
