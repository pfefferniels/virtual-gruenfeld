import { usePiano } from "./pianosound";
import { useTake } from "./useTake";
import type { CuePrepMode } from "./cueLibrary";

const CUE_MODE_OPTIONS: Array<{ value: CuePrepMode; label: string; hint: string }> = [
    { value: 'realtime', label: 'Realtime', hint: '~1.2s target, fast fallback' },
    { value: 'balanced', label: 'Balanced', hint: 'waits for full cue plan' },
    { value: 'studio', label: 'Studio', hint: 'max quality, slowest' },
];

export const Dialog = () => {
    const { play, playAudioBuffer, stop, unlock, audioContext } = usePiano();
    const {
        started, setStarted,
        cuePrepMode, setCuePrepMode,
        quickJudgement, lastDiff, debugLines, clearDebugLines,
        aiAvailable,
    } = useTake({ play, playAudioBuffer, stop, audioContext });

    return (
        <div style={{ display: 'grid', gap: 12 }}>
            {aiAvailable ? (
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
            ) : (
                <div style={{ border: '1px solid #d5d0c7', borderRadius: 10, padding: 10, background: '#fbf8f1', fontSize: 13, opacity: 0.85 }}>
                    <strong>Spoken feedback unavailable.</strong>{' '}
                    The teacher will respond with an exaggerated corrective performance only.
                    To enable spoken feedback,{' '}
                    <a href="https://github.com/pfefferniels/virtual-gruenfeld/blob/main/SPOKEN_FEEDBACK.md"
                       target="_blank" rel="noopener noreferrer">
                        follow the setup instructions
                    </a>.
                </div>
            )}
            {!started && (
                <button
                    onClick={() => { void unlock(); setStarted(true); }}
                    style={{ padding: '12px 24px', fontSize: 18, cursor: 'pointer' }}
                >
                    Start
                </button>
            )}
            {aiAvailable && quickJudgement && (
                <div style={{ border: '1px solid #b9d4bf', borderRadius: 10, padding: 12, background: '#f4fbf2' }}>
                    <strong style={{ display: 'block', marginBottom: 4 }}>Teacher Reaction</strong>
                    <div style={{ fontSize: 18, lineHeight: 1.3 }}>{quickJudgement}</div>
                </div>
            )}
            {aiAvailable && lastDiff && (
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
                        onClick={clearDebugLines}
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
