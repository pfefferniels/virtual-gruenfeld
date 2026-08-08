import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildRangeDetail, buildScholarlyDigest } from './digest';
import { estimateTokens, getCorpus, getRangeDetail, getScholarlyDigest, corpusStats } from './index';
import { mergeSpans, parseArgumentations, parseMpmElements, spansByCorresp } from './parse';
import { MPM_CONCEPT_PRIMER } from './primer';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readCorpusFiles = () => ({
    infoJson: JSON.parse(readFileSync(join(REPO_ROOT, 'client/public/info.json'), 'utf8')) as unknown,
    mpmXml: readFileSync(join(REPO_ROOT, 'assets/all/performance.mpm'), 'utf8'),
});

/** Parse the real corpus from scratch, bypassing the module-level cache. */
const freshParse = () => {
    const { infoJson, mpmXml } = readCorpusFiles();
    const elements = parseMpmElements(mpmXml);
    return { argumentations: parseArgumentations(infoJson, spansByCorresp(elements)), elements };
};

/** The take range used by the `01_robotic` fixture: bars 1–5. */
const FIXTURE_RANGE = { from: 720, to: 13680 };

/** Digest lines below the header — one per argumentation. */
const digestBody = (digest: string): string[] => {
    const lines = digest.split('\n');
    return lines.slice(lines.findIndex((line) => line.endsWith('ordered by position:')) + 1);
};

describe('corpus parsing', () => {
    it('reads every argumentation in info.json', () => {
        expect(getCorpus().argumentations).toHaveLength(158);
    });

    it('places all but a handful of argumentations on the timeline', () => {
        const stats = corpusStats();
        expect(stats.placed + stats.global).toBeGreaterThanOrEqual(150);
        expect(stats.unplaced).toBeLessThanOrEqual(8);
    });

    it('orders argumentations by position, then id', () => {
        const { argumentations } = freshParse();
        const placed = argumentations.filter((a) => a.spans.length > 0);
        for (let i = 1; i < placed.length; i++) {
            expect(placed[i].spans[0].from).toBeGreaterThanOrEqual(placed[i - 1].spans[0].from);
        }
        // Unplaced argumentations sort last so the digest tail is stable.
        const firstUnplaced = argumentations.findIndex((a) => a.spans.length === 0);
        if (firstUnplaced !== -1) {
            expect(argumentations.slice(firstUnplaced).every((a) => a.spans.length === 0)).toBe(true);
        }
    });

    it('resolves pedal spans against the pedal event tick, not the raw offsets', () => {
        const info = {
            creation: {
                argumentations: [{
                    id: 'a1',
                    conclusion: { certainty: 'likely', motivation: 'resonance', note: 'Klang öffnen' },
                    calls: [{ name: 'InsertPedal', options: { pedal: 'sustain-1440', start: -100, duration: 200 } }],
                }],
            },
        };
        const [argumentation] = parseArgumentations(info);
        expect(argumentation.spans).toEqual([{ from: 1340, to: 1540 }]);
        expect(argumentation.concepts).toEqual(['pedal']);
    });

    it('reads rubato spans from date plus length', () => {
        const info = {
            creation: {
                argumentations: [{
                    id: 'a1',
                    conclusion: { certainty: 'likely', motivation: 'forward-lilt' },
                    calls: [{ name: 'InsertRubato', options: { date: 7200, length: 720 } }],
                }],
            },
        };
        expect(parseArgumentations(info)[0].spans).toEqual([{ from: 7200, to: 7920 }]);
    });

    it('falls back to the reference MPM when a transformer addresses notes by id', () => {
        const info = {
            creation: {
                argumentations: [{
                    id: 'a1',
                    conclusion: { certainty: 'likely', motivation: 'resonance' },
                    calls: [{ name: 'InsertArticulation', options: { noteIDs: ['#n1'], name: 'legato' } }],
                }],
            },
        };
        const spans = new Map([['a1', [{ from: 2880, to: 2880 }]]]);
        expect(parseArgumentations(info, spans)[0].spans).toEqual([{ from: 2880, to: 2880 }]);
        expect(parseArgumentations(info)[0].scope).toBe('unplaced');
    });

    it('normalises the relax motivation variant', () => {
        const info = {
            creation: {
                argumentations: [
                    { id: 'a1', conclusion: { motivation: 'relax' }, calls: [] },
                    { id: 'a2', conclusion: {}, calls: [] },
                ],
            },
        };
        const parsed = parseArgumentations(info);
        expect(parsed.map((a) => a.motivation).sort()).toEqual(['relaxation', 'unknown']);
    });

    it('merges overlapping spans', () => {
        expect(mergeSpans([{ from: 10, to: 20 }, { from: 15, to: 30 }, { from: 40, to: 50 }]))
            .toEqual([{ from: 10, to: 30 }, { from: 40, to: 50 }]);
        expect(mergeSpans([])).toEqual([]);
    });

    it('extracts dated instructions from the reference MPM', () => {
        const elements = parseMpmElements(`<mpm>
            <tempo xml:id="tempo_720" date="720" endDate="3600" bpm="29.2" corresp="argumentation-x"></tempo>
            <dynamics date="0" endDate="2520" volume="41" transition.to="36"></dynamics>
            <ornamentDef name="ignored"></ornamentDef>
        </mpm>`);
        expect(elements.map((e) => e.kind)).toEqual(['dynamics', 'tempo']);
        expect(elements[1]).toMatchObject({ date: 720, endDate: 3600, corresp: 'argumentation-x' });
        expect(spansByCorresp(elements).get('argumentation-x')).toEqual([{ from: 720, to: 3600 }]);
    });
});

