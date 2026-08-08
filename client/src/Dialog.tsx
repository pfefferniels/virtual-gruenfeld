import { useMemo, useState } from "react";
import { usePiano } from "./pianosound";
import { useTake } from "./useTake";
import { useMidiDevices } from "./useMidiDevices";
import type { MidiDeviceInfo } from "./useMidiDevices";
import type { CuePrepMode } from "./cueLibrary";
import { isVoiceTeacher } from "./featureFlags";
import { useVoiceQuestion } from "./useVoiceQuestion";

const CUE_MODE_OPTIONS: Array<{ value: CuePrepMode; label: string; hint: string }> = [
    { value: 'realtime', label: 'Realtime', hint: '~1.3s, compact scholarly context' },
    { value: 'balanced', label: 'Balanced', hint: '~2s, full scholarly context' },
    { value: 'studio', label: 'Studio', hint: 'full context, most detailed cues' },
];

const ghostKeyframes = `
@keyframes ghostFlicker {
    0%   { opacity: 1; }
    4%   { opacity: 0.75; }
    8%   { opacity: 0.95; }
    12%  { opacity: 0.6; }
    16%  { opacity: 0.9; }
    20%  { opacity: 1; }
    50%  { opacity: 0.85; }
    54%  { opacity: 0.7; }
    58%  { opacity: 0.95; }
    80%  { opacity: 0.9; }
    84%  { opacity: 0.6; }
    88%  { opacity: 1; }
    100% { opacity: 0.85; }
}
`;

const selectStyle: React.CSSProperties = {
    padding: '4px 8px',
    fontSize: 12,
    fontFamily: 'inherit',
    border: '2px solid #333',
    borderRadius: 2,
    background: '#fff',
    color: '#222',
    cursor: 'pointer',
    minWidth: 0,
    maxWidth: '100%',
};

const DeviceSelect = ({ label, devices, selectedId, onChange }: {
    label: string;
    devices: MidiDeviceInfo[];
    selectedId: string | null;
    onChange: (id: string) => void;
}) => {
    if (devices.length === 0) return null;

    const displayName = (d: MidiDeviceInfo) =>
        d.manufacturer ? `${d.name} (${d.manufacturer})` : d.name;

    if (devices.length === 1) {
        return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, opacity: 0.5, flexShrink: 0 }}>{label}:</span>
                <span style={{ fontSize: 12 }}>{displayName(devices[0])}</span>
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, opacity: 0.5, flexShrink: 0 }}>{label}:</span>
            <select
                value={selectedId ?? ''}
                onChange={e => onChange(e.target.value)}
                style={selectStyle}
            >
                {devices.map(d => (
                    <option key={d.id} value={d.id}>{displayName(d)}</option>
                ))}
            </select>
        </div>
    );
};

