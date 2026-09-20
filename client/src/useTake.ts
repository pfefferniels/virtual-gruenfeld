import { useEffect, useMemo, useRef, useState } from 'react';
import type { Range } from './mpm';
import { waitForPlayingSafe } from './midi';
import { boot } from './pipeline/boot';
import { runTake } from './pipeline/takeRunner';
import { exaggeratedStrategy } from './pipeline/strategies/exaggerated';
import type { PlayFn } from './pipeline/types';
import { addAbsoluteTime } from './pianosound/MidiNote';

type PianoControls = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    play: (...args: any[]) => void;
    stop: () => void;
    audioContext: AudioContext;
};

export const useTake = (piano: PianoControls, inputId?: string | null) => {
    const [started, setStarted] = useState(false);
    const [lastDiff, setLastDiff] = useState('');
    const [debugLines, setDebugLines] = useState<string[]>([]);
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
    const takeSeqRef = useRef(0);
    playRef.current = piano.play;
    stopRef.current = piano.stop;

    useEffect(() => {
        if (!started) return;

        let cancelled = false;
        let disposeMidi: null | (() => void) = null;

        const run = async () => {
            try {
                const ctx = await boot(log);
                if (cancelled) return;

                const res = await waitForPlayingSafe(ctx.scoreNotes, async (notes, range) => {
                    if (cancelled) return;
                    lastMatchRef.current = range;

                    const takeId = ++takeSeqRef.current;
                    log(`TAKE #${takeId}`);

                    await runTake(ctx, notes, range, exaggeratedStrategy, {
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
                        isCancelled: () => cancelled || takeSeqRef.current !== takeId,
                        onDiff: setLastDiff,
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
        // A new AudioContext really is a new session, so it belongs here; `piano.play` and
        // `piano.stop` are read through refs, because re-running this effect tears the MIDI
        // input down and re-opens it — in the middle of a take, at worst.
    }, [log, started, piano.audioContext, inputId]);

    const clearDebugLines = useMemo(() => () => setDebugLines([]), []);

    return {
        started,
        setStarted,
        lastDiff,
        debugLines,
        clearDebugLines,
        teacherPlaying,
    };
};
