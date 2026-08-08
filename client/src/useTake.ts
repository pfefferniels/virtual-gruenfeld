import { useEffect, useMemo, useRef, useState } from 'react';
import type { CuePrepMode } from './prepMode';
import type { Range } from './mpm';
import { waitForPlayingSafe } from './midi';
import { boot } from './pipeline/boot';
import { runTake } from './pipeline/takeRunner';
import { exaggeratedStrategy } from './pipeline/strategies/exaggerated';
import { probeTeacherService } from './services/api';
import { getSessionId } from './session';
import type { PlayFn } from './pipeline/types';
import { addAbsoluteTime } from './pianosound/MidiNote';

type PianoControls = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    play: (...args: any[]) => void;
    playAudioBuffer: (audioBuffer: AudioBuffer, onStart?: () => void) => Promise<void>;
    stop: () => void;
    audioContext: AudioContext;
};

export const useTake = (piano: PianoControls, inputId?: string | null) => {
    const [started, setStarted] = useState(false);
    const [cuePrepMode, setCuePrepMode] = useState<CuePrepMode>('realtime');
    const [quickJudgement, setQuickJudgement] = useState('');
    const [lastDiff, setLastDiff] = useState('');
    const [debugLines, setDebugLines] = useState<string[]>([]);
    const [aiAvailable, setAiAvailable] = useState(false);
    const [teacherPlaying, setTeacherPlaying] = useState(false);
    const teacherEndTimer = useRef<ReturnType<typeof setTimeout>>();
    const seqRef = useRef(0);

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
    const playRef = useRef(piano.play);
    const stopRef = useRef(piano.stop);
    const cuePrepModeRef = useRef<CuePrepMode>(cuePrepMode);
    const aiAvailableRef = useRef(aiAvailable);
    const takeSeqRef = useRef(0);
    playRef.current = piano.play;
    stopRef.current = piano.stop;
    cuePrepModeRef.current = cuePrepMode;
    aiAvailableRef.current = aiAvailable;

    useEffect(() => {
        probeTeacherService().then(setAiAvailable);
    }, []);

    useEffect(() => {
        if (!started) return;

        let cancelled = false;
        let disposeMidi: null | (() => void) = null;

        const run = async () => {
            try {
                const ctx = await boot(log);
                if (cancelled) return;

                const res = await waitForPlayingSafe(ctx.baseMsm, async (studentMsm, range) => {
                    if (cancelled) return;
                    lastMatchRef.current = range;

                    const takeId = ++takeSeqRef.current;
                    log(`TAKE #${takeId} (session ${getSessionId().slice(0, 8)})`);

                    await runTake(ctx, studentMsm, range, exaggeratedStrategy, {
                        log,
                        stop: () => { stopRef.current(); clearTimeout(teacherEndTimer.current); setTeacherPlaying(false); },
                        play: ((...args: Parameters<PlayFn>) => {
                            clearTimeout(teacherEndTimer.current);
                            setTeacherPlaying(true);
                            playRef.current(...args);
                            // Compute playback duration to auto-clear ghost state
                            try {
                                const events = addAbsoluteTime(args[0]);
                                const lastMs = events.reduce((m, e) => Math.max(m, e.abs), 0);
                                teacherEndTimer.current = setTimeout(() => setTeacherPlaying(false), lastMs + 3000);
                            } catch { /* fallback: stays on until next stop() */ }
                        }) as PlayFn,
                        playAudioBuffer: piano.playAudioBuffer,
                        audioContext: piano.audioContext,
                        mode: cuePrepModeRef.current,
                        isCancelled: () => cancelled || takeSeqRef.current !== takeId,
                        onDiff: setLastDiff,
                        onJudgement: setQuickJudgement,
                        aiAvailable: aiAvailableRef.current,
                    });
                }, log, () => {
                    const last = lastMatchRef.current;
                    return last ? (last.from + last.to) / 2 : undefined;
                }, inputId);

                if (!res.ok) {
                    log(`MIDI: failed -> ${res.error}`);
                    return;
                }

                disposeMidi = res.dispose;
                log('APP: ready');
            } catch (err) {
                log(`APP ERROR: ${String(err)}`);
            }
        };

        void run();

        return () => {
            cancelled = true;
            stopRef.current();
            log('APP: unmount -> disposing MIDI');
            if (disposeMidi) disposeMidi();
        };
    }, [log, started, piano.audioContext, inputId]);

    const clearDebugLines = useMemo(() => () => setDebugLines([]), []);

    return {
        started,
        setStarted,
        cuePrepMode,
        setCuePrepMode,
        quickJudgement,
        lastDiff,
        debugLines,
        clearDebugLines,
        /** The same sink the take pipeline writes to, for anything else on the page. */
        log,
        aiAvailable,
        teacherPlaying,
    };
};
