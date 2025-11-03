import express from "express";
import type { Request, Response } from "express";
import OpenAI from "openai";
import path from 'path';
import fs from 'fs';
import { importMPM } from "mpm-ts";
import { asMSM, extractInfo, getMeasureForDate } from "../utils/asMSM";
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

const scorePath = path.join(process.cwd(), 'assets', 'reconstruction', 'score.mei');
const meiContent = fs.readFileSync(scorePath, 'utf8');

const mpmPath = path.join(process.cwd(), 'assets', 'reconstruction', 'performance.mpm');
const mpmContent = fs.readFileSync(mpmPath, 'utf8');

const sessions = new Map<string, {
    waiters: Map<string, { resolve: (v: any) => void }>,
    responseId?: string
}>();

function getOrCreateSession(id: string) {
    let s = sessions.get(id);
    if (!s) {
        s = { waiters: new Map() };
        sessions.set(id, s);
    }
    return s;
}

export const lessonRouter = express.Router();

const MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const elevenlabs = new ElevenLabsClient({
    apiKey: process.env.ELEVENLABS_API_KEY
});

type DecisionDetails = { elements: any[] };
type Decision = {
    id: string;
    summary: string;
    measures: string;
    aspects: Set<string>;
    details: DecisionDetails;
    mpmIDs: string[];
};

const readDecisions = async (): Promise<Decision[] | undefined> => {
    // Construct path to MEI file
    const infoPath = path.join(process.cwd(), 'assets', 'reconstruction', 'info.json');

    // Check if file exists
    if (!fs.existsSync(infoPath) || !fs.existsSync(scorePath) || !fs.existsSync(mpmPath)) {
        return
    }

    const info = fs.readFileSync(infoPath, 'utf8');
    const json = JSON.parse(info)

    const msm = await asMSM(meiContent)
    const msmInfo = extractInfo(msm)

    const mpm = importMPM(mpmContent)

    const decisions: Decision[] = []
    for (const arg of json.creation.argumentations) {
        if (arg.conclusion.that.assigned.length === 0) continue

        const mpmIDs: Set<string> = new Set(arg.calls.map(c => c.created).flat())
        let measures_ = Array.from(msm.querySelectorAll('note'))
        let measures = measures_
            .filter(note => {
                const effective = new Set(mpm.instructionsEffectiveAtDate(+(note.getAttribute('date') || 0)).map(i => i["xml:id"]));
                return effective.intersection(mpmIDs).size > 0
            })
            .map(note => getMeasureForDate(msmInfo, +(note.getAttribute('date') || 0)))
            .filter(m => !!m)

        measures = Array.from(new Set(measures))

        const instructions = mpm.getInstructions().filter(i => mpmIDs.has(i["xml:id"]))
        const aspects = new Set<string>(instructions.map(i => i.type))

        decisions.push({
            id: arg.id,
            summary: arg.conclusion.that.assigned,
            measures: `b. ${measures.join(',')}`,
            aspects,
            details: {
                elements: instructions
            },
            mpmIDs: instructions.map(i => i["xml:id"])
        })
    }

    return decisions
}

async function retrieveInfo(decisionId: string): Promise<DecisionDetails | { found: false }> {
    const decisions = await readDecisions();
    if (!decisions) return { found: false }

    return decisions.find((d) => d.id === decisionId)?.details || { found: false };
}

type Play = {
    type: "play";
    decisions: string[];
    mode: "all" | "harmony-only" | "melody-only";
    exaggeration: number;
}

type Explanation = {
    type: "explanation";
    message: string;
    emotion: string;
}

type Step = {
    overlap: boolean
} & (Play | Explanation);

const speakExplanation = async (explanation: Explanation): Promise<string | undefined> => {
    const { message, emotion } = explanation;
    const instructions = `
You are an Austrian from 19th century, old and noble, you speak very deep,
but hurried and very quitely, unclearly, often swallowing some syllables.
Current emotion: ${emotion}`;

    try {
        const response = await openai.audio.speech.create({
            model: 'gpt-4o-mini-tts',
            voice: 'ash',
            input: message,
            instructions,
        })

        const buffer = Buffer.from(await response.arrayBuffer());
        return buffer.toString("base64");
    }
    catch (e) {
        console.log('TTS error', e);
    }
}

