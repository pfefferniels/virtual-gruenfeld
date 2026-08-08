import { CANONICAL_MOTIVATIONS } from './types';
import type { Argumentation, CorpusCall, Motivation, MpmElement, Span } from './types';

/**
 * Transformer name → the MPM concept it produces. Names come from the mpmify
 * transformer chain recorded in info.json; anything unmapped falls back to the
 * raw name so a new transformer degrades to "visible but unlabelled".
 */
const CONCEPT_BY_TRANSFORMER: Record<string, string> = {
    ApproximateLogarithmicTempo: 'tempo',
    InsertDynamicsInstructions: 'dynamics',
    InsertRubato: 'rubato',
    InsertMetricalAccentuation: 'metrical accentuation',
    MergeMetricalAccentuations: 'metrical accentuation',
    InsertArticulation: 'articulation',
    InsertPedal: 'pedal',
    InsertTemporalSpread: 'arpeggiation',
    InsertDynamicsGradient: 'arpeggiation',
    StylizeOrnamentation: 'arpeggiation',
    Modify: 'manual adjustment',
    MakeChoice: 'editorial choice',
    TranslatePhyiscalTimeToTicks: 'time base',
    InsertTempo: 'tempo',
    InsertMetadata: 'metadata',
};

/** Canonical concept order — keeps digest lines byte-stable regardless of call order. */
const CONCEPT_ORDER = [
    'tempo',
    'dynamics',
    'rubato',
    'metrical accentuation',
    'articulation',
    'arpeggiation',
    'pedal',
    'manual adjustment',
    'editorial choice',
    'time base',
];

const conceptRank = (concept: string): number => {
    const index = CONCEPT_ORDER.indexOf(concept);
    return index === -1 ? CONCEPT_ORDER.length : index;
};

/** An argumentation covering at least this share of the piece is treated as global. */
const GLOBAL_COVERAGE = 0.7;

const MPM_DATED_KINDS = [
    'tempo',
    'dynamics',
    'rubato',
    'accentuationPattern',
    'articulation',
    'ornament',
    'asynchrony',
];

// ── Text normalisation ──

/** Collapse whitespace so multi-line editorial notes stay one digest line. */
const flattenText = (value: unknown): string =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

/**
 * Pre-reduction motivation words → the canonical four-step scale. The first two
 * are pure renames; the rest are the editor's finer nuances, classified by the
 * same sign/gain semantics mpm-desk's intensity curve assigns the scale.
 */
const LEGACY_MOTIVATIONS: Record<string, Motivation> = {
    intensification: 'intensify',
    relaxation: 'relax',
    'forward-lilt': 'move',   // gentle lean toward the next downbeat (+)
    shading: 'calm',          // gentle colouring downward (-)
    resonance: 'calm',        // letting the sound settle and ring (-)
    pianissimo: 'calm',       // below-roll dynamic level (-)
};

/** Map any motivation onto the canonical four-step vocabulary. */
const normalizeMotivation = (value: unknown): Motivation => {
    const text = flattenText(value);
    if (!text) return 'unknown';
    if ((CANONICAL_MOTIVATIONS as readonly string[]).includes(text)) return text as Motivation;
    return LEGACY_MOTIVATIONS[text] ?? 'unknown';
};

// ── Spans ──

/** Merge overlapping/adjacent spans so a digest line reports one clean extent. */
export const mergeSpans = (spans: Span[]): Span[] => {
    if (spans.length === 0) return [];
    const sorted = [...spans].sort((a, b) => a.from - b.from || a.to - b.to);
    const merged: Span[] = [{ ...sorted[0] }];
    for (const span of sorted.slice(1)) {
        const last = merged[merged.length - 1];
        if (span.from <= last.to) {
            last.to = Math.max(last.to, span.to);
        } else {
            merged.push({ ...span });
        }
    }
    return merged;
};

