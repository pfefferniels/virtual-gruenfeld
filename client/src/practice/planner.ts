/**
 * What Grünfeld practises when nobody is in the room.
 *
 * A session on the whole of *Träumerei*, planned in advance from a seed: he works from top to
 * bottom, goes back over the spots where his own playing on the roll is most extreme, and in
 * between checks the harmony on the reduction, sped up. About sixty passes.
 *
 * He never plays anything the same way twice, nor ever plainly as on the roll. Every pass drives
 * two to four dimensions of the roll's own expression hard, between {@link STRONG} and {@link CAP},
 * and leaves the rest a little above the roll, never below it. Of 24 candidates he takes the one
 * furthest from everything he has already played over the same bars.
 *
 * Ported from the "Grünfeld übt" simulation, where these numbers were tuned by ear and against
 * espressivo 0.11.0 over 200 generated sessions.
 */

const PPQ = 720;
export const BAR = 4 * PPQ;
/** A phrase with its upbeat: four bars. */
const PHRASE = 4 * BAR;
const HALF = 2 * BAR;
/** The upbeat, bars 1–8, their written-out repeat, 9–16 and 17–24. */
export const END = 92880;
const UPBEAT = 720;

export const DIMENSIONS = [
    'tempo', 'tempoShape', 'dynamics', 'dynamicsShape', 'rubato', 'ornamentSpread', 'articulation', 'accentuation',
] as const;
export type Dimension = typeof DIMENSIONS[number];

const DIM_WEIGHT: Record<Dimension, number> = {
    tempo: 3, rubato: 2, dynamics: 3, tempoShape: 1.2, ornamentSpread: 1.6, articulation: 1, accentuation: 1, dynamicsShape: 1,
};

/** Where a dimension that leads an interpretation starts. */
const STRONG: Record<Dimension, number> = {
    tempo: 1.8, tempoShape: 2.5, dynamics: 2.5, dynamicsShape: 2.5, rubato: 3, ornamentSpread: 1.6, articulation: 2.5, accentuation: 2,
};

/**
 * As far as the renderer stays musical. Global tempo beyond 3 stretches a phrase to 58× its
 * length, accentuation beyond 3.5 drives velocities negative, dynamics at 5 already spans velocity
 * 4–127, and ornamentSpread beyond 2.2 throws notes out of place in espressivo 0.11.0.
 */
const CAP: Record<Dimension, number> = {
    tempo: 3, tempoShape: 7, dynamics: 5, dynamicsShape: 5, rubato: 10, ornamentSpread: 2.2, articulation: 6, accentuation: 3.5,
};
const CAP_GESTURE_TEMPO = 4;

const CHARACTER: Record<Dimension, string> = {
    tempo: 'dragging and rushing', tempoShape: 'bent ritardandi', dynamics: 'huge swells', dynamicsShape: 'steep crescendi',
    rubato: 'deep rubato', ornamentSpread: 'wide arpeggios', articulation: 'exaggerated touch', accentuation: 'heavy accents',
};

/** The reduction carries the roll's tempo, dynamics and rubato maps and the arpeggios on its chords. */
const REDUCTION_DIMENSIONS: readonly Dimension[] = ['tempo', 'tempoShape', 'dynamics', 'dynamicsShape', 'rubato', 'ornamentSpread'];

export type Hand = 'both' | 'rh' | 'lh' | 'melody' | 'bass' | 'outer';

export type Pass = {
    readonly source: 'perf' | 'red';
    /** [from, to) in ticks. */
    readonly range: readonly [number, number];
    readonly factors: Partial<Record<Dimension, number>>;
    readonly scope: 'global' | 'gesture';
    readonly hand: Hand;
    /** Above 1 slower, below 1 quicker. A reduction carries 1 / its speed-up here. */
    readonly timeScale: number;
    readonly vel: number;
    /** The melody brought out over the rest. */
    readonly voice: boolean;
    /** The two leading dimensions, in words. */
    readonly character: string;
    /** How much faster than the roll a reduction is played. */
    readonly speed?: number;
    /** Seconds of silence after the pass. */
    readonly pause: number;
};

