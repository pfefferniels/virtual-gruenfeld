/**
 * The fitter, measured against the one performance whose answer is known.
 *
 * Four of DESIGN §5's tests live here. The load-bearing one is **test 3, the identity take**:
 * render Grünfeld's own document, hand the result back to the fitter as if a student had
 * played it, and ask how far the fitted numbers land from the numbers that produced them. That
 * distance is not the student's — it is the *procedure's*, and risk R2 is the observation that
 * Grünfeld's sixty `<tempo>` elements were drawn by hand in an editor while the student's are
 * solved from onsets, so the two are not the same kind of number even when the playing is
 * identical. The figures below are committed so that every later change to the fitter has to
 * say what it did to them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    ARTICULATION_MAP,
    DYNAMICS_MAP,
    METRICAL_ACCENTUATION_MAP,
    Mpm,
    ORNAMENTATION_MAP,
    RUBATO_MAP,
    TEMPO_MAP,
    allChildElements,
    compareMpm,
    performMsmToData,
    type Element,
} from 'espressivo';
import { describe, expect, it } from 'vitest';
import { cutPairToRange } from '../mpm/cut';
import { parseReferenceMpm } from '../mpm/reference';
import type { Range } from '../mpm/types';
import { measuredNotesFromPerformanceData, type MeasuredNote } from '../score/measured';
import { convert } from '../services/mpmRenderer';
import { PPQ } from '../shared/constants';
import {
    RUBATO_MIN_GAIN,
    TEMPO_WINDOW_TICKS,
    fitSpanDuration,
    fitStudent,
    goldenSection,
    spansOf,
    warpFromFrames,
    type FitOptions,
    type FitResult,
    type LegacyType,
    type Levels,
    type SkippedSlot,
    type SlotSpan,
} from './fit';
import { calculateRubatoOnDate, tempoClock } from './residual';
import { readScaffold, type Scaffold, type Slot } from './scaffold';

const load = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const referenceText = load('../../public/performance.mpm');
const scoreMsm = convert(load('../../public/score.mei'));
const reference = parseReferenceMpm(referenceText);

/** The four-bar take the cut and scaffold suites also use: m5.1 to m9.1. */
const TAKE: Range = { from: 11520, to: 23040 };
/** An eight-bar take, for the budget. */
const LONG_TAKE: Range = { from: 11520, to: 34560 };

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/**
 * Grünfeld's own performance, played back as if a student had produced it.
 *
 * `expandOrnaments: false` throughout, on both this and the fitter's residual renders: a v3
 * ornament that generated notes would put notes in the render that no measurement holds. The
 * v2 ornaments that make up this reconstruction are unaffected by the flag, so the rolls the
 * fitter has to find are all still there.
 */
const identityTake = (range: Range): MeasuredNote[] => {
    const data = performMsmToData({ msm: scoreMsm, mpm: referenceText }, { expandOrnaments: false });
    return measuredNotesFromPerformanceData(data).filter(
        (note) => note.date >= range.from && note.date < range.to,
    );
};

// ── reading a document back, by the ids both sides share ─────────────────────────────────

/**
 * Every instruction of one map by `xml:id`, with the def it names dereferenced.
 *
 * This is a test-local reader, not the production pairing — `mpm/pair.ts` is S4's. What it
 * shows is that the pairing S4 will do is a `Map` lookup and nothing more: the two documents
 * carry the same ids because the student's were read off the reference.
 */
const instructionsOf = (mpmText: string, mapName: string, elementName: string) => {
    const mpm = new Mpm(mpmText);
    const performance = mpm.getPerformance(0);
    const global = performance?.getGlobal();
    const map = global?.getDated()?.getMap(mapName) ?? null;
    const header = global?.getHeader() ?? null;

    const defs = new Map<string, Element>();
    for (const collection of header ? allChildElements(header.getXml()) : []) {
        for (const styleDef of allChildElements(collection)) {
            for (const def of allChildElements(styleDef)) {
                const name = def.getAttributeValue('name');
                if (name !== null) defs.set(name, def);
            }
        }
    }

    const read = (element: Element, attribute: string, into: Record<string, number>): void => {
        const raw = element.getAttributeValue(attribute);
        if (raw !== null && raw.trim() !== '' && Number.isFinite(Number(raw))) into[attribute] = Number(raw);
    };

    const found = new Map<string, Record<string, number>>();
    for (let index = 0; map && index < map.size(); index++) {
        const element = map.getElement(index);
        if (!element || element.getLocalName() !== elementName) continue;

        const values: Record<string, number> = {};
        for (const attribute of ['bpm', 'transition.to', 'volume', 'intensity', 'scale']) {
            read(element, attribute, values);
        }

        const def = defs.get(element.getAttributeValue('name.ref') ?? '');
        if (def) {
            for (const attribute of ['relativeDuration', 'relativeVelocity']) read(def, attribute, values);
            for (const child of allChildElements(def, 'temporalSpread')) {
                read(child, 'frameLength', values);
                read(child, 'intensity', values);
            }
        }

        found.set(element.getAttributeValue('id', XML_NS) ?? '', values);
    }
    return found;
};

