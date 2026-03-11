import { MidiFile, read } from "midifile-ts";
import { exportMPM, MPM } from "mpm-ts";
import { MSM } from "mpmify";
import type { Range, StructuredDiffEvent } from "./mpm";
import { implantLocal } from "./matcher";
import { CuePrepMode, REALTIME_CUE_AUDIO_BUDGET_MS } from "./cueLibrary";
import type { ImmediateJudgementPayload } from "./judgement";
import { buildTimingMap, pickCueCandidates, planTeacherCues, resolveTeacherCuePlan, TeacherCue, TeacherCueDraft, TimingMapPoint } from "./teacherCues";

export const assertOk = async (r: Response) => {
    if (r.ok) return;
    let text = '';
    try { text = await r.text(); } catch { /* ignore */ }
    throw new Error(`HTTP ${r.status} ${r.statusText}${text ? `: ${text}` : ''}`);
};

export const implant = (
    msm: MSM,
    midi: MidiFile,
    log: (msg: string) => void,
    dateHint?: number,
): Promise<{ studentMsm: MSM; range: Range }> => {
    if (dateHint != null) {
        log(`IMPLANT: using date_hint=${dateHint}`);
    }
    log(`IMPLANT: matching ${msm.allNotes?.length ?? 0} ref notes against student MIDI…`);

    const { studentMsm, range } = implantLocal(msm, midi, dateHint);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    log(`IMPLANT: range=[${range.from}, ${range.to}], notes: ${studentMsm.allNotes.length}, implanted: ${studentMsm.allNotes.filter((n: any) => n.source === 'implanted').length}`);
    return Promise.resolve({ studentMsm, range });
};

const readMidiBase64 = (b64: string): MidiFile => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return read(bytes.buffer);
};

type RenderedTeacherPerformance = {
    midi: MidiFile;
    timingMap: TimingMapPoint[];
};

export const performTeacherPlayback = async (
    mei: string,
    referenceMsm: MSM,
    mpm: MPM,
    range: Range,
): Promise<RenderedTeacherPerformance | undefined> => {
    console.log('performing range:', range, 'with mpm:', exportMPM(mpm));
    const response = await fetch('http://localhost:8080/perform', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mei, mpm: exportMPM(mpm),
            ...range
        }),
    });
    await assertOk(response);
    const payload = await response.json();
    const b64 = payload?.midi_b64;
    if (!b64) {
        console.log('No midi_b64 field in response');
        return;
    }

    const midi = readMidiBase64(b64);
    return {
        midi,
        timingMap: buildTimingMap(referenceMsm, midi, range),
    };
};

const decodeAudioBase64 = async (
    b64: string,
    audioContext: AudioContext,
): Promise<AudioBuffer> => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (audioContext.state === 'suspended') await audioContext.resume();
    return audioContext.decodeAudioData(bytes.buffer.slice(0));
};

export type PreparedTeacherCue = TeacherCue & {
    audioBuffer: AudioBuffer;
};

type RenderCueStats = {
    requested: number;
    returned: number;
    library_hits: number;
    library_misses: number;
    synthesized: number;
    render_cues_ms: number;
    mode: CuePrepMode;
};

const CUE_OVERLAP_PADDING_SEC = 0.08;
const MAX_MERGED_CUE_WORDS = 8;

const renderCueAudioBuffers = async (
    cues: Array<Pick<TeacherCue, 'id' | 'text'>>,
    audioContext: AudioContext,
    mode: CuePrepMode,
    libraryOnly: boolean,
    log?: (msg: string) => void,
): Promise<{ buffers: Map<string, AudioBuffer>; stats: RenderCueStats | null }> => {
    if (cues.length === 0) {
        return { buffers: new Map(), stats: null };
    }

    const response = await fetch('/render-cues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mode,
            libraryOnly,
            cues: cues.map(({ id, text }) => ({ id, text })),
        }),
    });
    await assertOk(response);

    const payload = await response.json();
    const rendered = Array.isArray(payload?.cues) ? payload.cues : [];
    const stats = typeof payload?.stats === 'object' && payload.stats !== null
        ? payload.stats as RenderCueStats
        : null;
    const renderedById = new Map<string, string>();
    for (const cue of rendered) {
        if (typeof cue?.id === 'string' && typeof cue?.audio_b64 === 'string') {
            renderedById.set(cue.id, cue.audio_b64);
        }
    }

    const decoded = new Map<string, AudioBuffer>();
    for (const cue of cues) {
        const b64 = renderedById.get(cue.id);
        if (!b64) continue;
        decoded.set(cue.id, await decodeAudioBase64(b64, audioContext));
    }
    if (stats && log) {
        log(
            `CUE audio: mode=${stats.mode} requested=${stats.requested} returned=${stats.returned} ` +
            `library_hits=${stats.library_hits} library_misses=${stats.library_misses} ` +
            `synthesized=${stats.synthesized} cue_audio_ms=${stats.render_cues_ms}`,
        );
    }
    return { buffers: decoded, stats };
};