const speakExplanation2 = async (explanation: Explanation): Promise<string | undefined> => {
    const audio = await elevenlabs.textToSpeech.convert(
        'a4oYSRgmiY0auDgVfso5', // voice_id
        {
            text: explanation.message,
            modelId: 'eleven_multilingual_v2',
            outputFormat: 'mp3_44100_128', // output_format,
            voiceSettings: {
                similarityBoost: 0.6,
                speed: 0.9,
                style: 0.4,
                stability: 0.2
            }
        }
    );

    const chunks: Uint8Array[] = [];
    for await (const chunk of audio) {
        chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    return buffer.toString('base64');
}

const performInIsolation = async (mpmIds: string[], exaggerate: number): Promise<string> => {
    const response = await fetch('http://localhost:8080/perform', {
        method: 'POST',
        body: JSON.stringify({
            mpm: mpmContent,
            mei: meiContent,
            mpmIds,
            exaggerate
        })
    });
    const payload = await response.json();
    return payload?.midi_b64;
}

function systemPrompt(decisions: Decision[]) {
    const list = decisions.map((d) => `- "${d.id}" — ${d.measures}: ${d.summary} (${Array.from(d.aspects).join(',')})`).join("\n");
    return `
You are Alfred Grünfeld, the renowned pianist. The year is 1905 and you speak in
the period-appropriate German style. You are performing "Träumerei" by Robert
Schumann. You have made the following interpretative decisions:

${list}

Your role is to teach these decision to a student. 

Produce the lesson by calling \`push_step\` repeatedly. You can emit two kinds of steps:

- { "type": "play", "decisions": ["..."], "mode": "all" | "harmony-only" | "melody-only", "exaggeration": [-1, 1], "overlap": true | false }
- { "type": "explanation", "message": "...", "emotion": "...", "overlap": true | false }

General style:
- When playing, you should exaggerate certain decisions to communicate their character (use "exaggeration").
- You may choose to speak while playing. When "overlap" is set to true, the step will be executed
  at the same time like the previous step.
- It is a common strategy to sometimes say and play things twice - so you may repeat the same decision 
  and e.g. exaggerate it more the second time.
- You do not need many words, you use (more or less) the given wording.
- Sometimes you interrupt yourself to demonstrate something immediately (i.e., quick change of 
  "explanation" and "play" objects).
`.trim();
}

const tools: OpenAI.Responses.Tool[] = [
    {
        type: "function",
        name: "retrieve_info",
        description: "Get detailed rationale for a given interpretative decision.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                decision_id: { type: "string", description: "Exact ID of decision to look up." },
            },
            required: ["decision_id"],
        },
        strict: true,
    },
    {
        type: "function",
        name: "push_step",
        description: "Emit a single teaching step.",
        strict: true,
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                step: {
                    anyOf: [
                        {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                type: { type: "string", enum: ["play"] },
                                decisions: { type: "array", items: { type: "string" } },
                                mode: { type: "string", enum: ["all", "harmony-only", "melody-only"] },
                                exaggeration: { type: "number" },
                                overlap: { type: "boolean" }
                            },
                            required: ["type", "decisions", "mode", "exaggeration", "overlap"],
                        },
                        {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                type: { type: "string", enum: ["explanation"] },
                                message: { type: "string" },
                                emotion: { type: "string" },
                                overlap: { type: "boolean" }
                            },
                            required: ["type", "message", "emotion", "overlap"],
                        },
                    ],
                }
            },
            required: ["step"],
        }
    }
];

type Query = { question?: string; at?: string, session?: string };

