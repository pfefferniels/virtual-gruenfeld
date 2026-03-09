import { useEffect, useMemo, useRef, useState } from "react";
import { usePiano } from "react-pianosound";
import { MSM } from "mpmify";
import { asMSM } from "./asMSM";
import { assertOk, performAsMIDI, explainAndSpeak, warmPerformEndpoint, unlockAudio } from "./api";
import { mpmify, diff, exaggerate, Range } from "./mpm";
import { waitForPlayingSafe } from "./midi";

export const Dialog = () => {
    const [started, setStarted] = useState(false);
    const [explanation, setExplanation] = useState('');
    const [lastDiff, setLastDiff] = useState('');
    const [debugLines, setDebugLines] = useState<string[]>([]);
    const seqRef = useRef(0);
    const { play } = usePiano();

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
    playRef.current = play;

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
                const referenceMpm = mpmify(base, transformations);
                log(`MPM: referenceMpm ready (instructions=${referenceMpm.getInstructions().length})`);

                warmPerformEndpoint();

                log('MIDI: starting listener…');
                const res = await waitForPlayingSafe(base, async (studentMsm: MSM, range) => {
                    if (cancelled) return;

                    lastMatchRef.current = range;
                    log(`CALLBACK: take implanted -> range=[${range.from}, ${range.to}]`);

                    log('MPM: building studentMpm…');
                    const studentMpm = mpmify(studentMsm, transformations);
                    log(`MPM: studentMpm ready (instructions=${studentMpm.getInstructions().length})`);

                    const ref = referenceMpm.clone();
                    setExplanation('');

                    const diffSummary = diff(ref, studentMpm, range);
                    setLastDiff(diffSummary);

                    // Start exaggerate + perform immediately (don't wait for explanation)
                    exaggerate(ref, studentMpm, range, 0.4, log);
                    const performPromise = performAsMIDI(mei, ref, range);

                    // Combined explain + speak (server pipelines OpenAI → ElevenLabs)
                    const speakPromise = explainAndSpeak(diffSummary, (delta) => {
                        if (cancelled) return;
                        setExplanation((prev) => prev + delta);
                    }, log).catch(e => log(`EXPLAIN+SPEAK error: ${e}`));

                    // Wait for speech and MIDI rendering to complete
                    const [, midi] = await Promise.all([speakPromise, performPromise]);

                    if (cancelled) return;
                    if (midi) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        playRef.current(midi as any);
                        log('PLAY: done');
                    }
                }, log, () => {
                    const last = lastMatchRef.current;
                    return last ? (last.from + last.to) / 2 : undefined;
                });

                if (!res.ok) {
                    setExplanation(res.error);
                    log(`MIDI: failed -> ${res.error}`);
                    return;
                }

                disposeMidi = res.dispose;
                log('APP: ready');
            } catch (err) {
                const msg = `APP ERROR: ${String(err)}`;
                setExplanation(msg);
                log(msg);
            }
        };

        void boot();

        return () => {
            cancelled = true;
            log('APP: unmount -> disposing MIDI');
            if (disposeMidi) disposeMidi();
        };
    }, [log, started]);

    return (
        <div style={{ display: 'grid', gap: 12 }}>
            {!started && (
                <button
                    onClick={() => { unlockAudio(); setStarted(true); }}
                    style={{ padding: '12px 24px', fontSize: 18, cursor: 'pointer' }}
                >
                    Start
                </button>
            )}
            <div>{explanation}</div>

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