export const Dialog = () => {
    const midi = useMidiDevices();
    const { play, playAudioBuffer, stop, unlock, audioContext } = usePiano(midi.selectedOutputId);
    const {
        started, setStarted,
        cuePrepMode, setCuePrepMode,
        quickJudgement, lastDiff, debugLines, clearDebugLines, log,
        aiAvailable,
        teacherPlaying,
    } = useTake({ play, playAudioBuffer, stop, audioContext }, midi.selectedInputId);

    const hasInput = midi.inputs.length > 0;
    const hasOutput = midi.outputs.length > 0;
    const canStart = hasInput && midi.supported === true;
    const [showHelp, setShowHelp] = useState(false);

    // Off by default: without the flag the page has no microphone UI at all, and
    // the hook never asks for a device.
    const voiceEnabled = useMemo(() => isVoiceTeacher(), []);
    const voice = useVoiceQuestion({ mode: cuePrepMode, audioContext, playAudioBuffer, log });
    const showVoice = voiceEnabled && aiAvailable;
    const voiceAnswer = voiceEnabled ? voice.answer : null;

    const askLabel = voice.recording ? 'Listening — release to ask'
        : voice.thinking ? 'Thinking...'
        : voice.speaking ? 'Answering...'
        : 'Hold to ask';

    return (
        <>
            <style>{ghostKeyframes}</style>
            <div style={{
                position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0,
                background: teacherPlaying
                    ? 'radial-gradient(ellipse at 50% 40%, rgba(80,90,110,0.12) 0%, rgba(20,20,35,0.35) 100%)'
                    : 'none',
                transition: teacherPlaying ? 'background 1.5s ease-in' : 'background 2s ease-out',
            }} />

            <div style={{
                display: 'flex',
                minHeight: '100vh',
                position: 'relative',
                zIndex: 1,
                filter: teacherPlaying ? 'saturate(0.3) brightness(0.88)' : 'none',
                transition: teacherPlaying ? 'filter 1.5s ease-in' : 'filter 2s ease-out',
                animation: teacherPlaying ? 'ghostFlicker 3.5s ease-in-out infinite' : 'none',
            }}>
                {/* Main content */}
                <div style={{ flex: 1, padding: 32, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 24 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <h1 style={{
                            margin: 0,
                            fontSize: 26,
                            fontWeight: 400,
                            letterSpacing: '0.01em',
                            color: '#222',
                        }}>
                            Virtual Grünfeld
                        </h1>
                        <button
                            className="sketch-btn"
                            onClick={() => setShowHelp(true)}
                            style={{
                                padding: '2px 8px',
                                fontSize: 12,
                                fontFamily: 'inherit',
                                color: '#555',
                                cursor: 'pointer',
                            }}
                        >
                            ?
                        </button>
                    </div>

                    {/* MIDI device status */}
                    <div className="sketch-box" style={{
                        padding: 14,
                        background: canStart ? '#fff' : '#fff5f5',
                        display: 'grid',
                        gap: 8,
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{
                                display: 'inline-block',
                                width: 8, height: 8,
                                borderRadius: '50%',
                                background: midi.supported === null ? '#bbb'
                                    : !midi.supported ? '#c44'
                                    : hasInput ? '#5a5' : '#c90',
                            }} />
                            <strong style={{ fontSize: 13 }}>MIDI</strong>
                            {midi.supported === null && (
                                <span style={{ fontSize: 12, opacity: 0.5 }}>Detecting devices...</span>
                            )}
                            {midi.supported === false && (
                                <span style={{ fontSize: 12, color: '#944' }}>
                                    Web MIDI not supported by this browser
                                </span>
                            )}
                        </div>

                        {midi.supported && !hasInput && (
                            <div style={{ fontSize: 12, color: '#944', lineHeight: 1.4 }}>
                                No MIDI input device found. Connect a MIDI keyboard to begin.
                            </div>
                        )}

                        {midi.supported && hasInput && (
                            <DeviceSelect
                                label="Input"
                                devices={midi.inputs}
                                selectedId={midi.selectedInputId}
                                onChange={midi.setSelectedInputId}
                            />
                        )}

                        {midi.supported && hasOutput && (
                            <DeviceSelect
                                label="Output"
                                devices={midi.outputs}
                                selectedId={midi.selectedOutputId}
                                onChange={midi.setSelectedOutputId}
                            />
                        )}

                        {midi.supported && hasInput && !hasOutput && (
                            <div style={{ fontSize: 11, opacity: 0.45, lineHeight: 1.3 }}>
                                No MIDI output found. Teacher playback will use the built-in piano sound.
                            </div>
                        )}
                    </div>

                    {aiAvailable ? (
                        <div className="sketch-box" style={{ padding: 16, background: '#fff', display: 'grid', gap: 10 }}>
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                                <strong style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Teacher Cue Mode</strong>
                                <span style={{ fontSize: 11, opacity: 0.45 }}>
                                    — latency vs quality
                                </span>
                            </div>
                            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                {CUE_MODE_OPTIONS.map((option) => {
                                    const active = cuePrepMode === option.value;
                                    return (
                                        <button
                                            key={option.value}
                                            type="button"
                                            className="sketch-btn"
                                            onClick={() => setCuePrepMode(option.value)}
                                            style={{
                                                padding: '8px 14px',
                                                cursor: 'pointer',
                                                display: 'grid',
                                                gap: 2,
                                                textAlign: 'left',
                                                minWidth: 120,
                                                fontFamily: 'inherit',
                                                fontSize: 13,
                                                color: '#222',
                                                background: active ? '#e8e8e8' : '#fff',
                                                borderWidth: active ? 3 : 2,
                                            }}
                                        >
                                            <span style={{ fontWeight: active ? 700 : 500 }}>{option.label}</span>
                                            <span style={{ fontSize: 11, opacity: 0.5 }}>{option.hint}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ) : (
                        <div className="sketch-box" style={{ padding: 14, background: '#fff', fontSize: 12, opacity: 0.85 }}>
                            <strong>Spoken feedback unavailable.</strong>{' '}
                            The teacher will respond with an exaggerated corrective performance only.
                            To enable spoken feedback,{' '}
                            <a href="https://github.com/pfefferniels/virtual-gruenfeld/blob/main/SPOKEN_FEEDBACK.md"
                               target="_blank" rel="noopener noreferrer"
                               style={{ color: '#333' }}>
                                follow the setup instructions
                            </a>.
                        </div>
                    )}

                    {!started && (
                        <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
                            <button
                                className="sketch-btn"
                                onClick={() => { void unlock(); setStarted(true); }}
                                disabled={!canStart}
                                style={{
                                    padding: '14px 52px',
                                    fontSize: 16,
                                    fontFamily: 'inherit',
                                    fontWeight: 500,
                                    cursor: canStart ? 'pointer' : 'not-allowed',
                                    color: canStart ? '#222' : '#999',
                                    letterSpacing: '0.08em',
                                    textTransform: 'uppercase',
                                    opacity: canStart ? 1 : 0.5,
                                }}
                            >
                                Start
                            </button>
                        </div>
                    )}

                    {showVoice && (
                        <div className="sketch-box" style={{ padding: 14, background: '#fff', display: 'grid', gap: 8 }}>
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                                <strong style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Ask the teacher</strong>
                                <span style={{ fontSize: 11, opacity: 0.45 }}>— hold the button and speak</span>
                            </div>
                            <div>
                                <button
                                    type="button"
                                    className="sketch-btn"
                                    disabled={!voice.supported || voice.thinking}
                                    onPointerDown={(e) => { e.preventDefault(); void voice.start(); }}
                                    onPointerUp={voice.stop}
                                    onPointerLeave={voice.stop}
                                    onPointerCancel={voice.stop}
                                    style={{
                                        padding: '10px 22px',
                                        fontSize: 14,
                                        fontFamily: 'inherit',
                                        cursor: voice.supported && !voice.thinking ? 'pointer' : 'not-allowed',
                                        color: '#222',
                                        background: voice.recording ? '#f3f4f6' : '#fff',
                                        borderWidth: voice.recording ? 3 : 2,
                                        touchAction: 'none',
                                        userSelect: 'none',
                                        opacity: voice.supported ? 1 : 0.5,
                                    }}
                                >
                                    {askLabel}
                                </button>
                            </div>
                            {!voice.supported && (
                                <div style={{ fontSize: 12, color: '#944' }}>
                                    This browser cannot record audio, so spoken questions are unavailable.
                                </div>
                            )}
                            {voice.message && (
                                <div style={{ fontSize: 12, color: '#944' }}>{voice.message}</div>
                            )}
                        </div>
                    )}

                    {aiAvailable && (quickJudgement || voiceAnswer) && (
                        <div className="sketch-box" style={{ padding: 14, background: '#fff' }}>
                            <strong style={{ display: 'block', marginBottom: 6, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.45 }}>Teacher Reaction</strong>
                            {quickJudgement && (
                                <div style={{ fontSize: 16, lineHeight: 1.5 }}>{quickJudgement}</div>
                            )}
                            {voiceAnswer && (
                                <div style={{
                                    marginTop: quickJudgement ? 12 : 0,
                                    paddingTop: quickJudgement ? 10 : 0,
                                    borderTop: quickJudgement ? '1px solid #e5e7eb' : 'none',
                                }}>
                                    <div style={{ fontSize: 12, opacity: 0.45, marginBottom: 4 }}>
                                        You asked: "{voiceAnswer.transcript}"
                                    </div>
                                    <div style={{ fontSize: 16, lineHeight: 1.5 }}>{voiceAnswer.answerText}</div>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Right sidebar: logs */}
                <div style={{
                    width: '20%',
                    minWidth: 200,
                    maxWidth: 340,
                    borderLeft: '2px solid #333',
                    background: '#eeece6',
                    padding: '16px 12px',
                    display: 'grid',
                    alignContent: 'start',
                    gap: 12,
                    overflow: 'hidden',
                    fontSize: 10,
                    color: '#444',
                }}>
                    {aiAvailable && lastDiff && (
                        <details style={{ borderBottom: '1px solid #ccc', paddingBottom: 8 }}>
                            <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                Diff sent to LLM
                            </summary>
                            <pre style={{ margin: '6px 0 0', fontSize: 9, lineHeight: 1.35, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                                {lastDiff}
                            </pre>
                        </details>
                    )}

                    <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                            <strong style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Log</strong>
                            <button
                                className="sketch-btn"
                                onClick={clearDebugLines}
                                style={{
                                    padding: '2px 8px',
                                    cursor: 'pointer',
                                    fontSize: 9,
                                    fontFamily: 'inherit',
                                    color: '#555',
                                }}
                            >
                                Clear
                            </button>
                            <span style={{ opacity: 0.4, fontSize: 9 }}>{debugLines.length}</span>
                        </div>

                        <pre
                            style={{
                                margin: 0,
                                maxHeight: 'calc(100vh - 120px)',
                                overflow: 'auto',
                                fontSize: 9,
                                lineHeight: 1.3,
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-all',
                                fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace',
                            }}
                        >
                            {debugLines.join('\n')}
                        </pre>
                    </div>
                </div>
            </div>

            {showHelp && (
                <div
                    style={{
                        position: 'fixed', inset: 0, zIndex: 100,
                        background: 'rgba(0,0,0,0.3)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                    onClick={() => setShowHelp(false)}
                >
                    <div
                        className="sketch-box"
                        onClick={e => e.stopPropagation()}
                        style={{
                            background: '#fff',
                            padding: 28,
                            maxWidth: 480,
                            lineHeight: 1.6,
                            fontSize: 14,
                        }}
                    >
                        <h2 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 500 }}>What is this?</h2>
                        <p style={{ margin: '0 0 10px' }}>
                            <strong>Virtual Grünfeld</strong> is a dialogic piano teaching prototype.
                            It listens to you playing Schumann's <em>Träumerei</em> and responds
                            like a virtual teacher modeled after the pianist Alfred Grünfeld.
                        </p>
                        <h3 style={{ margin: '16px 0 6px', fontSize: 15, fontWeight: 500 }}>How to use</h3>
                        <ol style={{ margin: 0, paddingLeft: 20 }}>
                            <li>Connect a MIDI keyboard.</li>
                            <li>Press <strong>Start</strong> and play <em>Träumerei</em>.</li>
                            <li>After each take the teacher responds with an exaggerated
                                corrective performance — and, if the AI service is running,
                                spoken feedback.</li>
                        </ol>
                        <div style={{ marginTop: 20, textAlign: 'right' }}>
                            <button
                                className="sketch-btn"
                                onClick={() => setShowHelp(false)}
                                style={{
                                    padding: '6px 20px',
                                    fontSize: 13,
                                    fontFamily: 'inherit',
                                    cursor: 'pointer',
                                    color: '#222',
                                }}
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};