/** The largest per-attribute distance between two documents, over the instructions they share. */
const worstDelta = (
    refText: string,
    stuText: string,
    mapName: string,
    elementName: string,
): { paired: number; deltas: Record<string, number> } => {
    const ref = instructionsOf(refText, mapName, elementName);
    const stu = instructionsOf(stuText, mapName, elementName);
    const deltas: Record<string, number> = {};
    let paired = 0;

    for (const [id, student] of stu) {
        const grünfeld = ref.get(id);
        if (!grünfeld) continue;
        paired++;
        for (const [attribute, value] of Object.entries(student)) {
            const theirs = grünfeld[attribute];
            if (typeof theirs !== 'number') continue;
            const delta = Math.abs(value - theirs);
            deltas[attribute] = Math.max(deltas[attribute] ?? 0, delta);
        }
    }
    return { paired, deltas };
};

const compare = (stuText: string, range: Range) => {
    const { refCut, stuCut } = cutPairToRange(referenceText, stuText, range);
    return compareMpm({
        a: stuCut,
        b: refCut,
        msm: scoreMsm,
        window: { start: range.from / PPQ, end: range.to / PPQ },
    }).report;
};

// ── DESIGN §5 test 6, part 1: determinism ────────────────────────────────────────────────

describe('the same take twice', () => {
    it('is the same bytes', () => {
        const notes = identityTake(TAKE);
        const scaffold = readScaffold(reference, TAKE);

        const options: FitOptions = {};
        const once: FitResult = fitStudent(notes, scaffold, scoreMsm, options);
        const again: FitResult = fitStudent(notes, scaffold, scoreMsm, options);

        // Byte-identical, not merely equivalent: a teacher whose judgement of one take changes
        // between two runs of the same take is not a teacher (semantics 5). Every annealing
        // run is seeded from the points it fits, every id is read off the reference, and every
        // written attribute is rounded at the write boundary.
        expect(again.studentMpmText).toBe(once.studentMpmText);
        expect(again.levels).toEqual(once.levels);
        expect([...again.filled].sort()).toEqual([...once.filled].sort());
        expect(again.skipped).toEqual(once.skipped);
    });

    it('does not consume the take it was handed', () => {
        const notes = identityTake(TAKE);
        const before = JSON.stringify(notes);
        fitStudent(notes, readScaffold(reference, TAKE), scoreMsm);
        // The ornament stage collapses rolled chords onto one onset; it does so on a copy,
        // which is the only reason the two runs above can agree (semantics 30).
        expect(JSON.stringify(notes)).toBe(before);
    });
});

// ── what the document says ───────────────────────────────────────────────────────────────