const numberOption = (options: Record<string, unknown>, key: string): number | null => {
    const value = options[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/**
 * A pedal call names its anchor event (`sustain-1440`, `soft-0`) and gives
 * `start`/`duration` as offsets around that anchor's tick.
 */
const pedalAnchorTick = (options: Record<string, unknown>): number | null => {
    const name = flattenText(options.pedal);
    const match = /-(\d+)$/.exec(name);
    return match ? Number(match[1]) : null;
};

/**
 * Derive the tick span a single transformer call touches. Transformers use three
 * conventions: absolute `from`/`to` (most), `date`/`length` (rubato), and a
 * pedal anchor plus relative `start`/`duration`. Calls that only name note IDs
 * yield nothing here and are placed later via the reference MPM's `corresp`.
 */
const spanFromCall = (call: CorpusCall): Span | null => {
    const { options } = call;

    if (call.name === 'InsertPedal') {
        const anchor = pedalAnchorTick(options);
        if (anchor === null) return null;
        const start = anchor + (numberOption(options, 'start') ?? 0);
        const end = start + Math.max(0, numberOption(options, 'duration') ?? 0);
        return { from: Math.max(0, start), to: Math.max(0, end) };
    }

    const from = numberOption(options, 'from');
    const to = numberOption(options, 'to');
    if (from !== null || to !== null) {
        const lo = from ?? (to as number);
        const hi = to ?? (from as number);
        return { from: Math.min(lo, hi), to: Math.max(lo, hi) };
    }

    const date = numberOption(options, 'date');
    if (date !== null) {
        const length = numberOption(options, 'length') ?? 0;
        return { from: date, to: date + Math.max(0, length) };
    }

    return null;
};

// ── info.json ──

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const parseCalls = (raw: unknown): CorpusCall[] => {
    if (!Array.isArray(raw)) return [];
    return raw.map((entry) => {
        const call = asRecord(entry);
        const name = flattenText(call.name) || 'unknown';
        const parsed: CorpusCall = {
            name,
            concept: CONCEPT_BY_TRANSFORMER[name] ?? name,
            options: asRecord(call.options),
            span: null,
        };
        parsed.span = spanFromCall(parsed);
        return parsed;
    });
};

/**
 * Turn the CIDOC-CRM argumentation list into flat records carrying only what
 * has interpretive weight: where it applies, which MPM concept it produces,
 * how certain the editor was, why, and the editorial prose.
 *
 * `elementSpansById` supplies positions for argumentations whose transformers
 * address notes by ID rather than by tick range; it is derived from the
 * reference MPM's `corresp` back-links.
 */
export const parseArgumentations = (
    infoJson: unknown,
    elementSpansById: Map<string, Span[]> = new Map(),
): Argumentation[] => {
    const creation = asRecord(asRecord(infoJson).creation);
    const raw = creation.argumentations;
    if (!Array.isArray(raw)) return [];

    const parsed: Argumentation[] = [];
    let lastTick = 0;

    for (const entry of raw) {
        const record = asRecord(entry);
        const id = flattenText(record.id);
        if (!id) continue;

        const conclusion = asRecord(record.conclusion);
        const calls = parseCalls(record.calls);

        const callSpans = calls
            .map((call) => call.span)
            .filter((span): span is Span => span !== null);
        const spans = mergeSpans(callSpans.length > 0 ? callSpans : elementSpansById.get(id) ?? []);
        for (const span of spans) lastTick = Math.max(lastTick, span.to);

        const concepts = Array.from(new Set(calls.map((call) => call.concept)))
            .sort((a, b) => conceptRank(a) - conceptRank(b) || a.localeCompare(b));

        parsed.push({
            id,
            spans,
            scope: 'ranged',
            concepts,
            certainty: flattenText(conclusion.certainty) || 'unknown',
            motivation: normalizeMotivation(conclusion.motivation),
            claim: flattenText(conclusion.note),
            commentary: flattenText(record.note),
            calls,
        });
    }

    for (const argumentation of parsed) {
        if (argumentation.spans.length === 0) {
            argumentation.scope = 'unplaced';
            continue;
        }
        // Extent, not summed length: a rule realised as 95 point-like arpeggio
        // instructions from bar 1 to bar 32 is piece-wide policy, not a passage.
        const extent = argumentation.spans[argumentation.spans.length - 1].to - argumentation.spans[0].from;
        if (lastTick > 0 && extent / lastTick >= GLOBAL_COVERAGE) argumentation.scope = 'global';
    }

    return parsed.sort((a, b) => {
        const aFrom = a.spans[0]?.from ?? Number.MAX_SAFE_INTEGER;
        const bFrom = b.spans[0]?.from ?? Number.MAX_SAFE_INTEGER;
        return aFrom - bFrom || a.id.localeCompare(b.id);
    });
};

// ── performance.mpm ──

const ATTR_RE = /([\w.:]+)="([^"]*)"/g;

const parseAttrs = (source: string): Record<string, string> => {
    const attrs: Record<string, string> = {};
    for (const match of source.matchAll(ATTR_RE)) attrs[match[1]] = match[2];
    return attrs;
};

/**
 * Pull the dated instructions out of the reference MPM. A regex is enough here:
 * the file is machine-generated, flat, and never nests dated elements.
 */
export const parseMpmElements = (mpmXml: string): MpmElement[] => {
    const kinds = MPM_DATED_KINDS.join('|');
    const elementRe = new RegExp(`<(${kinds})\\b([^>]*)>`, 'g');
    const elements: MpmElement[] = [];

    for (const match of mpmXml.matchAll(elementRe)) {
        const attrs = parseAttrs(match[2]);
        const date = Number(attrs.date);
        if (!Number.isFinite(date)) continue;
        const endDate = Number(attrs.endDate);
        elements.push({
            kind: match[1],
            date,
            endDate: Number.isFinite(endDate) ? endDate : date,
            attrs,
            corresp: attrs.corresp ?? '',
        });
    }

    return elements.sort((a, b) => a.date - b.date || a.kind.localeCompare(b.kind));
};

/** Group element extents by the argumentation they were generated from. */
export const spansByCorresp = (elements: MpmElement[]): Map<string, Span[]> => {
    const byId = new Map<string, Span[]>();
    for (const element of elements) {
        if (!element.corresp) continue;
        const spans = byId.get(element.corresp) ?? [];
        spans.push({ from: element.date, to: Math.max(element.date, element.endDate) });
        byId.set(element.corresp, spans);
    }
    return byId;
};
