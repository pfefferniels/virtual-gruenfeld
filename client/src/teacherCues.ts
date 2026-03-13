import type { MidiFile } from 'midifile-ts';
import type { MSM } from 'mpmify';
import { extractNotesFromMidi, extractRefNotes, matchSubsequence } from './matcher';
import type { Range, StructuredDiffEvent } from './mpm';
import { positionToTick } from './shared/constants';
import { severityWeight } from './shared/severity';
import { normalizeV3Tag } from './shared/tts';

export type TimingMapPoint = {
    date: number;
    sec: number;
};

export type TeacherCue = {
    id: string;
    atSec: number;
    text: string;
    anchorDate: number;
    severity: StructuredDiffEvent['severity'];
    type: string;
    priority: number;
};

export type TeacherCueDraft = {
    position: string;
    text: string;
};

type TeacherCueCandidate = {
    position: string;
    atSec: number;
    anchorDate: number;
    event: StructuredDiffEvent;
    priority: number;
};

const MIN_CUE_GAP_SEC = 1.2;
const MAX_CUES = 4;

// ── Logarithmic cue delay ──
// A real teacher narrates what they're doing *after* the change is underway,
// not before it. The delay scales logarithmically with the region length:
// short regions → short delay, long regions → slightly longer, but with
// diminishing returns (a teacher reacts quickly regardless of phrase length).
const CUE_DELAY_K = 0.6;
const CUE_DELAY_SCALE = 2.0;
const CUE_DELAY_MIN = 0.2;
const CUE_DELAY_MAX = 1.0;
const CUE_DELAY_DEFAULT_REGION = 2.0; // fallback when no next event exists

export const cueDelay = (regionLengthSec: number): number => {
    const raw = CUE_DELAY_K * Math.log(1 + regionLengthSec / CUE_DELAY_SCALE);
    return Math.min(CUE_DELAY_MAX, Math.max(CUE_DELAY_MIN, raw));
};
const UNCLEAR_CUE_PATTERNS = [
    /\bstaffel/i,
    /\barpeggi/i,
    /\bagog/i,
    /\bphrasierungskurve/i,
];
const TOO_VAGUE_CUES = new Set(['mehr', 'weniger']);

const compareEvents = (a: StructuredDiffEvent, b: StructuredDiffEvent): number => {
    const severityDelta = severityWeight(b.severity) - severityWeight(a.severity);
    if (severityDelta !== 0) return severityDelta;
    return b.magnitude - a.magnitude;
};

const collapseTimingMap = (points: TimingMapPoint[]): TimingMapPoint[] => {
    const grouped = new Map<number, number[]>();
    for (const point of points) {
        const group = grouped.get(point.date) ?? [];
        group.push(point.sec);
        grouped.set(point.date, group);
    }

    return Array.from(grouped.entries())
        .map(([date, secs]) => ({
            date,
            sec: secs.reduce((sum, value) => sum + value, 0) / secs.length,
        }))
        .sort((a, b) => a.date - b.date || a.sec - b.sec);
};

const fallbackTimingMap = (referenceMsm: MSM, range: Range): TimingMapPoint[] => {
    const notes = extractRefNotes(referenceMsm)
        .filter(note => note.date >= range.from && note.date <= range.to)
        .sort((a, b) => a.date - b.date || a.onset - b.onset);
    if (notes.length === 0) return [];

    const origin = notes[0].onset;
    return collapseTimingMap(notes.map(note => ({
        date: note.date,
        sec: Math.max(0, note.onset - origin),
    })));
};

export const buildTimingMap = (
    referenceMsm: MSM,
    renderedMidi: MidiFile,
    range: Range,
): TimingMapPoint[] => {
    const refNotes = extractRefNotes(referenceMsm)
        .filter(note => note.date >= range.from && note.date <= range.to);
    const renderedNotes = extractNotesFromMidi(renderedMidi);

    if (refNotes.length === 0 || renderedNotes.length === 0) {
        return fallbackTimingMap(referenceMsm, range);
    }

    const matched = matchSubsequence(refNotes, renderedNotes, {
        dateHint: (range.from + range.to) / 2,
        dateWindow: Math.max(30000, range.to - range.from + 7200),
    });

    const points = collapseTimingMap(matched.matches.map(match => ({
        date: match.ref.date,
        sec: match.stu.onset,
    })));

    return points.length > 0 ? points : fallbackTimingMap(referenceMsm, range);
};

export const secAtDate = (timingMap: TimingMapPoint[], date: number): number => {
    if (timingMap.length === 0) return 0;
    if (date <= timingMap[0].date) return timingMap[0].sec;
    if (date >= timingMap[timingMap.length - 1].date) return timingMap[timingMap.length - 1].sec;

    for (let i = 1; i < timingMap.length; i++) {
        const left = timingMap[i - 1];
        const right = timingMap[i];
        if (date > right.date) continue;

        const span = right.date - left.date;
        if (span <= 0) return right.sec;

        const t = (date - left.date) / span;
        return left.sec + (right.sec - left.sec) * t;
    }

    return timingMap[timingMap.length - 1].sec;
};

const cuePriority = (event: StructuredDiffEvent): number =>
    severityWeight(event.severity) * 1000 + event.magnitude;

const cueCountForRange = (timingMap: TimingMapPoint[]): number => {
    if (timingMap.length < 2) return 2;
    const durationSec = timingMap[timingMap.length - 1].sec - timingMap[0].sec;
    if (durationSec < 6) return 2;
    if (durationSec < 14) return 3;
    return MAX_CUES;
};