describe('the document the fitter writes', () => {
    const notes = identityTake(TAKE);
    const scaffold = readScaffold(reference, TAKE);
    const result = fitStudent(notes, scaffold, scoreMsm);
    const student = new Mpm(result.studentMpmText);

    it('measures six of the seven dimensions, and never asynchrony', () => {
        const measured: LegacyType[] = [...result.filled].sort();
        expect(measured).toEqual([
            'accentuationPattern',
            'articulation',
            'dynamics',
            'ornament',
            'rubato',
            'tempo',
        ]);
        expect(result.filled.has('asynchrony')).toBe(false);
        expect(result.studentMpmText).not.toContain('asynchronyMap');
    });

    it('declares one global performance and no <part>', () => {
        // `sharedCurves` returns null when the two sides' part scopes disagree, and the part
        // count multiplies every distance the comparison reports.
        expect(student.size()).toBe(1);
        const performance = student.getPerformance(0);
        expect(performance?.getPulsesPerQuarter()).toBe(PPQ);
        expect(performance?.getAllParts()).toHaveLength(0);
        expect(result.studentMpmText).not.toContain('<part ');
    });

    it('writes into Grünfeld’s slots, under Grünfeld’s ids', () => {
        for (const [mapName, elementName] of [
            [TEMPO_MAP, 'tempo'],
            [DYNAMICS_MAP, 'dynamics'],
            [RUBATO_MAP, 'rubato'],
            [METRICAL_ACCENTUATION_MAP, 'accentuationPattern'],
            [ARTICULATION_MAP, 'articulation'],
            [ORNAMENTATION_MAP, 'ornament'],
        ] as const) {
            const ref = instructionsOf(referenceText, mapName, elementName);
            const stu = instructionsOf(result.studentMpmText, mapName, elementName);
            expect(stu.size).toBeGreaterThan(0);
            // every id the student wrote is one the reference already prints — the join key
            // was read, not manufactured
            for (const id of stu.keys()) expect(ref.has(id)).toBe(true);
        }
    });

    it('reproduces the reference’s style switches, so every @name.ref resolves', () => {
        expect(result.studentMpmText).toContain('<ornamentationStyles>');
        expect(result.studentMpmText).toContain('<articulationStyles>');
        expect(result.studentMpmText).toContain('<metricalAccentuationStyles>');
        expect(result.studentMpmText).toContain('name="performance_style"');
        // the two maps the reference switches style in, and not the third
        const map = (name: string) =>
            result.studentMpmText.slice(
                result.studentMpmText.indexOf(`<${name}>`),
                result.studentMpmText.indexOf(`</${name}>`),
            );
        expect(map('ornamentationMap')).toContain('<style ');
        expect(map('metricalAccentuationMap')).toContain('<style ');
        expect(map('articulationMap')).not.toContain('<style ');
    });

    it('reports the student’s own levels, for the counter-performance’s pivot', () => {
        const levels: Levels = result.levels;
        expect(levels).toBe(result.levels);
        expect(result.levels.student.bpm.length).toBeGreaterThan(3);
        expect(result.levels.student.volume.length).toBeGreaterThan(3);
        for (const bpm of result.levels.student.bpm) expect(bpm).toBeGreaterThan(20);
        for (const volume of result.levels.student.volume) {
            expect(volume).toBeGreaterThan(0);
            expect(volume).toBeLessThanOrEqual(127);
        }
    });

    it('rounds at the write boundary, so two runs can agree byte for byte', () => {
        for (const [, values] of instructionsOf(result.studentMpmText, TEMPO_MAP, 'tempo')) {
            expect(values['bpm']).toBeCloseTo(Number(values['bpm'].toFixed(3)), 10);
        }
        for (const [, values] of instructionsOf(result.studentMpmText, DYNAMICS_MAP, 'dynamics')) {
            expect(values['volume']).toBeCloseTo(Number(values['volume'].toFixed(2)), 10);
        }
        // Only what the fitter *writes*: the accentuation pattern shapes in the header are
        // Grünfeld's own numbers, copied verbatim, and rounding them would change his pattern.
        const dated = result.studentMpmText.slice(result.studentMpmText.indexOf('<dated>'));
        expect(dated).not.toMatch(/\b\d+\.\d{6,}/);
        const written = result.studentMpmText.slice(
            0,
            result.studentMpmText.indexOf('<metricalAccentuationStyles>'),
        );
        expect(written).not.toMatch(/\b\d+\.\d{6,}/);
    });
});

// ── DESIGN §5 test 3: the identity take, and the bias it exposes ─────────────────────────