const splitCueText = (text: string): { tag: string | null; body: string } => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    const tagMatch = normalized.match(/^\[([^\]]+)\]\s*/);
    const tag = tagMatch ? `[${tagMatch[1].trim()}]` : null;
    const body = normalized.slice(tagMatch?.[0].length ?? 0).trim();
    return { tag, body };
};

const cueWordCount = (text: string): number =>
    splitCueText(text).body.split(/[ ,]+/).filter(Boolean).length;

const mergeCueTexts = (first: string, second: string): string | null => {
    const left = splitCueText(first);
    const right = splitCueText(second);
    if (!left.body || !right.body) return null;

    if (cueWordCount(left.body) + cueWordCount(right.body) > MAX_MERGED_CUE_WORDS) {
        return null;
    }

    if (left.tag && right.tag && left.tag === right.tag) {
        return `${left.tag} ${left.body}, ${right.body}`.trim();
    }
    if (left.tag && right.tag) {
        return `${left.tag} ${left.body}, ${right.tag} ${right.body}`.trim();
    }
    if (left.tag) {
        return `${left.tag} ${left.body}, ${right.body}`.trim();
    }
    if (right.tag) {
        return `${left.body}, ${right.tag} ${right.body}`.trim();
    }
    return `${left.body}, ${right.body}`.trim();
};

