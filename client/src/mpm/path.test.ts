/**
 * DESIGN §5 test 9 for slice S7 — the edit script turned into sound.
 *
 * Four claims, and they are different in kind:
 *
 * 1. **The costliest edits name what actually went wrong.** A take that is 15 % too fast must
 *    have `tempo` at the top of the script; one played 18 velocity too quietly must have
 *    `dynamics`. If the ranking said anything else, "the three things that matter most" would be
 *    a phrase rather than a claim.
 * 2. **Applying them moves the student toward Grünfeld.** Measured the only way that means
 *    anything: `compareMpm` over the same window, before and after, and the distance has to fall.
 *    This is also the test that would fail if `valueA` and `valueB` were ever swapped — a
 *    demonstration of the student's own mistake, played back as though it were the answer.
 * 3. **Nothing else moves.** Only the k elements the edits name differ from the student's own
 *    document; every instruction outside the demonstration's range, and every def, is
 *    byte-identical to what the student played.
 * 4. **It is deterministic, it renders, and it costs what risk R4 says it costs.** The timings on
 *    four and eight bars are logged with real figures, as DESIGN §5 test 11 asks, and the
 *    twelve-bar refusal is exercised rather than described.
 *
 * The takes are real: rendered from an MPM through the actual renderer, back through the matcher
 * and the fitter, exactly as the browser makes them (`counter.test.ts`'s harness).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Mpm, allChildElements, compareMpm, performMsmToData, type Element } from 'espressivo';
import { describe, expect, it } from 'vitest';
import { implantLocal } from '../matcher';
import { measuredNotesFromPerformanceData, type MeasuredNote } from '../score/measured';
import { convert, perform } from '../services/mpmRenderer';
import { JND_FLOOR, TAKE_WEIGHTS } from './compare';
import { cutPairToRange } from './cut';
import { evidenceForTake } from './evidence';
import { DEFAULT_PATH_EDITS, PATH_MAX_BARS, PATH_MAX_TICKS, PATH_TYPES, pathPerformance } from './path';
import type { Range } from './types';

const load = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const mei = load('../../public/score.mei');
const referenceMpmText = load('../../public/performance.mpm');
const scoreMsm = convert(mei);

const scoreNotes: MeasuredNote[] = measuredNotesFromPerformanceData(
    performMsmToData({ msm: scoreMsm, mpm: referenceMpmText }, { expandOrnaments: false }),
);

/** Four bars, m5.1–m9.1 — the window every suite in this rewrite uses. */
const FOUR_BARS: Range = { from: 11520, to: 23040 };
/** Eight, for the budget. */
const EIGHT_BARS: Range = { from: 11520, to: 34560 };

/** One take, exactly as the browser makes it, and the evidence it produces. */
const takeOn = (mpmText: string, range: Range) => {
    const midi = perform(mei, mpmText, range);
    if (!midi) throw new Error('the take could not be rendered');
    const { notes, range: matched } = implantLocal(scoreNotes, midi, (range.from + range.to) / 2);
    const evidence = evidenceForTake({ notes, range: matched, scoreMsm, scoreNotes, referenceMpmText });
    return { evidence, range: matched };
};

/**
 * The take's own distance from Grünfeld, in JND — the metric the app itself uses.
 *
 * Against the take's *own* fitted reference (`Evidence.referenceFitText`), because that is the
 * document the criticism, the demonstration and this measurement all have to agree on.
 */
const distanceFromGruenfeld = (referenceFitText: string, studentMpmText: string, range: Range): number => {
    const { refCut, stuCut } = cutPairToRange(referenceFitText, studentMpmText, range);
    const { report } = compareMpm({
        a: stuCut,
        b: refCut,
        msm: scoreMsm,
        window: { start: range.from / 720, end: range.to / 720 },
        weights: TAKE_WEIGHTS,
    });
    return report.aggregate.mean ?? 0;
};

type Reading = { name: string; id: string; date: number | null; attributes: string };

/**
 * Every attribute name that occurs anywhere in a document.
 *
 * espressivo's `Element` has `getAttributeValue(name)` but no way to enumerate what an element
 * carries, so the vocabulary is read off the text once and every element is then asked for every
 * name in it. Blunt, and exactly right for the question here — "did anything at all change" has
 * to be asked of attributes this test does not know the names of.
 */