describe('the identity take (the procedure-bias fixture, risk R2)', () => {
    const notes = identityTake(TAKE);
    const result = fitStudent(notes, readScaffold(reference, TAKE), scoreMsm);

    /**
     * The diff's own noise floor, copied from `mpm/diff.ts`. Below it a difference is
     * measurement rather than playing — which is exactly the claim being tested here, since on
     * this take there *is* no difference in playing.
     */
    const THRESHOLDS: Record<string, number> = {
        volume: 4,
        bpm: 4,
        'transition.to': 4,
        relativeDuration: 0.05,
        relativeVelocity: 0.05,
        intensity: 0.1,
        scale: 0.1,
        frameLength: 50,
    };

    /**
     * The committed bias. Each bound is the measured figure with a little headroom; the
     * threshold beside it is what DESIGN assumed the figure would sit under.
     *
     * **It does not.** Tempo is the whole story: Grünfeld's curve swings between 37 and 89 bpm
     * inside a single bar, and its `@bpm` is the *instantaneous* value an editor drew at a
     * boundary, while the student's is solved from onsets that carry that tempo, a rubato warp
     * and a rolled chord at once. Read over a whole rubato frame the warp cancels (see
     * `localBpm`) but the curve is smoothed, and no window setting escapes both: the sweep runs
     * 6.3–8.3 JND with the minimum at one frame. Everything else is within a factor of two of
     * its floor or below it.
     */
    it.each([
        ['tempo', TEMPO_MAP, 'tempo', 7, { bpm: 24, 'transition.to': 15 }],
        ['dynamics', DYNAMICS_MAP, 'dynamics', 10, { volume: 5, 'transition.to': 5 }],
        ['rubato', RUBATO_MAP, 'rubato', 5, { intensity: 0.25 }],
        ['accentuation', METRICAL_ACCENTUATION_MAP, 'accentuationPattern', 6, { scale: 5.5 }],
        ['articulation', ARTICULATION_MAP, 'articulation', 9, { relativeDuration: 1.6 }],
        ['ornament', ORNAMENTATION_MAP, 'ornament', 10, { frameLength: 60, intensity: 0.05, scale: 3.5 }],
    ])('%s: the fitted values land within the committed bias', (_name, mapName, elementName, minPaired, bounds) => {
        const { paired, deltas } = worstDelta(referenceText, result.studentMpmText, mapName, elementName);
        expect(paired).toBeGreaterThanOrEqual(minPaired as number);
        for (const [attribute, bound] of Object.entries(bounds as Record<string, number>)) {
            expect(deltas[attribute]).toBeLessThan(bound);
        }
    });

    it('states, for the record, which attributes clear the diff’s noise floor', () => {
        // Committed as a table rather than as prose: an attribute that moves from one column to
        // the other is a change in what the teacher will say about a student who played
        // Grünfeld's own performance back at it.
        const over: string[] = [];
        const under: string[] = [];
        for (const [mapName, elementName] of [
            [TEMPO_MAP, 'tempo'],
            [DYNAMICS_MAP, 'dynamics'],
            [RUBATO_MAP, 'rubato'],
            [METRICAL_ACCENTUATION_MAP, 'accentuationPattern'],
            [ARTICULATION_MAP, 'articulation'],
            [ORNAMENTATION_MAP, 'ornament'],
        ] as const) {
            const { deltas } = worstDelta(referenceText, result.studentMpmText, mapName, elementName);
            for (const [attribute, delta] of Object.entries(deltas)) {
                const floor = THRESHOLDS[attribute];
                if (floor === undefined) continue;
                (delta >= floor ? over : under).push(`${elementName}.${attribute}`);
            }
        }
        expect(under).toContain('ornament.intensity');
        // Everything else is over the floor. Risk R2's stated fallback — fitting the reference
        // through this same procedure and comparing fit against fit — is what this number is
        // for; the decision belongs to the slice that owns the comparison.
        expect(over.length).toBeGreaterThan(0);
    });

    /**
     * DESIGN §5 test 2, the round trip: `fitStudent(render(perf))` against `perf`, as a
     * tolerance and never as equality. The design's target was 2 JND. The measured figure is
     * ~9.4, of which tempo alone is ~6.6 — the same bias the table above states in raw units,
     * seen through the metric.
     */
    it('round-trips to a committed distance, dominated by tempo', () => {
        const report = compare(result.studentMpmText, TAKE);

        expect(report.aggregate.mean).toBeLessThan(11);
        expect(report.dimensions.tempo.mean).toBeLessThan(7.5);
        expect(report.dimensions.ornamentation.mean).toBeLessThan(2.5);
        // Below one JND — inaudible, which is what the comparison's own gate is for.
        expect(report.dimensions.dynamics.mean).toBeLessThan(1);
        expect(report.dimensions.rubato.mean).toBeLessThan(1);
        expect(report.dimensions.accentuation.mean).toBeLessThan(1);
    });

    it('has no systematic direction — the bias is noise around the curve, not a shift', () => {
        const report = compare(result.studentMpmText, TAKE);
        // `meanSigned > 0` would mean the fitter reads Grünfeld as consistently faster or
        // louder than he was, which would make every take's verdict lean one way.
        expect(Math.abs(report.dimensions.tempo.meanSigned ?? 0)).toBeLessThan(0.05);
        expect(Math.abs(report.dimensions.dynamics.meanSigned ?? 0)).toBeLessThan(0.05);
    });

    it('reproduces the playing far more closely than it reproduces the curve', () => {
        // Render the fitted document back and compare onsets: the fitter's *timing* is within
        // ~50 ms RMS, while its tempo *numbers* are ~10 bpm out. The difference between those
        // two figures is the shape of risk R2 — two ways of writing one performance.
        const back = measuredNotesFromPerformanceData(
            performMsmToData(
                { msm: scoreMsm, mpm: result.studentMpmText },
                { expandOrnaments: false },
            ),
        );
        const rendered = new Map(back.map((note) => [note['xml:id'], note]));
        const errors = notes.flatMap((note) => {
            const played = rendered.get(note['xml:id']);
            return played ? [played['milliseconds.date'] - note['milliseconds.date']] : [];
        });
        expect(errors.length).toBeGreaterThan(50);

        // The student document covers the take, not the run-up to it, so everything before it
        // renders at MPM's default tempo; the constant offset that produces is not an error.
        const offset = errors.reduce((sum, error) => sum + error, 0) / errors.length;
        const centred = errors.map((error) => error - offset);
        const rms = Math.sqrt(centred.reduce((sum, e) => sum + e * e, 0) / centred.length);
        expect(rms).toBeLessThan(60);
    });
});