export type EpisodeKind = 'read' | 'loop' | 'zoom' | 'phrase' | 'join' | 'reduction' | 'run' | 'whole';

export type Episode = {
    readonly kind: EpisodeKind;
    readonly from: number;
    readonly to: number;
    readonly title: string;
    readonly passes: readonly Pass[];
};

// ---------- randomness ----------

type Random = () => number;

/** mulberry32: small, fast and the same in every engine, so a seed names a session. */
const rng = (seed: number): Random => {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};
const uniform = (R: Random, lo: number, hi: number) => lo + (hi - lo) * R();
const integer = (R: Random, lo: number, hi: number) => lo + Math.floor(R() * (hi - lo + 1));
const pick = <T>(R: Random, items: readonly T[]): T => items[Math.floor(R() * items.length)];
const logUniform = (R: Random, lo: number, hi: number) => Math.exp(uniform(R, Math.log(lo), Math.log(Math.max(lo, hi))));
const weighted = <T>(R: Random, items: readonly T[], weight: (item: T) => number): T => {
    const total = items.reduce((sum, item) => sum + weight(item), 0);
    let r = R() * total;
    for (const item of items) {
        r -= weight(item);
        if (r <= 0) return item;
    }
    return items[items.length - 1];
};
const pickDimensions = (R: Random, n: number, from: readonly Dimension[]): Dimension[] => {
    const out: Dimension[] = [];
    while (out.length < n) out.push(weighted(R, from.filter((d) => !out.includes(d)), (d) => DIM_WEIGHT[d]));
    return out;
};
const breath = (R: Random) => 0.6 + R() * 1.1;

// ---------- where the roll is most extreme ----------

type Instruction = { readonly date: number; readonly attrs: Readonly<Record<string, string>> };

/** The dated elements of one kind, in date order. Read with a pattern so it runs without a DOM. */
const instructions = (mpm: string, tag: string): Instruction[] => {
    const out: Instruction[] = [];
    for (const match of mpm.matchAll(new RegExp(`<${tag}\\b([^>]*?)/?>`, 'g'))) {
        const attrs: Record<string, string> = {};
        for (const [, name, value] of match[1].matchAll(/([\w.:]+)="([^"]*)"/g)) attrs[name] = value;
        if (attrs.date !== undefined) out.push({ date: Number(attrs.date), attrs });
    }
    return out.sort((x, y) => x.date - y.date);
};

const numbers = (instruction: Instruction, a: string, b: string): number[] =>
    [Number(instruction.attrs[a]), Number(instruction.attrs[b] ?? instruction.attrs[a])];

/**
 * How extreme the roll is in each of the 32 bars (repeat written out): its tempo spread on a log
 * scale, its dynamic range, how much rubato and how many arpeggios. The spots he goes back to are
 * drawn in proportion to this.
 */
export const interestOf = (referenceMpm: string): number[] => {
    const tempo = instructions(referenceMpm, 'tempo');
    const dynamics = instructions(referenceMpm, 'dynamics');
    const rubato = instructions(referenceMpm, 'rubato');
    const ornament = instructions(referenceMpm, 'ornament');

    const tempoSpread = (a: number, b: number) => {
        const values: number[] = [];
        const before = tempo.filter((t) => t.date <= a).pop();
        if (before) values.push(...numbers(before, 'bpm', 'transition.to'));
        for (const t of tempo) if (t.date >= a && t.date < b) values.push(...numbers(t, 'bpm', 'transition.to'));
        const logs = values.filter((v) => v > 0).map(Math.log);
        return logs.length ? Math.max(...logs) - Math.min(...logs) : 0;
    };

    const out: number[] = [];
    for (let k = 1; k <= 32; k++) {
        const a = (k - 1) * BAR, b = k * BAR;
        const volumes = dynamics.filter((d) => d.date >= a && d.date < b).flatMap((d) => numbers(d, 'volume', 'transition.to'));
        const dynamicSpread = volumes.length ? (Math.max(...volumes) - Math.min(...volumes)) / 14 : 0;
        const rubatos = rubato.filter((r) => r.date >= a && r.date < b).length;
        const arpeggios = ornament.filter((o) => o.date >= a && o.date < b && Number(o.attrs.scale) > 0).length;
        out.push(0.08 + tempoSpread(a, b) + dynamicSpread + 0.12 * rubatos + 0.04 * arpeggios);
    }
    return out;
};

