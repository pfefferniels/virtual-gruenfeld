import { usePiano } from "react-pianosound";
import { read } from "midifile-ts";
import { useEffect, useRef, useState } from "react";
import { Pause, Psychology, Send } from "@mui/icons-material";
import ScorePanel from "./components/ScorePanel";
import { Button, Paper, Stack, TextField } from "@mui/material";
import { Chat } from "./Chat";

type Step = {
    stepId: string;
    overlap: boolean;
    decisions: string[];
    mode: "all" | "harmony-only" | "melody-only";
    exaggeration: number;
    type: "explanation";
    message: string;
    emotion: string;
    audio: string | null;
    midi: string | null;
    noteIDs: string[];
}

class Scheduler {
    private buffer: Step[] = [];
    private running = false;

    onStep?: (step: Step) => Promise<void>;
    onCancel?: () => void;

    push(step: Step) {
        this.buffer.push(step);
        console.log('pushing step to buffer. Running?', this.running);
        if (!this.running) this.run();
    }

    private async run() {
        if (this.running) return;
        this.running = true;

        console.log('running', this.buffer, this.running);

        try {
            while (this.running && this.buffer.length > 0) {
                console.log('trying to execute step. Buffer length:', this.buffer.length, this.onStep);
                if (!this.onStep) break;

                const step = this.buffer.shift()!;
                await this.onStep(step);
            }
        } finally {
            this.running = false;
        }
    }

    stop() {
        if (this.onCancel) this.onCancel();
        this.running = false;
        this.buffer = [];
    }
}

async function sendAck(
    sessionId: string | null,
    stepId: string,
    status: "started" | "finished"
) {
    if (!sessionId) return;
    try {
        const res = await fetch(`/lesson/${sessionId}/ack`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stepId, status }),
        });
        if (!res.ok) console.warn("ACK failed:", await res.text());
    } catch (err) {
        console.error("Failed to send ACK:", err);
    }
}



export const App = () => {
    const [currentStep, setCurrentStep] = useState<Step | null>(null);
    const [currentNoteIDs, setCurrentNoteIDs] = useState<string[]>([]);
    const [status, setStatus] = useState<'thinking' | 'running' | 'idle'>('idle');

    const { play, stop, playSingleNote } = usePiano();

    const sessionId = useRef<string>()
    const scheduler = useRef<Scheduler>(new Scheduler())
    const eventSource = useRef<EventSource>()

    let audio: HTMLAudioElement | null = null;

    const onStep = async (step: Step) => {
        console.log('onStep', step);
        if (!sessionId.current || !step.audio || !step.midi) return

        setCurrentStep(step);

        audio = new Audio("data:audio/mpeg;base64," + step.audio);

        const started = new Promise<void>(resolve => {
            audio?.addEventListener("play", () => resolve(), { once: true });
        });

        const finished = new Promise<void>(resolve => {
            audio?.addEventListener("ended", () => resolve(), { once: true });
        });

        await new Promise<void>(res => setTimeout(res, 1000)); // slight delay to improve naturalness

        audio.play().catch(e => console.error("Audio play error:", e));

        started.then(() => {
            sendAck(sessionId.current || '', step.stepId, "started");
        });

        const binary = atob(step.midi);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const midiBuf = bytes.buffer;

        const file = read(midiBuf);

        const totalTracks = file.tracks.length;
        let tracksEnded = 0;

        const cb = (resolve: () => void) => {
            play(file as any, (e) => {
                if (e.type === 'meta') {
                    if (e.subtype === 'text') {
                        const meiId = e.text;
                        document.querySelector('#' + meiId)?.setAttribute('fill', 'red')
                        setTimeout(() => {
                            document.querySelector('#' + meiId)?.removeAttribute('fill');
                        }, 200);
                    }
                    else if (e.subtype === 'endOfTrack') {
                        tracksEnded++;
                        if (tracksEnded === totalTracks) {
                            resolve();
                        }
                    }
                }
            });
        }

        if (step.overlap) {
            await Promise.all([finished, new Promise<void>(cb)])
        }
        else {
            await finished;
            await new Promise<void>(cb)
        }
    }

    const onCancel = () => {
        if (audio) {
            audio.pause();
            audio = null;
        }
        stop();
        setStatus('idle');
    }

    const ask = async (question: string) => {
        scheduler.current.stop();

        if (eventSource.current) {
            eventSource.current.close();
        }

        // setup scheduler
        if (!scheduler.current.onStep) {
            scheduler.current.onStep = onStep;
        }

        if (!scheduler.current.onCancel) {
            scheduler.current.onCancel = onCancel;
        }

        let url = `/lesson?question=${question}`;
        if (currentNoteIDs.length > 0) {
            url += `&at=${currentNoteIDs.join(',')}`;
        }
        if (sessionId.current) {
            url += `&session=${sessionId.current}`;
        }

        eventSource.current = new EventSource(url, { withCredentials: true });
        const evtSource = eventSource.current;

        evtSource.addEventListener("session", (e) => {
            const data = JSON.parse((e as MessageEvent).data);
            sessionId.current = data.sessionId;
            setStatus("thinking");
        });

        evtSource.addEventListener("step", (e) => {
            const step: Step = JSON.parse((e as MessageEvent).data);
            console.log('pushing step', step, 'into', scheduler.current);
            scheduler.current.push(step);
            setStatus('running')
        });

        evtSource.onerror = (err) => {
            console.error("SSE error:", err);
            // setStatus("Connection error. Please try again.");
            evtSource.close();
            setStatus('idle');
        };

        return () => evtSource.close();
    }

    useEffect(() => {
        setCurrentNoteIDs(currentStep?.noteIDs || [])
    }, [currentStep])

    return (
        <div>
            <ScorePanel
                highlights={currentNoteIDs || []}
                onSelect={(noteIDs) => {
                    scheduler.current.stop();
                    setCurrentNoteIDs(noteIDs);
                }}
            />

            <button onClick={() => {
                playSingleNote(41, 2000, 0.3)
            }}>
                Test Note
            </button>

            <Chat
                onAsk={ask}
                onPause={() => scheduler.current.stop()}
                status={status || 'idle'}
            />

            {status === 'thinking' && (
                <Paper
                    elevation={7}
                    sx={{
                        position: 'fixed',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        p: 3,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        zIndex: 1000,
                        backgroundColor: 'rgba(255, 255, 255, 0.9)'
                    }}
                >
                    <div
                        style={{
                            animation: 'spin 1.5s linear infinite',
                            display: 'flex'
                        }}
                    >
                        <Psychology sx={{ fontSize: 40 }} />
                    </div>
                    <div style={{ marginLeft: 'auto', marginRight: 'auto', fontSize: 18 }}>
                        Thinking
                    </div>
                    <style>
                        {`
                            @keyframes spin {
                                from { transform: rotate(0deg); }
                                to { transform: rotate(360deg); }
                            }
                        `}
                    </style>
                </Paper>
            )}
        </div>
    );
};