// ── the pieces the stages lean on ────────────────────────────────────────────────────────

describe('spansOf', () => {
    const chordAt = (date: number) => ({ date, notes: [], onsetMs: date });
    const slotAt = (date: number, endDate: number): Slot => ({
        xmlId: `tempo_${date}`,
        mapIndex: 0,
        date,
        endDate,
    });

    it('gives each slot the span up to the next one', () => {
        const chords = [0, 360, 720, 1080, 1440, 1800].map(chordAt);
        const spans: SlotSpan<Slot>[] = spansOf([slotAt(0, 720), slotAt(720, 1440)], chords);
        expect(spans.map(({ slot, end }) => [slot.date, end])).toEqual([
            [0, 720],
            [720, 1440],
        ]);
    });

    it('widens a slot’s neighbour when the slot itself is dropped', () => {
        // The middle slot holds one chord, so nothing can be measured over it — and the slot
        // before it then prevails all the way to the third, which is the span its ramp has to
        // be fitted over. Applied slot by slot, this is where a take starts drifting.
        const chords = [0, 360, 720, 1440, 1800, 2160].map(chordAt);
        const spans = spansOf([slotAt(0, 720), slotAt(720, 1440), slotAt(1440, 2160)], chords);
        expect(spans.map(({ slot }) => slot.date)).toEqual([0, 1440]);
        expect(spans[0].end).toBe(1440);
    });

    it('ends the last span where the playing stopped, not where the reference says', () => {
        const chords = [0, 360, 720].map(chordAt);
        const spans = spansOf([slotAt(0, 5760)], chords);
        expect(spans[0].end).toBe(720);
    });

    it('answers nothing for a take with nothing in it', () => {
        expect(spansOf([slotAt(0, 720)], [])).toEqual([]);
        expect(spansOf([slotAt(0, 720)], [chordAt(0)])).toEqual([]);
    });
});