// ---------- never the same way twice ----------

type Candidate = Omit<Pass, 'range' | 'pause' | 'source'>;

const overlaps = (x: readonly [number, number], y: readonly [number, number]) => x[0] < y[1] && y[0] < x[1];

const distance = (x: Candidate, y: Candidate): number => {
    let s = 0;
    for (const d of DIMENSIONS) s += Math.abs(Math.log(x.factors[d] ?? 1) - Math.log(y.factors[d] ?? 1));
    if (x.scope !== y.scope) s += 0.6;
    if (x.hand !== y.hand) s += 1.5;
    if (x.voice !== y.voice) s += 0.5;
    s += 2 * Math.abs(Math.log(x.timeScale) - Math.log(y.timeScale));
    s += 2 * Math.abs(Math.log(x.vel) - Math.log(y.vel));
    return s;
};

type CandidateOptions = { dims?: readonly Dimension[]; hand?: Hand; handFree?: boolean };

const candidate = (R: Random, options: CandidateOptions): Candidate => {
    const dims = options.dims ?? DIMENSIONS;
    const leads = pickDimensions(R, Math.min(dims.length, integer(R, 2, 4)), dims);
    const factors: Partial<Record<Dimension, number>> = {};
    const scope = dims.includes('tempo') && R() < 0.55 ? 'gesture' : 'global';
    for (const d of dims) {
        const cap = d === 'tempo' && scope === 'gesture' ? CAP_GESTURE_TEMPO : CAP[d];
        if (leads.includes(d)) factors[d] = +logUniform(R, STRONG[d], cap).toFixed(3);
        else if (R() < 0.6) factors[d] = +logUniform(R, 1.05, STRONG[d]).toFixed(3);
    }
    const slowOk = !(scope === 'global' && (factors.tempo ?? 1) > 2);
    const timeScale = R() < 0.15 ? (slowOk && R() < 0.6 ? uniform(R, 1.3, 1.9) : uniform(R, 0.72, 0.9)) : 1;
    const vel = R() < 0.15 ? pick(R, [uniform(R, 0.5, 0.7), uniform(R, 1.3, 1.6)]) : 1;
    const voice = R() < 0.2;
    const character = leads
        .sort((x, y) => Math.log(factors[y]! / STRONG[y]) - Math.log(factors[x]! / STRONG[x]))
        .slice(0, 2)
        .map((d) => CHARACTER[d])
        .join(', ');
    let hand: Hand = options.hand ?? 'both';
    if (options.handFree && R() < 0.15) hand = pick(R, ['rh', 'lh', 'melody', 'bass'] as const);
    return { factors, scope, hand, timeScale, vel, voice, character };
};

type Played = Candidate & { readonly range: readonly [number, number]; readonly speed?: number };

const freshest = (
    memory: readonly Played[],
    range: readonly [number, number],
    make: () => Candidate,
    extra: (c: Candidate, m: Played) => number = () => 0,
): Candidate => {
    const seen = memory.filter((m) => overlaps(m.range, range));
    if (!seen.length) return make();
    let best: Candidate | null = null;
    let bestDistance = -1;
    for (let i = 0; i < 24; i++) {
        const c = make();
        const nearest = Math.min(...seen.map((m) => distance(c, m) + extra(c, m)));
        if (nearest > bestDistance) { best = c; bestDistance = nearest; }
    }
    return best!;
};

// ---------- the plan ----------

