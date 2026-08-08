import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRangeDetail, buildScholarlyDigest, type DigestOptions } from './digest';
import { parseArgumentations, parseMpmElements, spansByCorresp } from './parse';
import { MPM_CONCEPT_PRIMER } from './primer';
import type { Corpus, Range } from './types';

export { MPM_CONCEPT_PRIMER } from './primer';
export { buildRangeDetail, buildScholarlyDigest } from './digest';
export { parseArgumentations, parseMpmElements, spansByCorresp } from './parse';
export type { Argumentation, Corpus, MpmElement, Range, Span } from './types';

/**
 * The transformer chain the client actually applies to build the reference
 * performance, and the committed rendering of that performance.
 */
const INFO_JSON_PATH = 'client/public/info.json';
const REFERENCE_MPM_PATH = 'assets/all/performance.mpm';

/**
 * Walk up from this module until both corpus files are in sight. Works from
 * `src/corpus/` under tsx and from `dist/corpus/` after a build, so no caller
 * has to care about the working directory.
 */
const findRepoRoot = (): string => {
    let current = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth++) {
        if (existsSync(join(current, INFO_JSON_PATH))) return current;
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return process.cwd();
};

const corpusPath = (relative: string, override: string | undefined): string =>
    override ? resolve(override) : join(findRepoRoot(), relative);

let cachedCorpus: Corpus | null = null;

/** Parsed corpus, loaded once per process. */
export const getCorpus = (): Corpus => {
    if (cachedCorpus) return cachedCorpus;

    const infoJson = JSON.parse(
        readFileSync(corpusPath(INFO_JSON_PATH, process.env.CORPUS_INFO_JSON), 'utf8'),
    ) as unknown;
    const mpmXml = readFileSync(
        corpusPath(REFERENCE_MPM_PATH, process.env.CORPUS_REFERENCE_MPM),
        'utf8',
    );

    const elements = parseMpmElements(mpmXml);
    const argumentations = parseArgumentations(infoJson, spansByCorresp(elements));
    const lastTick = Math.max(
        0,
        ...elements.map((element) => Math.max(element.date, element.endDate)),
        ...argumentations.flatMap((a) => a.spans.map((span) => span.to)),
    );

    cachedCorpus = { argumentations, elements, lastTick };
    return cachedCorpus;
};

const digestCache = new Map<string, string>();

/** Byte-stable scholarly digest — safe to use as a cached prompt prefix. */
export const getScholarlyDigest = (options: DigestOptions = {}): string => {
    const key = options.onlyInterpretive ? 'interpretive' : 'full';
    const cached = digestCache.get(key);
    if (cached) return cached;
    const digest = buildScholarlyDigest(getCorpus().argumentations, options);
    digestCache.set(key, digest);
    return digest;
};

/** Full editorial record plus reference instructions for one passage. */
export const getRangeDetail = (range: Range): string => {
    const corpus = getCorpus();
    return buildRangeDetail(corpus.argumentations, corpus.elements, range);
};

/** Rough token estimate (chars/4) — good enough for prompt budgeting. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export const corpusStats = (): {
    argumentations: number;
    placed: number;
    global: number;
    unplaced: number;
    elements: number;
    lastTick: number;
    digestChars: number;
    digestTokens: number;
    primerTokens: number;
} => {
    const corpus = getCorpus();
    const digest = getScholarlyDigest();
    return {
        argumentations: corpus.argumentations.length,
        placed: corpus.argumentations.filter((a) => a.scope === 'ranged').length,
        global: corpus.argumentations.filter((a) => a.scope === 'global').length,
        unplaced: corpus.argumentations.filter((a) => a.scope === 'unplaced').length,
        elements: corpus.elements.length,
        lastTick: corpus.lastTick,
        digestChars: digest.length,
        digestTokens: estimateTokens(digest),
        primerTokens: estimateTokens(MPM_CONCEPT_PRIMER),
    };
};