describe('fitSpanDuration', () => {
    const span = { date: 0, bpm: 60, transitionTo: 60, beatLength: 0.25, endDate: 1440 };

    it('makes the span take exactly as long as it was played', () => {
        for (const target of [1400, 2000, 2600, 4000]) {
            const fitted = fitSpanDuration(span, target, PPQ);
            const clock = tempoClock([{ tempo: fitted, anchorMs: 0 }], PPQ);
            expect(clock.msAt(1440)).toBeCloseTo(target, 6);
        }
    });

    it('keeps the shape while it corrects the level', () => {
        // Scaling both ends of a ramp scales the elapsed time and nothing else, which is why
        // the correction is one multiplication rather than a second search.
        const ramp = { ...span, transitionTo: 90 };
        const fitted = fitSpanDuration(ramp, 1200, PPQ);
        expect((fitted.transitionTo as number) / (fitted.bpm as number)).toBeCloseTo(90 / 60, 6);
    });

    it('follows the onsets inside the span when it is shown them', () => {
        // The same ramp and the same total, shown two different interiors: a midpoint that
        // arrived a third of the way through, and one that arrived two thirds. Freed from the
        // duration, `@meanTempoAt` is what tells those two apart.
        const ramp = { ...span, transitionTo: 120 };
        const where = (fraction: number): number => {
            const fitted = fitSpanDuration(ramp, 2000, PPQ, [{ date: 720, fraction }]);
            const clock = tempoClock([{ tempo: fitted, anchorMs: 0 }], PPQ);
            expect(clock.msAt(1440)).toBeCloseTo(2000, 6);
            return clock.msAt(720) / 2000;
        };
        // How far apart the two can be pulled is bounded by the two boundary tempi — the
        // exponent shapes the span, it does not overrule its ends. What matters is that the
        // interior is what decides, and in the right direction.
        expect(where(0.3)).toBeLessThan(where(0.65));
    });
});

describe('warpFromFrames', () => {
    it('is the identity where no frame was fitted', () => {
        expect(warpFromFrames([])(360)).toBe(360);
    });

    it('places a date where its own frame puts it', () => {
        const warp = warpFromFrames([{ date: 0, frameLength: 720, intensity: 2 }]);
        expect(warp(360)).toBeCloseTo(calculateRubatoOnDate(360, { date: 0, frameLength: 720, intensity: 2 }), 9);
    });

    it('leaves a date outside a non-looping frame alone', () => {
        const warp = warpFromFrames([{ date: 0, frameLength: 720, intensity: 2, loop: false }]);
        expect(warp(1080)).toBe(1080);
        expect(warp(-100)).toBe(-100);
    });

    it('takes the frame in force, where several are fitted', () => {
        const frames = [
            { date: 0, frameLength: 720, intensity: 2 },
            { date: 720, frameLength: 720, intensity: 0.5 },
        ];
        const warp = warpFromFrames(frames);
        expect(warp(1080)).toBeCloseTo(calculateRubatoOnDate(1080, frames[1]), 9);
    });
});

describe('goldenSection', () => {
    it('finds the minimum of a unimodal objective, in the same order every run', () => {
        const parabola = (x: number) => (x - 1.7) * (x - 1.7);
        expect(goldenSection(parabola, 0.1, 5)).toBeCloseTo(1.7, 5);
        expect(goldenSection(parabola, 0.1, 5)).toBe(goldenSection(parabola, 0.1, 5));
    });
});

// ── DESIGN §5 test 5: rubato and tempo, told apart (risk R5) ─────────────────────────────

/** A scaffold with no document behind it — the slots a synthetic take is fitted into. */
const syntheticScaffold = (tempoDates: number[], rubatoDates: number[], end: number): Scaffold => {
    const span = (dates: number[], i: number): number => dates[i + 1] ?? end;
    const tempo: Slot[] = tempoDates.map((date, i) => ({
        xmlId: `tempo_${date}`,
        mapIndex: i,
        date,
        endDate: span(tempoDates, i),
        beatLength: 0.25,
    }));
    const rubato: Slot[] = rubatoDates.map((date, i) => ({
        xmlId: `rubato_${date}`,
        mapIndex: i,
        date,
        endDate: date + PPQ,
        frameLength: PPQ,
        loop: false,
    }));
    return {
        range: { from: tempoDates[0], to: end },
        tempo,
        dynamics: [],
        rubato,
        accentuation: [],
        articulation: [],
        ornament: [],
        patterns: new Map(),
        styleNames: { articulation: null, ornamentation: null, metricalAccentuation: null },
        styleSwitches: [],
    };
};

/**
 * A take played at exactly `bpm`, with `rubato` warping the notes inside each of its frames.
 *
 * Built arithmetically rather than rendered, so the answer is known exactly: at 60 bpm a
 * quarter is 1000 ms, so a tick is 1000/720 ms and the warped tick *is* the onset.
 */
