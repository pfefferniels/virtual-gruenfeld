import { useEffect, useMemo, useRef, useState } from "react";
import { CuePrepMode, REALTIME_PLAN_BUDGET_MS, REALTIME_PLAYBACK_DEADLINE_MS } from "./cueLibrary";
import { usePiano } from "./pianosound";
import { MSM } from "mpmify";
import { asMSM } from "./asMSM";
import { assertOk, performTeacherPlayback, prepareTeacherCues, PreparedTeacherCue, requestImmediateJudgement, requestTeacherCuePlan, resolveTeacherCues, warmPerformEndpoint } from "./api";
import { fallbackImmediateJudgement, summarizeImmediateJudgement } from "./judgement";
import { mpmify, diff, diffStructured, exaggerate, Range } from "./mpm";
import { waitForPlayingSafe } from "./midi";
import type { TeacherCueDraft } from "./teacherCues";

const CUE_MODE_OPTIONS: Array<{ value: CuePrepMode; label: string; hint: string }> = [
    { value: 'realtime', label: 'Realtime', hint: '~1.2s target, fast fallback' },
    { value: 'balanced', label: 'Balanced', hint: 'waits for full cue plan' },
    { value: 'studio', label: 'Studio', hint: 'max quality, slowest' },
];
const QUICK_JUDGEMENT_BUDGET_MS = 450;

