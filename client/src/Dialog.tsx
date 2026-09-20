import { useState } from "react";
import { usePiano } from "./pianosound";
import { useLiveLesson } from "./useLiveLesson";
import { useMidiDevices } from "./useMidiDevices";
import type { MidiDeviceInfo } from "./useMidiDevices";

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
    const { play, stop, unlock } = usePiano(midi.selectedOutputId);
    const {
        started, start,
        position, lines, clearLines,
        teacherPlaying,
    } = useLiveLesson(midi.selectedInputId, midi.selectedOutputId, { play, stop });

    const hasInput = midi.inputs.length > 0;
    const hasOutput = midi.outputs.length > 0;
    const canStart = hasInput && midi.supported === true;
    const [showHelp, setShowHelp] = useState(false);

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

                    {!started && (
                        <div style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
                            <button
                                className="sketch-btn"
                                onClick={() => { void unlock(); start(); }}
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
                </div>

                {/* Right sidebar: logs */}
                <div style={{
                    width: '20%',
                    minWidth: 200,
                    maxWidth: 340,
                    borderLeft: '2px solid #333',
                    background: '#f3f4f6',
                    padding: '16px 12px',
                    display: 'grid',
                    alignContent: 'start',
                    gap: 12,
                    overflow: 'hidden',
                    fontSize: 10,
                    color: '#444',
                }}>
                    {position !== '—' && (
                        <details style={{ borderBottom: '1px solid #e5e7eb', paddingBottom: 8 }}>
                            <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                Measured deviations
                            </summary>
                            <pre style={{ margin: '6px 0 0', fontSize: 9, lineHeight: 1.35, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                                {position}
                            </pre>
                        </details>
                    )}

                    <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                            <strong style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Log</strong>
                            <button
                                className="sketch-btn"
                                onClick={clearLines}
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
                            <span style={{ opacity: 0.4, fontSize: 9 }}>{lines.length}</span>
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
                            {lines.join('\n')}
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
                            It listens to you playing Schumann's <em>Träumerei</em> and answers by
                            playing, as the pianist Alfred Grünfeld might have.
                        </p>
                        <h3 style={{ margin: '16px 0 6px', fontSize: 15, fontWeight: 500 }}>How to use</h3>
                        <ol style={{ margin: 0, paddingLeft: 20 }}>
                            <li>Connect a MIDI keyboard.</li>
                            <li>Press <strong>Start</strong> and play <em>Träumerei</em>.</li>
                            <li>After each take the teacher answers with an exaggerated
                                corrective performance.</li>
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