lessonRouter.get("/", async (req: Request<{}, {}, {}, Query>, res: Response) => {
    const { question: userRequest, at: currentMeasure } = req.query;

    const sessionId = (req.query.session as string) || crypto.randomUUID();
    const session = getOrCreateSession(sessionId);

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    // send sessionId to client right away (so client knows where to ack)
    res.write(`event: session\n`);
    res.write(`data: ${JSON.stringify({ sessionId })}\n\n`);

    const decisions = await readDecisions();
    if (!decisions) {
        res.status(500).json({ error: "No reconstruction data available." });
        return;
    }

    const send = (event: string, data: any) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
    };

    const system = systemPrompt(decisions);
    const user = userRequest
        ? `
The student asks: "${userRequest}"\nWe were interrupted in m. ${currentMeasure}.
Your job:
1) Find out, which decision(s) the student was talking about. 
2) You can get more details about how your decision works internally by calling retrieve_info(decision_id).
3) Understand the detailed info and communicate the answer both musically and verbally with clear "play"
and "explanation" steps.`
        : `
- You come up with a good order of explaining things.
You could give e.g. first a rough overview using a harmonic reduction,
and explaining it, or you could to start from the beginning or with some
decision you consider to be central throughout the piece.
- Completeness: Unless you are being interrupted by the student, you go ahead until all 
decisions are explained.
- You are purely presenting. Do not ask the student questions.
- If you want to go into deep detail about a particular decision, call retrieve_info(decision_id).
- Do not go into detail too often.`;

    // Helper: run a single streamed turn, and if it makes tool calls, resolve them and recurse.
    async function run(args: {
        previous_response_id?: string;
        input: any[];
    }) {
        console.log('running with', args)

        const stream = await openai.responses.create({
            model: MODEL,
            stream: true,
            instructions: system,
            tools,
            ...args,
            parallel_tool_calls: false
        });

        let toolName, callId
        for await (const ev of stream) {
            if (ev.type === 'response.created') {
                session.responseId = ev.response.id;
            }
            if (ev.type === "response.output_item.added" && ev.item.type === "function_call") {
                toolName = ev.item.name;
                callId = ev.item.call_id;
            }

            // Accumulate arguments as they stream in
            if (ev.type === "response.function_call_arguments.done") {
                if (!toolName || !callId) continue; // should not happen

                let toolOutput: any = { ok: true };
                const args = JSON.parse(ev.arguments);
                const stepId = crypto.randomUUID();

                if (toolName === "push_step") {
                    const step: Step = args.step;
                    if (step.type === "explanation") {
                        const audio = await speakExplanation2(args.step);
                        send("step", {
                            ...step,
                            audio,
                            stepId,
                        });
                    }
                    else {
                        const mpmIDs = step.decisions
                            .map((id) => {
                                const d = decisions?.find((d) => d.id === id);
                                return d ? d.mpmIDs : [];
                            })
                            .flat();
                        const midi = await performInIsolation(mpmIDs, step.exaggeration);
                        send("step", {
                            ...step,
                            midi,
                            stepId
                        });
                    }

                    const ack = await new Promise((resolve) => {
                        session.waiters.set(stepId, { resolve });
                    });

                    toolOutput = ack;
                } else if (toolName === "retrieve_info") {
                    const info = await retrieveInfo(args.decision_id);
                    // console.log('info', info)
                    toolOutput = info;
                }

                await run({
                    previous_response_id: session.responseId,
                    input: [
                        {
                            type: "function_call_output",
                            call_id: callId,
                            output: JSON.stringify(toolOutput),
                        },
                    ],
                })
            }

            // if (!toolName && ev.type === "response.completed") {
            //   send("done", "[DONE]");
            //   return;
            // }
        }
    }

    try {
        await run({
            input: [{ role: "user", content: user }],
            previous_response_id: session.responseId
        });
    } catch (e: any) {
        send("error", { message: e?.message ?? String(e) });
    } finally {
        res.end();
    }
});

lessonRouter.post("/:session/ack", express.json(), (req, res) => {
    const session = sessions.get(req.params.session);
    if (!session) return res.status(404).json({ error: "unknown session" });

    const { stepId, status } = req.body || {};
    const waiter = session.waiters.get(stepId);
    if (!waiter) return res.status(410).json({ error: "no pending step" });

    waiter.resolve({ status: status || "started", stepId });
    session.waiters.delete(stepId);
    res.json({ ok: true });
});