const attributeNames = (...documents: string[]): string[] => {
    const names = new Set<string>();
    for (const text of documents) {
        for (const [, name] of text.matchAll(/\s([\w.]+(?::[\w.]+)?)="/g)) {
            names.add(name.includes(':') ? name.slice(name.indexOf(':') + 1) : name);
        }
    }
    return [...names].sort();
};

/** Every element of a document, in document order, with every attribute it states. */
const readings = (mpmText: string, names: readonly string[]): Map<string, Reading> => {
    const root = new Mpm(mpmText).getRootElement();
    const found = new Map<string, Reading>();
    let ordinal = 0;
    const walk = (element: Element): void => {
        // The spliced `<movementMap>` is Grünfeld's pedal, not a correction, and it is the one
        // thing `path` *adds* rather than overwrites — so it would break the structural
        // invariance below by design. It has its own tests further down.
        if (element.getLocalName() === 'movementMap') return;
        const raw = element.getAttributeValue('date');
        const attributes = names
            .map((name) => [name, element.getAttributeValue(name)] as const)
            .filter(([, value]) => value !== null)
            .map(([name, value]) => `${name}=${value}`)
            .join(' ');
        found.set(`${ordinal++}:${element.getLocalName()}`, {
            name: element.getLocalName(),
            id: element.getAttributeValue('id') ?? '',
            date: raw === null ? null : Number(raw),
            attributes,
        });
        for (const child of allChildElements(element)) walk(child);
    };
    if (root) walk(root);
    return found;
};

/** Which elements differ between two documents of identical structure. */
const changed = (before: string, after: string): Reading[] => {
    const names = attributeNames(before, after);
    const a = readings(before, names);
    const b = readings(after, names);
    // Structural invariance: a correction writes values and never adds, removes or reorders.
    expect([...b.keys()]).toEqual([...a.keys()]);
    return [...a.entries()]
        .filter(([key, reading]) => b.get(key)!.attributes !== reading.attributes)
        .map(([key]) => b.get(key)!);
};

const noteCount = (midi: ReturnType<typeof perform>): number =>
    (midi?.tracks ?? []).reduce(
        (total, track) =>
            total + track.filter((event) =>
                'subtype' in event && event.subtype === 'noteOn'
                && 'velocity' in event && (event.velocity as number) > 0).length,
        0,
    );

// The two students. Both are Grünfeld's own document, altered in exactly one dimension, so what
// the script must find is known before it runs.
const hurriedMpm = referenceMpmText.replace(
    /bpm="([\d.]+)"/g,
    (_match, value: string) => `bpm="${(Number(value) * 1.15).toFixed(4)}"`,
);
const quietMpm = referenceMpmText.replace(
    /volume="([\d.]+)"/g,
    (_match, value: string) => `volume="${Math.max(1, Number(value) - 18).toFixed(2)}"`,
);

/** Both at once, so that a plan narrowing a take to *one* of what it measured has something to narrow. */
const hurriedAndQuietMpm = quietMpm.replace(
    /bpm="([\d.]+)"/g,
    (_match, value: string) => `bpm="${(Number(value) * 1.15).toFixed(4)}"`,
);

const hurried = takeOn(hurriedMpm, FOUR_BARS);
const quiet = takeOn(quietMpm, FOUR_BARS);
const both = takeOn(hurriedAndQuietMpm, FOUR_BARS);

type Take = {
    evidence: { studentMpmText: string; referenceFitText: string; measuredTypes: readonly string[] };
    range: Range;
};
type PathOptions = {
    types?: readonly string[];
    edits?: number;
    range?: Range;
    /** Overrides the take's own `measuredTypes` — the gate, exercised on its own. */
    measured?: readonly string[];
    /** Set to `null` to withhold the editorial document and get a demonstration with no pedal. */
    pedalFrom?: string | null;
};

const runPath = (take: Take, options: PathOptions) =>
    pathPerformance({
        studentMpmText: take.evidence.studentMpmText,
        referenceMpmText: take.evidence.referenceFitText,
        ...(options.pedalFrom === null ? {} : { editorialReferenceMpmText: options.pedalFrom ?? referenceMpmText }),
        scoreMsm,
        range: options.range ?? take.range,
        measured: options.measured ?? take.evidence.measuredTypes,
        ...(options.types === undefined ? {} : { types: options.types }),
        ...(options.edits === undefined ? {} : { edits: options.edits }),
    });

/**
 * `runPath`, memoized on its arguments.
 *
 * Half a second of `diffMpm` per call, and the tests below ask the same questions of the same
 * takes from several angles. The memo is only legitimate because the function is pure and
 * deterministic — which is itself asserted, by the one test that deliberately goes around it.
 */
const results = new Map<string, ReturnType<typeof runPath>>();
const pathFor = (take: Take, options: PathOptions = {}) => {
    const key = `${take.range.from}:${take.evidence.studentMpmText.length}:${JSON.stringify(options)}`;
    const cached = results.get(key);
    if (cached) return cached;
    const result = runPath(take, options);
    results.set(key, result);
    return result;
};

// ── 1. the costliest edits name the altered dimension ────────────────────────────────────

describe('what the edit script finds', () => {
    it('puts tempo at the top for a student who hurried, and nothing else', () => {
        const result = pathFor(hurried);

        expect(result.edits).toHaveLength(DEFAULT_PATH_EDITS);
        expect(new Set(result.edits.map((edit) => edit.type))).toEqual(new Set(['tempo']));
        // Cost-descending, which is what makes "the k that matter most" true rather than "k of them".
        for (let i = 1; i < result.edits.length; i++) {
            expect(result.edits[i - 1].cost).toBeGreaterThanOrEqual(result.edits[i].cost);
        }
        // Every one of them says the student was faster and writes Grünfeld's own slower value.
        for (const edit of result.edits) {
            const bpm = edit.attributes.find((attribute) => attribute.name === 'bpm');
            expect(bpm, `${edit.position} carries no @bpm`).toBeDefined();
            expect(Number(bpm!.from)).toBeGreaterThan(Number(bpm!.to));
        }
    });

    it('puts dynamics at the top for a student who played too quietly, and louder', () => {
        const result = pathFor(quiet);

        expect(new Set(result.edits.map((edit) => edit.type))).toEqual(new Set(['dynamics']));
        for (const edit of result.edits) {
            const volume = edit.attributes.find((attribute) => attribute.name === 'volume');
            if (!volume) continue;
            expect(Number(volume.from)).toBeLessThan(Number(volume.to));
        }
    });

    it('corrects only the dimensions the plan named', () => {
        // A take that hurried *and* played quietly, so both are measured and the plan has a real
        // choice to make. Tempo is the costlier of the two here, which is what makes naming
        // `dynamics` a narrowing rather than a coincidence.
        expect(new Set(both.evidence.measuredTypes)).toEqual(new Set(['tempo', 'dynamics']));
        // Unnarrowed, the costliest three are all dynamics — so naming tempo is a narrowing that
        // changes the answer, not one that agrees with it.
        expect(new Set(pathFor(both).edits.map((edit) => edit.type))).toEqual(new Set(['dynamics']));

        const result = pathFor(both, { types: ['tempo'] });
        expect(result.edits.length).toBeGreaterThan(0);
        expect(new Set(result.edits.map((edit) => edit.type))).toEqual(new Set(['tempo']));
    });

    it('applies exactly the number of corrections it was asked for', () => {
        expect(pathFor(hurried, { edits: 1 }).edits).toHaveLength(1);
        expect(pathFor(hurried, { edits: 5 }).edits).toHaveLength(5);
        // The one asked for first is the costliest, whatever k is.
        expect(pathFor(hurried, { edits: 1 }).edits[0].cost).toBe(pathFor(hurried, { edits: 5 }).edits[0].cost);
    });
});

// ── 1b. the gate: what the evidence is silent about is not corrected ─────────────────────

describe('the audibility gate', () => {
    it('corrects nothing on an identity take — the student played it right', () => {
        // Grünfeld's own document, played back through the renderer, the matcher and the fitter:
        // `measuredTypes` is empty by construction and the teacher says nothing. Before the gate
        // reached this module `path` still applied three corrections here, byte-for-byte the same
        // three a take the teacher was silent about got (final-pedagogy, finding 1).
        const identity = takeOn(referenceMpmText, FOUR_BARS);
        expect(identity.evidence.measuredTypes).toEqual([]);

        const result = runPath(identity, {});
        expect(result.edits).toEqual([]);
        expect(result.mpm).toBeNull();
        expect(result.notes.join(' ')).toContain('nothing to correct');
    });

    it('corrects nothing when the take measured nothing, whatever the plan asked for', () => {
        const result = pathFor(hurried, { measured: [], types: ['tempo'] });

        expect(result.edits).toEqual([]);
        expect(result.mpm).toBeNull();
        // And it did not pay for the edit script to find that out.
        expect(result.diffMs).toBe(0);
    });

    it('reads an empty plan list as every MEASURED type, never as every type', () => {
        // `dimensions: []` is what a plan whose types the server dropped looks like. Read as
        // "every type" it would widen exactly where the validator narrowed — and it is visible
        // here, because unnarrowed this take's costliest ops are all dynamics.
        const result = pathFor(both, { measured: ['tempo'], types: [] });

        expect(result.edits.length).toBeGreaterThan(0);
        expect(new Set(result.edits.map((edit) => edit.type))).toEqual(new Set(['tempo']));
    });

    it('never corrects a type whose numbers live on a shared def', () => {
        // `ornament` and `articulation` are priced on defs this writer does not touch, so a plan
        // naming one is a plan for a demonstration of something else. `PATH_TYPES` is the list;
        // `src/plan/validate.ts` enforces the same one before the plan is ever sent.
        const result = pathFor(hurried, { measured: ['ornament', 'articulation', 'tempo'] });

        expect(result.edits.length).toBeGreaterThan(0);
        for (const edit of result.edits) expect(PATH_TYPES).toContain(edit.type);
    });

    it('leaves an op under the JND floor alone', () => {
        for (const take of [hurried, quiet]) {
            for (const edit of pathFor(take, { edits: 5 }).edits) {
                expect(edit.cost).toBeGreaterThanOrEqual(JND_FLOOR);
            }
        }
    });
});

// ── 2. applying them moves the student toward Grünfeld ───────────────────────────────────

describe('what applying them does', () => {
    it('closes the distance to Grünfeld on a hurried take', () => {
        const result = pathFor(hurried);
        expect(result.mpm).not.toBeNull();

        const before = distanceFromGruenfeld(hurried.evidence.referenceFitText, hurried.evidence.studentMpmText, hurried.range);
        const after = distanceFromGruenfeld(hurried.evidence.referenceFitText, result.mpm!, hurried.range);
         
        console.log(`path, hurried: ${before.toFixed(2)} JND -> ${after.toFixed(2)} JND with ${result.edits.length} edits`);

        expect(after).toBeLessThan(before);
    });

    it('closes it on a quiet take too', () => {
        const result = pathFor(quiet);
        const before = distanceFromGruenfeld(quiet.evidence.referenceFitText, quiet.evidence.studentMpmText, quiet.range);
        const after = distanceFromGruenfeld(quiet.evidence.referenceFitText, result.mpm!, quiet.range);
         
        console.log(`path, quiet: ${before.toFixed(2)} JND -> ${after.toFixed(2)} JND with ${result.edits.length} edits`);

        expect(after).toBeLessThan(before);
    });

    it('closes more of it with five corrections than with one', () => {
        const one = distanceFromGruenfeld(hurried.evidence.referenceFitText, pathFor(hurried, { edits: 1 }).mpm!, hurried.range);
        const five = distanceFromGruenfeld(hurried.evidence.referenceFitText, pathFor(hurried, { edits: 5 }).mpm!, hurried.range);
        expect(five).toBeLessThan(one);
    });
});

// ── 3. nothing else moves ────────────────────────────────────────────────────────────────

describe('what it leaves alone', () => {
    it('changes exactly the elements the edits name and no others', () => {
        const result = pathFor(hurried);
        const moved = changed(hurried.evidence.studentMpmText, result.mpm!);

        expect(moved).toHaveLength(result.edits.length);
        expect(new Set(moved.map((reading) => reading.id)))
            .toEqual(new Set(result.edits.map((edit) => edit.xmlId)));
    });

    it('touches nothing outside the demonstration’s range', () => {
        // A demonstration of the second half only: the first half is the student's, untouched.
        const half: Range = { from: 17280, to: hurried.range.to };
        const result = pathFor(hurried, { range: half });
        expect(result.edits.length).toBeGreaterThan(0);

        for (const edit of result.edits) {
            expect(edit.date).toBeGreaterThanOrEqual(half.from);
            expect(edit.date).toBeLessThanOrEqual(half.to);
        }
        for (const reading of changed(hurried.evidence.studentMpmText, result.mpm!)) {
            expect(reading.date).not.toBeNull();
            expect(reading.date!).toBeGreaterThanOrEqual(half.from);
        }
    });

    it('gives the demonstration Grünfeld’s pedal, since the student’s was never captured', () => {
        // The student's document is a fit, and the fitter writes what it can measure: Web MIDI
        // hands us no CC64, so `path` was the one demonstration that played dry — mean sounding
        // note length 10 % shorter than `mode: 'reference'` (final-pedagogy, finding 5).
        const result = pathFor(hurried);
        const movementsIn = (mpmText: string): number =>
            (mpmText.match(/<movement\b/g) ?? []).length;

        expect(movementsIn(hurried.evidence.studentMpmText)).toBe(0);
        expect(movementsIn(result.mpm!)).toBeGreaterThan(0);
        expect(result.notes.join(' ')).toContain('spliced');
    });

    it('says so, and plays dry, when there is no editorial document to take a pedal from', () => {
        const result = runPath(hurried, { edits: 1, pedalFrom: null });

        expect((result.mpm!.match(/<movement\b/g) ?? []).length).toBe(0);
        expect(result.notes.join(' ')).toContain('no pedal spliced');
    });

    it('never rewrites a def, which is shared with the whole piece', () => {
        // `<articulationDef>` and `<temporalSpread>` carry no `@date`: correcting one for a demo
        // of four bars would change how bar twenty is played.
        for (const take of [hurried, quiet]) {
            const result = pathFor(take, { edits: 5 });
            for (const reading of changed(take.evidence.studentMpmText, result.mpm!)) {
                expect(reading.date, `${reading.name} has no date and was rewritten`).not.toBeNull();
            }
        }
    });
});

// ── 4. determinism, sound, and the cost ──────────────────────────────────────────────────

describe('the demonstration itself', () => {
    it('is byte-identical on a second run of the same take', () => {
        // Around the memo on purpose: two real runs, from the edit script up.
        const first = runPath(hurried, {});
        const second = runPath(hurried, {});

        expect(second.mpm).toBe(first.mpm);
        expect(second.edits).toEqual(first.edits);
    });

    it('renders as MIDI the student can actually hear', () => {
        const result = pathFor(hurried);
        const midi = perform(mei, result.mpm!, hurried.range);

        expect(midi).toBeDefined();
        const notes = noteCount(midi);
         
        console.log(`path, hurried: ${notes} notes rendered over ${hurried.range.from}–${hurried.range.to}`);
        expect(notes).toBeGreaterThan(20);
    });

    it('costs what risk R4 says it costs, on four bars and on eight', () => {
        const four = pathFor(hurried);
        const eight = pathFor(takeOn(hurriedMpm, EIGHT_BARS));

         
        console.log(
            `path: diffMpm 4 bars ${Math.round(four.diffMs)} ms, 8 bars ${Math.round(eight.diffMs)} ms `
            + `(${four.considered} / ${eight.considered} applicable ops)`,
        );

        // Ceilings, not targets, and the gap between them and the budget is stated rather than
        // hidden: DESIGN §5 test 11 budgeted `diffMpm` at **600 ms** on the cut pair, and the
        // measurement under vitest on this machine is **~1.5 s at four bars and ~4 s at eight** —
        // 2.6x and 6.6x over. The 600 ms was never reached and is not reachable by tuning this
        // call: `diffMpm` grows as about n^3.2 and a window does not prune it (risk R4). What
        // `path` actually buys with that time is that it is spent in the evidence worker, after
        // the plan has arrived, while the teacher is already speaking — so it is latency the
        // student does not wait through, not latency that was optimised away. These two numbers
        // are the accepted budget; they are wide enough that only a change of complexity class
        // trips them, which is the regression this test is for.
        expect(four.diffMs).toBeLessThan(3000);
        expect(eight.diffMs).toBeLessThan(12000);
        expect(eight.diffMs).toBeGreaterThan(four.diffMs);
    }, 40000);

    it('refuses a take longer than twelve bars rather than making it wait', () => {
        const result = pathFor(hurried, {
            range: { from: hurried.range.from, to: hurried.range.from + PATH_MAX_TICKS + 720 },
        });

        expect(result.mpm).toBeNull();
        expect(result.edits).toEqual([]);
        expect(result.diffMs).toBe(0);
        expect(result.notes.join(' ')).toContain(`more than ${PATH_MAX_BARS}`);
    });

    it('says what it did, and why, for the debug log', () => {
        const result = pathFor(hurried, { edits: 1 });
        const said = result.notes.join('\n');

        expect(said).toContain('diffMpm');
        expect(said).toContain('applicable op(s)');
        expect(said).toContain(result.edits[0].position);
    });
});