/** A session's plan, from its seed and the roll's {@link interestOf}. Deterministic. */
export const makePlan = (seed: number, interest: readonly number[]): Episode[] => {
    const R = rng(seed);
    const memory: Played[] = [];
    const redMemory: Played[] = [];

    const fresh = (range: readonly [number, number], options: CandidateOptions = {}): Pass => {
        const c = freshest(memory, range, () => candidate(R, options));
        memory.push({ ...c, range });
        return { ...c, source: 'perf', range, pause: 0 };
    };

    // Sped up 1.8–5×, sometimes faster and faster.
    const freshReduction = (a: number, b: number, n: number, ladder: boolean): Pass[] => {
        const out: Pass[] = [];
        let speed = logUniform(R, 1.8, 3.2);
        for (let i = 0; i < n; i++) {
            if (i > 0) speed = ladder ? Math.min(5, speed * uniform(R, 1.18, 1.4)) : logUniform(R, 1.8, 5);
            const at = speed;
            const c = freshest(
                redMemory, [a, b],
                () => ({ ...candidate(R, { dims: REDUCTION_DIMENSIONS }), hand: pick(R, ['both', 'both', 'outer'] as const), timeScale: 1, vel: 1, voice: false }),
                (_, m) => 2 * Math.abs(Math.log((m.speed ?? 1) / at)),
            );
            redMemory.push({ ...c, range: [a, b], speed });
            out.push({ ...c, source: 'red', range: [a, b], speed, timeScale: 1 / speed, pause: breath(R) });
        }
        return out;
    };

    const episodes: Episode[] = [];
    const add = (episode: Episode) => {
        const last = episode.passes.length - 1;
        episodes.push({
            ...episode,
            passes: episode.passes.map((p, i) => ({
                ...p,
                pause: (p.source === 'red' ? p.pause : breath(R)) + (i === last ? 1.4 + R() * 1.6 : 0),
            })),
        });
    };
    const reduction = (a: number, b: number, title?: string, n = integer(R, 1, 3)): Episode => {
        const ladder = n > 1 && R() < 0.5;
        const passes = freshReduction(a, b, n, ladder);
        return {
            kind: 'reduction', from: a, to: b, passes,
            title: title ?? (ladder ? 'harmonic reduction, faster and faster' : `harmonic reduction, ${passes[0].speed!.toFixed(1)}× faster`),
        };
    };

    if (R() < 0.5) add(reduction(0, END, 'first, the harmony of the whole piece', 1));
    for (let p = 0; p < 8; p++) {
        const a = p * PHRASE, b = p === 7 ? END : (p + 1) * PHRASE;
        const repeat = p === 2 || p === 3;
        if (p > 0 && p !== 2 && R() < 0.25) {
            add({ kind: 'join', from: a - HALF, to: a + HALF, title: 'running into the next phrase', passes: [fresh([a - HALF, a + HALF])] });
        }
        if (R() < (repeat ? 0.3 : 0.45)) add(reduction(a, b, 'the harmony of the phrase, quickly', integer(R, 1, 2)));
        if (!repeat && R() < 0.25) {
            add({ kind: 'read', from: a, to: b, title: 'reading it hands separately', passes: [fresh([a, b], { hand: 'rh' }), fresh([a, b], { hand: 'lh' })] });
        } else {
            add({ kind: 'read', from: a, to: b, title: repeat ? 'the repeat, another way' : (p === 0 ? 'from the top' : 'reading on'), passes: [fresh([a, b])] });
        }

        // spots: where the roll itself is most extreme, one or two bars
        const spots: [number, number][] = [[0, 2], [2, 4], [1, 3], [0, 1], [1, 2], [2, 3], [3, 4]];
        const score = ([i, j]: [number, number]) => {
            let s = 0;
            for (let c = i; c < j; c++) s += interest[4 * p + c];
            return Math.pow(s / Math.sqrt(j - i), 2);
        };
        const nSpots = repeat ? (R() < 0.5 ? 1 : 0) : (R() < 0.5 ? 2 : 1);
        const chosen: [number, number][] = [];
        while (chosen.length < nSpots) chosen.push(weighted(R, spots.filter((x) => !chosen.includes(x)), score));
        chosen.sort((x, y) => x[0] - y[0]);

        for (const [i, j] of chosen) {
            const sa = a + i * BAR, sb = (p === 7 && j === 4) ? END : a + j * BAR;
            const kind = weighted(R, ['loop', 'hands', 'zoom'] as const, (k) => ({ loop: 0.55, hands: 0.2, zoom: 0.25 })[k]);
            if (kind === 'hands') {
                add({ kind: 'loop', from: sa, to: sb, title: 'hands separately, then together', passes: [fresh([sa, sb], { hand: 'rh' }), fresh([sa, sb], { hand: 'lh' }), fresh([sa, sb])] });
            } else if (kind === 'zoom') {
                const one: [number, number] | null = j - i > 1 ? (interest[4 * p + i] >= interest[4 * p + i + 1] ? [sa, sa + BAR] : [sa + BAR, sb]) : null;
                const wide: [number, number] = sa >= BAR ? [sa - BAR, sb] : [sa, Math.min(END, sb + BAR)];
                const passes = [fresh([sa, sb]), fresh(one ?? wide), fresh([sa, sb])];
                add({
                    kind: 'zoom',
                    from: Math.min(...passes.map((x) => x.range[0])),
                    to: Math.max(...passes.map((x) => x.range[1])),
                    title: one ? 'narrowing in and widening out' : 'widening out and narrowing in',
                    passes,
                });
            } else {
                const n = integer(R, 2, 4);
                const passes: Pass[] = [];
                for (let k = 0; k < n; k++) passes.push(fresh([sa, sb], { handFree: true }));
                add({ kind: 'loop', from: sa, to: sb, title: `${['', '', 'two', 'three', 'four'][n]} ways through it`, passes });
            }
        }

        if (R() < 0.35) add({ kind: 'phrase', from: a, to: b, title: 'the phrase again, differently', passes: [fresh([a, b])] });
        if (p % 2 === 1) {
            const sa = (p - 1) * PHRASE;
            if (p !== 3 || R() < 0.4) add(reduction(sa, b));
            if (R() < 0.7) {
                add({ kind: 'run', from: sa, to: b, title: p === 3 ? 'bars 1–8 once more, with the repeat' : 'the section in one go', passes: [fresh([sa, b])] });
            }
        }
    }
    if (R() < 0.5) add(reduction(0, END, 'the harmony of the whole piece', 1));
    add({ kind: 'whole', from: 0, to: END, title: 'the whole piece, one last new way', passes: [fresh([0, END])] });
    return episodes;
};