const syntheticTake = (
    bpm: number,
    end: number,
    warp: (date: number) => number = (date) => date,
): MeasuredNote[] => {
    const msPerTick = 60000 / bpm / PPQ;
    const notes: MeasuredNote[] = [];
    for (let date = 0; date < end; date += 180) {
        notes.push({
            'xml:id': `n${date}`,
            part: 1,
            date,
            duration: 180,
            'midi.pitch': 60,
            'milliseconds.date': warp(date) * msPerTick,
            'milliseconds.date.end': (warp(date) + 180) * msPerTick,
            velocity: 60,
        });
    }
    return notes;
};

describe('rubato and tempo, told apart (risk R5)', () => {
    const END = 5760;
    const TEMPO_DATES = [0, 1440, 2880, 4320];
    /** One rubato frame per quarter, the whole way through — as the reconstruction has it. */
    const FRAME_DATES = [0, 720, 1440, 2160, 2880, 3600, 4320, 5040];

    it('reads a known rubato as rubato, and leaves the tempo straight', () => {
        const INTENSITY = 1.6;
        const warp = (date: number): number => {
            const frameStart = Math.floor(date / PPQ) * PPQ;
            return calculateRubatoOnDate(date, {
                date: frameStart,
                frameLength: PPQ,
                intensity: INTENSITY,
            });
        };
        const scaffold = syntheticScaffold(TEMPO_DATES, FRAME_DATES, END);
        const result = fitStudent(syntheticTake(60, END, warp), scaffold, scoreMsm);

        expect(result.filled.has('rubato')).toBe(true);
        const rubatos = [...instructionsOf(result.studentMpmText, RUBATO_MAP, 'rubato')];
        expect(rubatos.length).toBe(FRAME_DATES.length);

        // Every frame the take played through comes back at the intensity it was warped with,
        // inside the diff's own noise floor for `intensity` (0.1).
        for (const [, values] of rubatos.slice(0, -2)) {
            expect(Math.abs(values['intensity'] - INTENSITY)).toBeLessThan(0.1);
        }
        // The last frames are the take's own edge: the final tempo span has to end where the
        // playing stopped, which is inside a frame rather than on one, so a little of the warp
        // is still read as tempo there. It is a boundary effect, not a bias — it reads the
        // rubato in the right direction and only understates it.
        for (const [, values] of rubatos.slice(-2)) {
            expect(values['intensity']).toBeGreaterThan(1.2);
            expect(values['intensity']).toBeLessThan(INTENSITY + 0.1);
        }

        // …and the tempo stays where it was played. Every bpm within the diff's own noise
        // floor of 60: the warp was explained by the dimension that owns it, not absorbed
        // into a ramp.
        for (const [, values] of instructionsOf(result.studentMpmText, TEMPO_MAP, 'tempo')) {
            expect(Math.abs(values['bpm'] - 60)).toBeLessThan(4);
            expect(Math.abs(values['transition.to'] - 60)).toBeLessThan(4);
        }
    });

    it('writes no rubato where the playing is straight', () => {
        const scaffold = syntheticScaffold(TEMPO_DATES, FRAME_DATES, END);
        const result = fitStudent(syntheticTake(60, END), scaffold, scoreMsm);

        // A `<rubato>` that barely improves on the identity warp is the tempo fit re-described,
        // and Grünfeld's 56 frames would otherwise all be answered whatever the student did.
        expect(result.filled.has('rubato')).toBe(false);
        expect(result.skipped.filter((slot) => slot.type === 'rubato').length).toBeGreaterThan(0);
        // The threshold that decides it, stated: a rubato has to cut the within-slot residual
        // by a fifth before it is written at all.
        expect(RUBATO_MIN_GAIN).toBe(0.2);
        for (const [, values] of instructionsOf(result.studentMpmText, TEMPO_MAP, 'tempo')) {
            expect(values['bpm']).toBeCloseTo(60, 1);
        }
    });

    it('reads a slower take as slower', () => {
        const scaffold = syntheticScaffold(TEMPO_DATES, [], END);
        const result = fitStudent(syntheticTake(48, END), scaffold, scoreMsm);
        for (const [, values] of instructionsOf(result.studentMpmText, TEMPO_MAP, 'tempo')) {
            expect(values['bpm']).toBeCloseTo(48, 1);
        }
        expect(TEMPO_WINDOW_TICKS).toBe(PPQ);
    });
});