export const Dialog = () => {
    const [started, setStarted] = useState(false);
    const [cuePrepMode, setCuePrepMode] = useState<CuePrepMode>('realtime');
    const [quickJudgement, setQuickJudgement] = useState('');
    const [lastDiff, setLastDiff] = useState('');
    const [debugLines, setDebugLines] = useState<string[]>([]);
    const seqRef = useRef(0);
    const { play, stop, unlock, audioContext } = usePiano();

    const log = useMemo(() => {
        const MAX_LINES = 500;
        return (msg: string) => {
            const n = ++seqRef.current;
            const line = `${n.toString().padStart(4, '0')} ${new Date().toISOString()} ${msg}`;
            console.log(line);
            setDebugLines((prev) => {
                const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev.slice();
                next.push(line);
                return next;
            });
        };
    }, []);

    const lastMatchRef = useRef<Range | null>(null);
    const playRef = useRef(play);
    const stopRef = useRef(stop);
    const cuePrepModeRef = useRef<CuePrepMode>(cuePrepMode);
    const takeSeqRef = useRef(0);
    playRef.current = play;
    stopRef.current = stop;
    cuePrepModeRef.current = cuePrepMode;

    useEffect(() => {
        if (!started) return;

        let cancelled = false;
        let disposeMidi: null | (() => void) = null;

        const boot = async () => {
            try {
                log('APP: boot');

                log('FETCH: info.json');
                let response = await fetch('info.json');
                await assertOk(response);
                const transformations = await response.text();
                log(`FETCH: info.json ok (bytes=${transformations.length})`);

                log('FETCH: score.mei');
                response = await fetch('score.mei');
                await assertOk(response);
                const mei = await response.text();
                log(`FETCH: score.mei ok (bytes=${mei.length})`);

                log('MSM: asMSM(score.mei)…');
                const base = await asMSM(mei);
                log(`MSM: ready (notes=${JSON.stringify(base.allNotes[0]) ?? 'unknown'})`);

                log('MPM: building referenceMpm…');
                const referenceMpm = mpmify(base, transformations, { log });
                log(`MPM: referenceMpm ready (instructions=${referenceMpm.getInstructions().length})`);

                warmPerformEndpoint();

                log('MIDI: starting listener…');
                const res = await waitForPlayingSafe(base, async (studentMsm: MSM, range) => {
                    if (cancelled) return;

                    const takeStartedAt = Date.now();
                    lastMatchRef.current = range;
                    log(`CALLBACK: take implanted -> range=[${range.from}, ${range.to}]`);
                    stopRef.current();

                    log('MPM: building studentMpm…');
                    const studentMpm = mpmify(studentMsm, transformations, { referenceMsm: base, log });
                    log(`MPM: studentMpm ready (instructions=${studentMpm.getInstructions().length})`);

                    const takeId = ++takeSeqRef.current;
                    const ref = referenceMpm.clone();

                    const diffSummary = diff(referenceMpm, studentMpm, range);
                    const structuredDiff = diffStructured(referenceMpm, studentMpm, range);
                    const judgementSummary = summarizeImmediateJudgement(structuredDiff, range);
                    setLastDiff(diffSummary);
                    setQuickJudgement('');

                    exaggerate(ref, studentMpm, range, 0.4, log);

                    try {
                        const mode = cuePrepModeRef.current;
                        log(`CUE: mode=${mode}`);
                        const fallbackJudgement = fallbackImmediateJudgement(judgementSummary);
                        const judgementStartedAt = Date.now();
                        const judgementPromise = requestImmediateJudgement(judgementSummary, log)
                            .then((text) => {
                                log(`JUDGE: judgement_ms=${Date.now() - judgementStartedAt}`);
                                if (!cancelled && takeSeqRef.current === takeId && text) {
                                    setQuickJudgement(text);
                                }
                                return text;
                            })
                            .catch((e) => {
                                log(`JUDGE error: ${e}`);
                                return '';
                            });
                        window.setTimeout(() => {
                            if (!cancelled && takeSeqRef.current === takeId) {
                                setQuickJudgement((prev) => prev || fallbackJudgement);
                            }
                        }, QUICK_JUDGEMENT_BUDGET_MS);
                        const playbackDeadlineAt = mode === 'realtime'
                            ? Date.now() + REALTIME_PLAYBACK_DEADLINE_MS
                            : undefined;
                        const planStartedAt = Date.now();
                        const performStartedAt = Date.now();
                        const performance = await performTeacherPlayback(mei, base, ref, range);
                        log(`PLAY: perform_ms=${Date.now() - performStartedAt}`);
                        if (cancelled || !performance || takeSeqRef.current !== takeId) return;
                        void judgementPromise;

                        const cueDraftPromise = requestTeacherCuePlan(diffSummary, structuredDiff, mode, performance.timingMap, log)
                            .then((drafts) => {
                                log(`CUE: plan_cues_ms=${Date.now() - planStartedAt} drafted=${drafts.length}`);
                                return drafts;
                            })
                            .catch((e) => {
                                log(`CUE plan error: ${e}`);
                                return [];
                            });

                        let drafted: TeacherCueDraft[] = [];
                        if (mode === 'realtime') {
                            const remainingMs = Math.max(0, Math.min((playbackDeadlineAt ?? Date.now()) - Date.now(), REALTIME_PLAN_BUDGET_MS));
                            drafted = await Promise.race([
                                cueDraftPromise,
                                new Promise<typeof drafted>((resolve) => window.setTimeout(() => resolve([]), remainingMs)),
                            ]);
                        } else {
                            drafted = await cueDraftPromise;
                        }
                        const cuePlan = resolveTeacherCues(structuredDiff, performance.timingMap, drafted);
                        let preparedCues: PreparedTeacherCue[] = [];
                        try {
                            preparedCues = await prepareTeacherCues(cuePlan, audioContext, log, mode, playbackDeadlineAt);
                        } catch (e) {
                            log(`CUE prepare error: ${e}`);
                        }

                        if (cancelled || takeSeqRef.current !== takeId) return;

                        log(`PLAY: time_to_play_ms=${Date.now() - takeStartedAt}`);
                        log(`PLAY: piano starting (cues=${preparedCues.length})`);
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        playRef.current(performance.midi as any, undefined, ({ scheduleAudioCue }) => {
                            for (const cue of preparedCues) {
                                scheduleAudioCue({
                                    atSec: cue.atSec,
                                    audioBuffer: cue.audioBuffer,
                                    onStart: () => {
                                        log(`CUE: trigger "${cue.text}" at ${cue.atSec.toFixed(2)}s`);
                                    },
                                });
                            }
                        });
                    } catch (e) {
                        log(`PERFORM error: ${e}`);
                    }
                }, log, () => {
                    const last = lastMatchRef.current;
                    return last ? (last.from + last.to) / 2 : undefined;
                });

                if (!res.ok) {
                    log(`MIDI: failed -> ${res.error}`);
                    return;
                }

                disposeMidi = res.dispose;
                log('APP: ready');
            } catch (err) {
                const msg = `APP ERROR: ${String(err)}`;
                log(msg);
            }
        };

        void boot();

        return () => {
            cancelled = true;
            stopRef.current();
            log('APP: unmount -> disposing MIDI');
            if (disposeMidi) disposeMidi();
        };
    }, [log, started]);

    return (
        <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ border: '1px solid #d5d0c7', borderRadius: 10, padding: 10, background: '#fbf8f1', display: 'grid', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <strong>Teacher Cue Mode</strong>
                    <span style={{ fontSize: 12, opacity: 0.75 }}>
                        Choose latency vs quality for the next take.
                    </span>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {CUE_MODE_OPTIONS.map((option) => {
                        const active = cuePrepMode === option.value;
                        return (
                            <button
                                key={option.value}
                                type="button"
                                onClick={() => setCuePrepMode(option.value)}
                                style={{
                                    padding: '8px 12px',
                                    borderRadius: 999,
                                    border: active ? '1px solid #1a4f63' : '1px solid #b5b0a5',
                                    background: active ? '#d8ecf4' : '#fffdf8',
                                    color: '#1f2328',
                                    cursor: 'pointer',
                                    display: 'grid',
                                    gap: 2,
                                    textAlign: 'left',
                                    minWidth: 140,
                                }}
                            >
                                <span style={{ fontWeight: 700 }}>{option.label}</span>
                                <span style={{ fontSize: 12, opacity: 0.75 }}>{option.hint}</span>
                            </button>
                        );
                    })}
                </div>
            </div>
            {!started && (
                <button
                    onClick={() => { void unlock(); setStarted(true); }}
                    style={{ padding: '12px 24px', fontSize: 18, cursor: 'pointer' }}
                >
                    Start
                </button>
            )}
            {quickJudgement && (
                <div style={{ border: '1px solid #b9d4bf', borderRadius: 10, padding: 12, background: '#f4fbf2' }}>
                    <strong style={{ display: 'block', marginBottom: 4 }}>Teacher Reaction</strong>
                    <div style={{ fontSize: 18, lineHeight: 1.3 }}>{quickJudgement}</div>
                </div>
            )}
            {lastDiff && (
                <details open style={{ border: '1px solid #a0a0ff', borderRadius: 8, padding: 8, background: '#f4f4ff' }}>
                    <summary style={{ cursor: 'pointer', fontWeight: 'bold', fontSize: 13 }}>
                        Diff sent to LLM
                    </summary>
                    <pre style={{ margin: '8px 0 0', fontSize: 12, lineHeight: 1.4, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {lastDiff}
                    </pre>
                </details>
            )}

            <div style={{ border: '1px solid #ccc', borderRadius: 8, padding: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <strong>Debug</strong>
                    <button
                        onClick={() => setDebugLines([])}
                        style={{ padding: '4px 8px', cursor: 'pointer' }}
                    >
                        Clear
                    </button>
                    <span style={{ opacity: 0.7, fontSize: 12 }}>{debugLines.length} lines</span>
                </div>

                <pre
                    style={{
                        margin: 0,
                        maxHeight: 260,
                        overflow: 'auto',
                        fontSize: 12,
                        lineHeight: 1.35,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                    }}
                >
                    {debugLines.join('\n')}
                </pre>
            </div>
        </div>
    );
};