describe('scholarly digest', () => {
    it('is byte-identical across independent builds', () => {
        const a = buildScholarlyDigest(freshParse().argumentations);
        const b = buildScholarlyDigest(freshParse().argumentations);
        expect(a).toBe(b);
        expect(a).toBe(getScholarlyDigest());
    });

    it('does not depend on the order argumentations arrive in', () => {
        const { infoJson, mpmXml } = readCorpusFiles();
        const spans = spansByCorresp(parseMpmElements(mpmXml));
        const raw = (infoJson as { creation: { argumentations: unknown[] } }).creation.argumentations;
        const reversed = { creation: { argumentations: [...raw].reverse() } };
        expect(buildScholarlyDigest(parseArgumentations(reversed, spans)))
            .toBe(buildScholarlyDigest(parseArgumentations(infoJson, spans)));
    });

    it('stays large enough to cache and small enough to stay fast', () => {
        const tokens = estimateTokens(getScholarlyDigest());
        // OpenAI prefix caching needs >= 1024 tokens of stable prefix.
        expect(tokens).toBeGreaterThan(1024);
        expect(tokens).toBeLessThan(25_000);
    });

    it('carries one line per argumentation plus a header', () => {
        expect(digestBody(getScholarlyDigest())).toHaveLength(getCorpus().argumentations.length);
    });

    it('keeps the editorial voice: positions, certainty, motivation and German prose', () => {
        const digest = getScholarlyDigest();
        expect(digest).toContain('Inegalité');
        expect(digest).toContain('authentic');
        expect(digest).toContain('forward-lilt');
        expect(digest).toMatch(/m\d+\.\d+/);
    });

    it('marks piece-wide rules instead of pinning them to bar one', () => {
        const digest = getScholarlyDigest();
        expect(digest).toContain('piece-wide');
        expect(getCorpus().argumentations.filter((a) => a.scope === 'global').length).toBeGreaterThan(0);
    });

    it('shrinks when only interpretive argumentations are kept', () => {
        const full = getScholarlyDigest();
        const compact = getScholarlyDigest({ onlyInterpretive: true });
        expect(compact.length).toBeLessThan(full.length);
        const fullLines = new Set(digestBody(full));
        for (const line of digestBody(compact)) expect(fullLines.has(line)).toBe(true);
    });
});

describe('range detail', () => {
    it('is deterministic for the same range', () => {
        expect(getRangeDetail(FIXTURE_RANGE)).toBe(getRangeDetail({ ...FIXTURE_RANGE }));
    });

    it('reports the passage it covers', () => {
        expect(getRangeDetail(FIXTURE_RANGE)).toContain('=== SCHOLARLY RECORD FOR m1.2–m5.4 ===');
    });

    it('includes argumentations that overlap the range and excludes distant ones', () => {
        const detail = getRangeDetail(FIXTURE_RANGE);
        const corpus = getCorpus();
        const inside = corpus.argumentations.filter(
            (a) => a.scope === 'ranged' && a.spans.some((s) => s.from <= FIXTURE_RANGE.to && s.to >= FIXTURE_RANGE.from),
        );
        expect(inside.length).toBeGreaterThan(5);
        expect(detail).toContain('Auftaktgeste flüchtig, etwas gestaucht'); // m1.4–m2.2

        const farAway = corpus.argumentations.find(
            (a) => a.claim && a.spans.length > 0 && a.spans[0].from > 60_000 && a.spans[a.spans.length - 1].to > 60_000,
        );
        expect(farAway).toBeDefined();
        expect(detail).not.toContain(`claim: ${farAway!.claim}`);
    });

    it('lists reference instructions inside the range only', () => {
        const detail = buildRangeDetail(getCorpus().argumentations, getCorpus().elements, FIXTURE_RANGE);
        expect(detail).toContain('Reference performance instructions here');
        expect(detail).toContain('m2.2 rubato: intensity');
        expect(detail).not.toMatch(/\n {2}m(2[5-9]|3[0-2])\.\d /);
    });

    it('shows only the transformer calls that reach into the range', () => {
        // Inegalité fires 28 times across the piece; the m1–m5 view must not list them all.
        const detail = getRangeDetail(FIXTURE_RANGE);
        const inegaliteBlock = detail.slice(detail.indexOf('claim: Inegalité'));
        const transformerLine = inegaliteBlock.split('\n').find((line) => line.includes('transformers:')) ?? '';
        expect(transformerLine.match(/InsertRubato/g)?.length ?? 0).toBeLessThanOrEqual(4);
        expect(transformerLine).toContain('more of the same');
    });

    it('says so plainly when nothing is documented for a range', () => {
        expect(buildRangeDetail([], [], { from: 0, to: 720 }))
            .toContain('No argumentation is documented for this passage.');
    });

    it('drops machine-generated identifiers', () => {
        expect(getRangeDetail(FIXTURE_RANGE)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    });
});

describe('concept primer', () => {
    it('teaches the terms the diff actually uses', () => {
        for (const term of ['transition.to', 'relativeDuration', 'frameLength', 'intensity', 'accentuationPattern']) {
            expect(MPM_CONCEPT_PRIMER).toContain(term);
        }
    });

    it('keeps the two semantics the model would otherwise guess wrong', () => {
        expect(MPM_CONCEPT_PRIMER).toContain('ARPEGGIATION');
        expect(MPM_CONCEPT_PRIMER).toMatch(/intensity.{0,40}short-long/s);
    });

    it('explains the corpus motivation vocabulary', () => {
        for (const motivation of ['intensification', 'relaxation', 'shading', 'forward-lilt', 'resonance']) {
            expect(MPM_CONCEPT_PRIMER).toContain(motivation);
        }
    });
});