const computeCueAtSec = (
    eventDate: number,
    nextEventDate: number | null,
    timingMap: TimingMapPoint[],
): number => {
    const anchorDate = eventDate;
    const anchorSec = secAtDate(timingMap, anchorDate);
    const nextSec = nextEventDate != null
        ? secAtDate(timingMap, nextEventDate)
        : anchorSec + CUE_DELAY_DEFAULT_REGION;
    const regionLength = Math.max(0, nextSec - anchorSec);
    return anchorSec + cueDelay(regionLength);
};

export const pickCueCandidates = (
    diffEvents: StructuredDiffEvent[],
    timingMap: TimingMapPoint[],
    maxCues: number = cueCountForRange(timingMap),
): TeacherCueCandidate[] => {
    const sorted = [...diffEvents].sort((a, b) => a.date - b.date);
    const nextDateByEvent = new Map<string, number | null>();
    for (let i = 0; i < sorted.length; i++) {
        nextDateByEvent.set(sorted[i].id, sorted[i + 1]?.date ?? null);
    }

    const candidates = diffEvents.map((event) => {
        const anchorDate = positionToTick(event.position) ?? event.date;
        return {
            position: event.position,
            anchorDate,
            event,
            atSec: computeCueAtSec(anchorDate, nextDateByEvent.get(event.id) ?? null, timingMap),
            priority: cuePriority(event),
        };
    });

    candidates.sort((a, b) => {
        const severityDelta = compareEvents(a.event, b.event);
        if (severityDelta !== 0) return severityDelta;
        return a.atSec - b.atSec;
    });

    const accepted: TeacherCueCandidate[] = [];
    const usedPositions = new Set<string>();
    for (const candidate of candidates) {
        if (usedPositions.has(candidate.position)) continue;
        const tooClose = accepted.some(existing => Math.abs(existing.atSec - candidate.atSec) < MIN_CUE_GAP_SEC);
        if (tooClose) continue;
        accepted.push(candidate);
        usedPositions.add(candidate.position);
        if (accepted.length >= maxCues) break;
    }

    return accepted.sort((a, b) => a.atSec - b.atSec);
};

export const planTeacherCues = (
    diffEvents: StructuredDiffEvent[],
    timingMap: TimingMapPoint[],
): TeacherCue[] => {
    return pickCueCandidates(diffEvents, timingMap)
        .map((candidate, index) => ({
            id: `cue_${index + 1}_${candidate.event.id}`,
            atSec: candidate.atSec,
            text: candidate.event.cueText,
            anchorDate: candidate.anchorDate,
            severity: candidate.event.severity,
            type: candidate.event.type,
            priority: candidate.priority,
        }));
};

const normalizeCueText = (text: string, fallback: string): string => {
    const normalized = text
        .replace(/\s+/g, ' ')
        .replace(/[.!?]+$/g, '')
        .trim();
    if (!normalized) return fallback;

    const leadingTagMatch = normalized.match(/^\[([a-zA-Z][a-zA-Z ]{0,23})\]\s*/);
    const normalizedTag = leadingTagMatch ? normalizeV3Tag(leadingTagMatch[1]) : null;
    const body = normalized
        .slice(leadingTagMatch?.[0].length ?? 0)
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const words = body.split(' ').filter(Boolean);
    const shortenedBody = words.length > 5 ? words.slice(0, 5).join(' ') : body;
    if (!shortenedBody) return fallback;
    if (TOO_VAGUE_CUES.has(shortenedBody.toLowerCase())) return fallback;
    if (UNCLEAR_CUE_PATTERNS.some((pattern) => pattern.test(shortenedBody))) return fallback;
    return normalizedTag ? `[${normalizedTag}] ${shortenedBody}` : shortenedBody;
};

export const resolveTeacherCuePlan = (
    diffEvents: StructuredDiffEvent[],
    timingMap: TimingMapPoint[],
    drafts: TeacherCueDraft[],
): TeacherCue[] => {
    if (drafts.length === 0) return planTeacherCues(diffEvents, timingMap);

    const byPosition = new Map<string, StructuredDiffEvent[]>();
    for (const event of diffEvents) {
        const group = byPosition.get(event.position) ?? [];
        group.push(event);
        byPosition.set(event.position, group);
    }
    const accepted: TeacherCue[] = [];
    const usedPositions = new Set<string>();

    const sortedEvents = [...diffEvents].sort((a, b) => a.date - b.date);
    const nextDateByEvent = new Map<string, number | null>();
    for (let i = 0; i < sortedEvents.length; i++) {
        nextDateByEvent.set(sortedEvents[i].id, sortedEvents[i + 1]?.date ?? null);
    }

    for (const draft of drafts) {
        const events = byPosition.get(draft.position);
        if (!events || usedPositions.has(draft.position)) continue;

        const [event] = events.slice().sort(compareEvents);
        const anchorDate = positionToTick(draft.position) ?? event.date;

        const atSec = computeCueAtSec(anchorDate, nextDateByEvent.get(event.id) ?? null, timingMap);
        const tooClose = accepted.some((cue) => Math.abs(cue.atSec - atSec) < MIN_CUE_GAP_SEC);
        if (tooClose) continue;

        accepted.push({
            id: `cue_${accepted.length + 1}_${draft.position.replace(/[^\w]+/g, '_')}`,
            atSec,
            text: normalizeCueText(draft.text, event.cueText),
            anchorDate,
            severity: event.severity,
            type: event.type,
            priority: cuePriority(event),
        });
        usedPositions.add(draft.position);

        if (accepted.length >= MAX_CUES) break;
    }

    if (accepted.length === 0) return planTeacherCues(diffEvents, timingMap);

    return accepted.sort((a, b) => a.atSec - b.atSec);
};