// ── risk R1: the take that stops mid-phrase ──────────────────────────────────────────────

describe('a take that does not reach every slot (risk R1)', () => {
    it('leaves the thin slots unwritten, and says which', () => {
        const full = identityTake(TAKE);
        // The student gave up halfway through the third bar.
        const truncated = full.filter((note) => note.date < TAKE.from + 2 * 4 * PPQ);
        const result = fitStudent(truncated, readScaffold(reference, TAKE), scoreMsm);

        const unwritten: SkippedSlot[] = result.skipped.filter((slot) => slot.type === 'tempo');
        expect(unwritten.length).toBeGreaterThan(0);
        for (const slot of unwritten) expect(slot.reason).toBeTruthy();

        // Nothing was invented for the half nobody played…
        const written = instructionsOf(result.studentMpmText, TEMPO_MAP, 'tempo');
        for (const [id] of written) {
            const date = Number(id.split('_')[1]);
            expect(date).toBeLessThan(TAKE.from + 2 * 4 * PPQ);
        }
        // …and every skipped slot names an id the reference carries, so the comparison can
        // answer for that date from its own curve profile.
        const reference_ = instructionsOf(referenceText, TEMPO_MAP, 'tempo');
        for (const slot of unwritten) expect(reference_.has(slot.xmlId)).toBe(true);
    });

    it('survives a take with nothing in it', () => {
        const result = fitStudent([], readScaffold(reference, TAKE), scoreMsm);
        expect(result.filled.size).toBe(0);
        expect(result.levels.student.bpm).toEqual([]);
        expect(result.skipped.length).toBeGreaterThan(0);
        expect(result.studentMpmText).toContain('<performance');
    });

    it('survives a take of one note', () => {
        const notes = identityTake(TAKE).slice(0, 1);
        const result = fitStudent(notes, readScaffold(reference, TAKE), scoreMsm);
        expect(result.filled.has('tempo')).toBe(false);
        expect(result.studentMpmText).toContain('<performance');
    });
});

// ── risk R6: an articulationDef this version cannot answer for ───────────────────────────

describe('an articulationDef stating @absoluteDuration (risk R6)', () => {
    it('is skipped with a note rather than coerced into a ratio', () => {
        // The reference's 26 defs are 24 `relativeDuration`, 1 `absoluteDuration` and 2
        // `relativeVelocity`. A duration in ticks is not a multiplier, and reporting it as one
        // would tell a student about an articulation nobody played.
        const whole: Range = { from: 0, to: 92160 };
        const result = fitStudent(identityTake(whole), readScaffold(reference, whole), scoreMsm);

        const skippedForDef = result.skipped.filter(
            (slot) => slot.type === 'articulation' && slot.reason.includes('absoluteDuration'),
        );
        expect(skippedForDef.length).toBeGreaterThan(0);
        expect(result.studentMpmText).not.toContain('absoluteDuration');

        // The def the reference states it on is still there on the reference side; the student
        // simply has nothing to say about it.
        expect(referenceText).toContain('absoluteDuration');
    });
});

// ── the budget ───────────────────────────────────────────────────────────────────────────

describe('what one take costs', () => {
    it('fits a four- and an eight-bar take inside the evidence budget', () => {
        for (const range of [TAKE, LONG_TAKE]) {
            const notes = identityTake(range);
            const scaffold = readScaffold(reference, range);
            fitStudent(notes, scaffold, scoreMsm); // warm the memoized MEI→MSM conversion

            const started = performance.now();
            fitStudent(notes, scaffold, scoreMsm);
            const elapsed = performance.now() - started;

            const bars = (range.to - range.from) / (4 * PPQ);
             
            console.log(`fitStudent, ${bars} bars, ${notes.length} notes: ${elapsed.toFixed(1)} ms`);
            // DESIGN §3.1 budgets the fit at ~250 ms of a ~400 ms evidence pass; the bound here
            // is loose enough for a cold CI box and tight enough to catch a second render
            // creeping in.
            expect(elapsed).toBeLessThan(1000);
        }
    });
});