// ---------- in words ----------

const barOf = (d: number) => d < UPBEAT ? 0 : Math.min(32, Math.floor((d - UPBEAT) / BAR) + 1);
const scoreBar = (k: number) => k <= 8 ? k : k - 8;
const isRepeat = (k: number) => k >= 9 && k <= 16;

/** "Bars 5–6", "Bars 7–8 → 1–2 (repeat)", "Whole piece". */
export const rangeLabel = (from: number, to: number): string => {
    if (from === 0 && to === END) return 'Whole piece';
    const k1 = barOf(Math.min(from + UPBEAT, END - 1)), k2 = barOf(to - 1);
    const segments: { from: number; to: number; repeat: boolean }[] = [];
    for (let k = Math.max(1, k1); k <= k2; k++) {
        const s = scoreBar(k), repeat = isRepeat(k), last = segments[segments.length - 1];
        if (last && last.repeat === repeat && s === last.to + 1) last.to = s;
        else segments.push({ from: s, to: s, repeat });
    }
    const one = segments.length === 1 && segments[0].from === segments[0].to;
    return (one ? 'Bar ' : 'Bars ') + segments
        .map((s) => (s.from === s.to ? `${s.from}` : `${s.from}–${s.to}`) + (s.repeat ? ' (repeat)' : ''))
        .join(' → ');
};
