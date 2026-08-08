import { spanLabel, tickToPos } from '../shared/musicalTime';
import type { Argumentation, MpmElement, Range, Span } from './types';

/** Commentary is truncated in the digest; range detail serves the full text. */
const DIGEST_COMMENTARY_CHARS = 220;
/** Bounds on the per-request detail block so a wide take range cannot blow up latency. */
const MAX_DETAIL_ARGUMENTATIONS = 24;
const MAX_DETAIL_ELEMENTS = 70;

const truncate = (text: string, limit: number): string =>
    text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;

/** Compact fixed-precision number: no trailing zeros, so lines stay byte-stable. */
const num = (value: number, digits = 2): string =>
    Number.isInteger(value) ? String(value) : String(Number(value.toFixed(digits)));

const positionLabel = (argumentation: Argumentation): string => {
    if (argumentation.scope === 'global') return 'piece-wide';
    if (argumentation.scope === 'unplaced' || argumentation.spans.length === 0) return 'unplaced';
    const first = argumentation.spans[0];
    const last = argumentation.spans[argumentation.spans.length - 1];
    const label = spanLabel(first.from, last.to);
    return argumentation.spans.length > 1 ? `${label} (${argumentation.spans.length}x)` : label;
};

const conceptLabel = (argumentation: Argumentation): string =>
    argumentation.concepts.length > 0 ? argumentation.concepts.join('+') : '—';

const MOTIVATION_MARKS: Record<string, string> = { intensify: '++', move: '+', calm: '-', relax: '--' };

/** `intensify (++)` — the scale mark makes direction and weight visible at a glance. */
const motivationText = (argumentation: Argumentation): string => {
    const mark = MOTIVATION_MARKS[argumentation.motivation];
    return mark ? `${argumentation.motivation} (${mark})` : argumentation.motivation;
};

const digestLine = (argumentation: Argumentation): string => {
    const fields = [
        positionLabel(argumentation),
        conceptLabel(argumentation),
        argumentation.certainty,
        motivationText(argumentation),
    ];
    const prose = [argumentation.claim, truncate(argumentation.commentary, DIGEST_COMMENTARY_CHARS)]
        .filter(Boolean)
        .join(' — ');
    if (prose) fields.push(prose);
    return fields.join(' | ');
};

/** An argumentation with no prose and no motivation only says "something happens here". */
const carriesInterpretation = (argumentation: Argumentation): boolean =>
    Boolean(argumentation.claim || argumentation.commentary) || argumentation.motivation !== 'unknown';

export type DigestOptions = {
    /**
     * Drop argumentations that carry no motivation and no editorial prose.
     * Roughly halves the digest for latency-sensitive tiers.
     */
    onlyInterpretive?: boolean;
};

/**
 * The stable half of the prompt: every argumentation in the reconstruction,
 * one line each. Deterministic — the argumentation order is fixed by
 * `parseArgumentations`, and no clock or environment value enters the text.
 */
export const buildScholarlyDigest = (
    allArgumentations: Argumentation[],
    options: DigestOptions = {},
): string => {
    const argumentations = options.onlyInterpretive
        ? allArgumentations.filter(carriesInterpretation)
        : allArgumentations;
    const header = [
        'SCHOLARLY CORPUS — the editorial reconstruction of Alfred Grünfeld\'s 1905 Welte-Mignon',
        'recording of Schumann\'s "Träumerei". Every line is one documented argumentation: where it',
        'applies | which MPM concepts realise it | how certain the editor is | the motivation |',
        'the editor\'s own words (German). This is the evidence for WHY the reference performance',
        'does what it does — the reference is not an opinion, it is a reconstruction with sources.',
        '',
        `${argumentations.length} argumentations, ordered by position:`,
    ].join('\n');

    return `${header}\n${argumentations.map(digestLine).join('\n')}`;
};

// ── Range detail ──

const overlaps = (spans: Span[], range: Range): boolean =>
    spans.some((span) => span.from <= range.to && span.to >= range.from);

/** Machine-generated identifiers carry no meaning for the teacher. */
const GENERATED_NAME_RE = /^(pattern-)?[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$|^pattern-[0-9a-f]{6,}$/i;
/** `scope` is `global` on every call in the corpus; printing it is pure noise. */
const OMITTED_OPTIONS = new Set(['scope']);
const MAX_DETAIL_CALLS = 4;

const optionText = (key: string, value: unknown): string | null => {
    if (OMITTED_OPTIONS.has(key)) return null;
    if (typeof value === 'number') return `${key}=${num(value, 3)}`;
    if (typeof value === 'boolean') return `${key}=${String(value)}`;
    if (typeof value !== 'string') return null;
    return GENERATED_NAME_RE.test(value) ? null : `${key}=${value}`;
};

/**
 * Render the transformers behind an argumentation, keeping only the calls that
 * actually reach into the passage under discussion. A rule like Inegalité fires
 * 28 times across the piece; the teacher needs the two that apply here.
 */
const callDetail = (argumentation: Argumentation, range: Range): string => {
    const relevant = argumentation.calls.filter(
        (call) => call.span === null || (call.span.from <= range.to && call.span.to >= range.from),
    );
    const shown = (relevant.length > 0 ? relevant : argumentation.calls).slice(0, MAX_DETAIL_CALLS);
    const hidden = (relevant.length > 0 ? relevant : argumentation.calls).length - shown.length;

    const parts = shown.map((call) => {
        const options = Object.entries(call.options)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => optionText(key, value))
            .filter((text): text is string => text !== null)
            .join(', ');
        return options ? `${call.name}(${options})` : call.name;
    });
    if (hidden > 0) parts.push(`+${hidden} more of the same`);
    return parts.join('; ');
};

