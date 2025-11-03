import { usePiano } from "react-pianosound";
import { read } from "midifile-ts";
import { useRef } from "react";

type Play = {
    type: "play";
    decisions: string[];
    mode: "all" | "harmony-only" | "melody-only";
    exaggeration: number;
    midi: string | null;
}

type Explanation = {
    type: "explanation";
    message: string;
    emotion: string;
    audio: string | null;
}

type Step = {
    stepId: string;
    overlap: boolean;
} & (Play | Explanation);

type Overlappable = { overlap: boolean }

class Scheduler<StepT extends Overlappable> {
    private buffer: StepT[] = [];
    private running = false;
    private stopped = false;

    private lastBlocking: Promise<void> = Promise.resolve();

    onStep?: (step: StepT) => Promise<void>;

    push(step: StepT) {
        if (this.stopped) return;
        this.buffer.push(step);
        if (!this.running) this.run();
    }

    private async run() {
        if (this.running) return;
        this.running = true;

        try {
            while (!this.stopped && this.buffer.length > 0) {
                if (!this.onStep) break;

                const step = this.buffer.shift()!;

                if (step.overlap) {
                    this.onStep(step).catch(err => {
                        console.error("overlap step failed:", err);
                        this.stopped = true;
                    });
                } else {
                    await this.lastBlocking;

                    const p = this.onStep(step);
                    this.lastBlocking = p.catch(err => {
                        this.stopped = true;
                        throw err;
                    });
                }
            }
        } finally {
            this.running = false;
        }
    }

    stop() {
        this.stopped = true;
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
    const { play } = usePiano();

    const sessionId = useRef<string>()
    const scheduler = useRef<Scheduler<Step>>(new Scheduler())

    const onStep = async (step: Step) => {
        if (!sessionId.current) return

        console.log('dealing with', step)

        if (step.type === "explanation" && step.audio) {
            const audio = new Audio("data:audio/mpeg;base64," + step.audio);

            const started = new Promise<void>(resolve => {
                audio.addEventListener("play", () => resolve(), { once: true });
            });

            const finished = new Promise<void>(resolve => {
                audio.addEventListener("ended", () => resolve(), { once: true });
            });

            audio.play().catch(e => console.error("Audio play error:", e));

            started.then(() => {
                sendAck(sessionId.current || '', step.stepId, "started");
            });

            await finished;
            return
        }

        if (step.type === "play" && step.midi) {
            // Decode base64 → ArrayBuffer
            const binary = atob(step.midi);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const midiBuf = bytes.buffer;

            // Parse and estimate duration
            const file = read(midiBuf);
            sendAck(sessionId.current, step.stepId, "started");

            await new Promise<void>((resolve) => {
                play(file as any, (e) => {
                    if (e.type === 'meta' && e.subtype === 'endOfTrack') {
                        resolve()
                    }
                });
            })
            return;
        }

        sendAck(sessionId.current || null, step.stepId, "started");
    }

    const start = () => {
        if (!scheduler.current.onStep) {
            scheduler.current.onStep = onStep;
        }

        const evtSource = new EventSource(`/lesson`, { withCredentials: true });

        evtSource.addEventListener("session", (e) => {
            const data = JSON.parse((e as MessageEvent).data);
            sessionId.current = data.sessionId;
            console.log("Session established:", sessionId);
        });

        evtSource.addEventListener("step", (e) => {
            const step: Step = JSON.parse((e as MessageEvent).data);
            console.log('pushing', step);
            scheduler.current.push(step);
        });

        evtSource.onerror = (err) => {
            console.error("SSE error:", err);
            evtSource.close();
        };

        return () => evtSource.close();
    };

    const ask = async () => {
        if (!scheduler.current.onStep) {
            scheduler.current.onStep = onStep;
        }

        const evtSource = new EventSource(`/lesson?question=Moment,+das+verstehe+ich+nicht&at=b.-5`, { withCredentials: true });

        evtSource.addEventListener("session", (e) => {
            const data = JSON.parse((e as MessageEvent).data);
            sessionId.current = data.sessionId;
            console.log("Session established:", sessionId);
        });

        evtSource.addEventListener("step", (e) => {
            const step: Step = JSON.parse((e as MessageEvent).data);
            console.log('pushing', step);
            scheduler.current.push(step);
        });

        evtSource.onerror = (err) => {
            console.error("SSE error:", err);
            evtSource.close();
        };

        return () => evtSource.close();
    }

    const pause = () => {
        scheduler.current.stop();
    }

    return (
        <div>
            <button onClick={start}>Start Lesson</button>
            <button onClick={ask}>Ask</button>
            <button onClick={pause}>Pause</button>
        </div>
    );
};