const chooseStrongerCue = (left: PreparedTeacherCue, right: PreparedTeacherCue): PreparedTeacherCue => {
    if (left.priority !== right.priority) {
        return left.priority > right.priority ? left : right;
    }
    return left.atSec <= right.atSec ? left : right;
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> => {
    if (timeoutMs <= 0) return fallback;
    return await Promise.race([
        promise,
        new Promise<T>((resolve) => window.setTimeout(() => resolve(fallback), timeoutMs)),
    ]);
};

const resolvePreparedCueCollisions = async (
    prepared: PreparedTeacherCue[],
    audioContext: AudioContext,
    log: (msg: string) => void,
    mode: CuePrepMode,
    deadlineAtMs?: number,
): Promise<PreparedTeacherCue[]> => {
    const cues = prepared.slice().sort((a, b) => a.atSec - b.atSec);

    for (let i = 0; i < cues.length - 1;) {
        const current = cues[i];
        const next = cues[i + 1];
        const currentEnd = current.atSec + current.audioBuffer.duration + CUE_OVERLAP_PADDING_SEC;
        if (next.atSec >= currentEnd) {
            i++;
            continue;
        }

        const mergedText = mergeCueTexts(current.text, next.text);
        const canMergeNow = mode !== 'realtime' || (deadlineAtMs != null && Date.now() < deadlineAtMs);
        if (mergedText && canMergeNow) {
            const mergedCue: TeacherCue = {
                id: `${current.id}__${next.id}`,
                atSec: current.atSec,
                text: mergedText,
                anchorDate: current.anchorDate,
                severity: chooseStrongerCue(current, next).severity,
                type: chooseStrongerCue(current, next).type,
                priority: current.priority + next.priority,
            };
            const rendered = await renderCueAudioBuffers([mergedCue], audioContext, mode, false, log);
            const audioBuffer = rendered.buffers.get(mergedCue.id);
            if (audioBuffer) {
                log(`CUE: merged overlap "${current.text}" + "${next.text}" -> "${mergedText}"`);
                cues.splice(i, 2, { ...mergedCue, audioBuffer });
                continue;
            }
        }

        const stronger = chooseStrongerCue(current, next);
        const weaker = stronger === current ? next : current;
        log(`CUE: dropped overlapping cue "${weaker.text}" in favor of "${stronger.text}"`);
        cues.splice(stronger === current ? i + 1 : i, 1);
    }

    return cues;
};

export const prepareTeacherCues = async (
    cues: TeacherCue[],
    audioContext: AudioContext,
    log: (msg: string) => void,
    mode: CuePrepMode = 'balanced',
    deadlineAtMs?: number,
): Promise<PreparedTeacherCue[]> => {
    if (cues.length === 0) return [];

    log(`CUE: rendering ${cues.length} cue clips…`);
    const startedAt = Date.now();
    let renderedById: Map<string, AudioBuffer>;
    if (mode === 'realtime') {
        const initial = await renderCueAudioBuffers(cues, audioContext, mode, true, log);
        const missing = cues.filter((cue) => !initial.buffers.has(cue.id));
        renderedById = new Map(initial.buffers);

        if (missing.length > 0) {
            const remainingMs = deadlineAtMs != null
                ? Math.max(0, Math.min(deadlineAtMs - Date.now(), REALTIME_CUE_AUDIO_BUDGET_MS))
                : REALTIME_CUE_AUDIO_BUDGET_MS;
            const late = await withTimeout(
                renderCueAudioBuffers(missing, audioContext, mode, false, log),
                remainingMs,
                { buffers: new Map<string, AudioBuffer>(), stats: null },
            );
            for (const [id, buffer] of late.buffers.entries()) {
                renderedById.set(id, buffer);
            }
        }
    } else {
        renderedById = (await renderCueAudioBuffers(cues, audioContext, mode, false, log)).buffers;
    }

    const prepared: PreparedTeacherCue[] = [];
    for (const cue of cues) {
        const audioBuffer = renderedById.get(cue.id);
        if (!audioBuffer) continue;
        prepared.push({
            ...cue,
            audioBuffer,
        });
    }
    const collisionFree = await resolvePreparedCueCollisions(prepared, audioContext, log, mode, deadlineAtMs);
    log(`CUE: total cue_audio_ms=${Date.now() - startedAt}`);
    log(`CUE: ready ${collisionFree.length}/${cues.length}`);
    return collisionFree;
};

export const resolveTeacherCues = (
    diffEvents: StructuredDiffEvent[],
    timingMap: TimingMapPoint[],
    drafts: TeacherCueDraft[] = [],
): TeacherCue[] => (
    drafts.length > 0
        ? resolveTeacherCuePlan(diffEvents, timingMap, drafts)
        : planTeacherCues(diffEvents, timingMap)
);

export const requestTeacherCuePlan = async (
    diffSummary: string,
    diffEvents: StructuredDiffEvent[],
    mode: CuePrepMode,
    timingMap: TimingMapPoint[] | undefined,
    log: (msg: string) => void,
): Promise<TeacherCueDraft[]> => {
    if (diffEvents.length === 0) return [];

    const positions = new Map<string, StructuredDiffEvent[]>();
    if (mode === 'realtime' && timingMap) {
        for (const candidate of pickCueCandidates(diffEvents, timingMap)) {
            positions.set(candidate.position, [candidate.event]);
        }
    } else {
        for (const event of diffEvents) {
            const group = positions.get(event.position) ?? [];
            group.push(event);
            positions.set(event.position, group);
        }
    }

    log(`CUE: planning ${positions.size} beat anchors via LLM…`);
    const response = await fetch('/plan-cues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mode,
            diff: diffSummary,
            candidates: Array.from(positions.entries()).map(([position, events]) => ({
                position,
                issues: events.map((event) => ({
                    type: event.type,
                    severity: event.severity,
                    direction: event.direction,
                    primaryAttr: event.primaryAttr,
                    refValue: event.refValue,
                    studentValue: event.studentValue,
                    defaultCue: event.cueText,
                })),
            })),
        }),
    });
    await assertOk(response);

    const payload: unknown = await response.json();
    const cues: unknown[] =
        typeof payload === 'object' &&
        payload !== null &&
        Array.isArray((payload as { cues?: unknown[] }).cues)
            ? (payload as { cues: unknown[] }).cues
            : [];
    return cues.filter((cue): cue is TeacherCueDraft => {
        if (typeof cue !== 'object' || cue === null) return false;
        const candidate = cue as { position?: unknown; text?: unknown };
        return typeof candidate.position === 'string' && typeof candidate.text === 'string';
    });
};

export const requestImmediateJudgement = async (
    summary: ImmediateJudgementPayload,
    log: (msg: string) => void,
): Promise<string> => {
    const response = await fetch('/judge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary }),
    });
    await assertOk(response);

    const payload = await response.json();
    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
    log(`JUDGE: text="${text}"`);
    return text;
};

export const warmPerformEndpoint = () => {
    fetch('http://localhost:8080/perform', { method: 'OPTIONS' }).catch(() => {});
};