const detailBlock = (argumentation: Argumentation, range: Range): string => {
    const lines = [
        `- ${positionLabel(argumentation)} | ${conceptLabel(argumentation)} | certainty: ${argumentation.certainty} | motivation: ${motivationText(argumentation)}`,
    ];
    if (argumentation.claim) lines.push(`  claim: ${argumentation.claim}`);
    if (argumentation.commentary) lines.push(`  commentary: ${argumentation.commentary}`);
    const calls = callDetail(argumentation, range);
    if (calls) lines.push(`  transformers: ${calls}`);
    return lines.join('\n');
};

const elementLine = (element: MpmElement): string => {
    const { attrs } = element;
    const at = element.endDate > element.date
        ? spanLabel(element.date, element.endDate)
        : tickToPos(element.date);
    const value = (key: string): number | null => {
        const parsed = Number(attrs[key]);
        return Number.isFinite(parsed) ? parsed : null;
    };

    const parts: string[] = [];
    switch (element.kind) {
        case 'tempo': {
            const bpm = value('bpm');
            const to = value('transition.to');
            if (bpm !== null) parts.push(`bpm ${num(bpm, 1)}${to !== null ? ` → ${num(to, 1)}` : ''}`);
            const beat = value('beatLength');
            if (beat !== null) parts.push(`beatLength ${num(beat, 3)}`);
            break;
        }
        case 'dynamics': {
            const volume = value('volume');
            const to = value('transition.to');
            if (volume !== null) parts.push(`volume ${num(volume, 1)}${to !== null ? ` → ${num(to, 1)}` : ''}`);
            break;
        }
        case 'rubato': {
            const intensity = value('intensity');
            const frame = value('frameLength');
            if (intensity !== null) parts.push(`intensity ${num(intensity, 3)}`);
            if (frame !== null) parts.push(`frameLength ${num(frame)}`);
            break;
        }
        case 'accentuationPattern': {
            const scale = value('scale');
            if (attrs['name.ref']) parts.push(`pattern ${attrs['name.ref']}`);
            if (scale !== null) parts.push(`scale ${num(scale, 2)}`);
            break;
        }
        case 'articulation': {
            const named = attrs['name.ref'] ?? '';
            if (named && !GENERATED_NAME_RE.test(named)) parts.push(named);
            const noteCount = (attrs.noteid ?? '').split(/\s+/).filter(Boolean).length;
            if (noteCount > 0) parts.push(`${noteCount} note(s)`);
            break;
        }
        case 'ornament': {
            const scale = value('scale');
            const intensity = value('intensity');
            parts.push('arpeggio');
            if (scale !== null) parts.push(`scale ${num(scale, 2)}`);
            if (intensity !== null) parts.push(`intensity ${num(intensity, 3)}`);
            break;
        }
        case 'asynchrony': {
            const offset = value('milliseconds.offset');
            if (offset !== null) parts.push(`offset ${num(offset, 1)} ms`);
            break;
        }
        default:
            break;
    }

    return `  ${at} ${element.kind}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}`;
};

/**
 * The volatile half: the scholarly record for the passage the student just
 * played, at full text, plus the reference performance's own instructions there.
 */
export const buildRangeDetail = (
    argumentations: Argumentation[],
    elements: MpmElement[],
    range: Range,
): string => {
    const relevant = argumentations
        .filter((a) => a.scope === 'ranged' && overlaps(a.spans, range))
        .slice(0, MAX_DETAIL_ARGUMENTATIONS);

    const inRange = elements
        .filter((element) => element.date <= range.to && Math.max(element.date, element.endDate) >= range.from)
        .slice(0, MAX_DETAIL_ELEMENTS);

    const label = spanLabel(range.from, range.to);
    const sections = [`=== SCHOLARLY RECORD FOR ${label} ===`];

    if (relevant.length > 0) {
        sections.push(`Argumentations covering this passage (${relevant.length}):`);
        sections.push(relevant.map((a) => detailBlock(a, range)).join('\n'));
    } else {
        sections.push('No argumentation is documented for this passage.');
    }

    if (inRange.length > 0) {
        sections.push(`\nReference performance instructions here (${inRange.length}):`);
        sections.push(inRange.map(elementLine).join('\n'));
    }

    return sections.join('\n');
};
