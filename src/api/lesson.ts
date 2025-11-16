import express from "express";
import type { Request, Response } from "express";
import OpenAI from "openai";
import path from 'path';
import fs from 'fs';
import { importMPM } from "mpm-ts";
import { asMSM, extractInfo, getMeasureForDate } from "../utils/asMSM";
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

const scores = new Map<PlayMode, string>();

for (const mode of ['all', 'harmony-only', 'melody-only'] as PlayMode[]) {
    const scorePath = path.join(process.cwd(), 'assets', mode === 'melody-only' ? 'harmony-only' : mode, 'score.mei');
    const meiContent = fs.readFileSync(scorePath, 'utf8');
    scores.set(mode, meiContent);
}

const mpmPath = path.join(process.cwd(), 'assets', 'all', 'performance.mpm');
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

const MODEL = process.env.OPENAI_MODEL || "gpt-5.1";
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
    const infoPath = path.join(process.cwd(), 'assets', 'all', 'info.json');

    // Check if file exists
    if (!fs.existsSync(infoPath) || /*!fs.existsSync(scorePath) ||*/ !fs.existsSync(mpmPath)) {
        return
    }

    const info = fs.readFileSync(infoPath, 'utf8');
    const json = JSON.parse(info)

    const msm = await asMSM(scores.get('all') || '')
    const msmInfo = extractInfo(msm)

    const mpm = importMPM(mpmContent)

    const decisions: Decision[] = []
    for (const arg of json.creation.argumentations) {
        if (arg.conclusion.that.assigned.length === 0) continue

        const mpmIDs: Set<string> = new Set(arg.calls.map(c => c.created).flat())
        const dates = Array
            .from(msm.querySelectorAll('note'))
            .filter(note => {
                const effective = new Set(mpm.instructionsEffectiveAtDate(+(note.getAttribute('date') || 0)).map(i => i["xml:id"]));
                return effective.intersection(mpmIDs).size > 0
            })
            .map(note => {
                const date = note.getAttribute('date')
                if (date) return +date
                else return null
            })
            .filter(d => d !== null)

        if (dates.length === 0) continue

        const min = Math.min(...dates)
        const max = Math.max(...dates)
        const minInfo = getMeasureForDate(msmInfo, min)
        const maxInfo = getMeasureForDate(msmInfo, max)
        const range = `T. ${minInfo.measure}/${minInfo.beat}-${maxInfo}/${maxInfo.beat}${maxInfo.inRepeat ? ' (Wdh.)' : ''}`

        const instructions = mpm.getInstructions().filter(i => mpmIDs.has(i["xml:id"]))
        const aspects = new Set<string>(instructions.map(i => i.type))

        decisions.push({
            id: arg.id,
            summary: arg.conclusion.that.assigned,
            measures: range,
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

type PlayMode = "all" | "harmony-only" | "melody-only";

type Play = {
    type: "play";
    decision: string | null;
    mode: PlayMode;
    exaggeration: number;
    sketchiness: number;
    extent: 'pick' | 'contextualize' | null;
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
    const instructions = `You speak German, the year is 1905 and you are
52 years old. You speak in a slightly aristocratic tone, but since you
are an artist, often somewhat unclearly and with many pauses for thinking.
You current emotion: ${emotion}`;

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

const performInIsolation = async (step: Play, decisions: Decision[]): Promise<string> => {
    const mpmIds = decisions.find((d) => d.id === step.decision)?.mpmIDs || [];
    console.log('performing MPM IDs', mpmIds);

    const response = await fetch('http://localhost:8080/perform', {
        method: 'POST',
        body: JSON.stringify({
            mpm: mpmContent,
            mei: scores.get(step.mode),
            mpmIds,
            exaggerate: step.exaggeration,
            sketchiness: step.sketchiness,
            extent: step.extent
        })
    });
    try {
        const text = await response.text();
        const payload = JSON.parse(text);
        return payload?.midi_b64;
    } catch (e) {
        console.error('Error parsing perform response', e);
        throw e;
    }
}

function systemPrompt(decisions: Decision[]) {
    const list = decisions.map((d) => `- "${d.id}" — ${d.measures}: ${d.summary} (${Array.from(d.aspects).join(',')})`).join("\n");
    return `
You are Alfred Grünfeld, a pianist. The year is 1905 and you speak in
the period-appropriate German style. You are performing "Träumerei" by Robert
Schumann. Your role is to teach these decision to a student.

# Rules:
- Produce the lesson by calling \`push_step\` repeatedly. You can emit two kinds of steps:
  to demonstrate ('play') and to speak ('explanation').

# General style:
- Speak *very* briefly, only hinting, around 2 to 10 words per explanation. Use the given
  wording. Unfinished utterances are fine.
- Use repetition, e.g. by playing the same thing multiple times. You must modify it
  every time by changing either the exaggeration or sketchiness or both.
- Multiple decisions are structured in the same way. In that case demonstrate only one instance and
  mention, that there are more instances (e.g. "Nachschlag schattieren").
  use the given wording. Even make it shorter. Unfinished utterances are good.

# Parameter descriptions:
- If you pass no decision, the whole piece will be played (useful e.g. to show a harmonic reduction).
- When playing, exaggerate your decision to communicate its character (use "exaggeration").
- You may choose to speak while playing. When "overlap" is set to true, the step will be executed
  at the same time as the previous step. Be aware that there may not be multiple overlaps in a row
  and that only explanations can overlap with plays.
- Use "sketchiness" if you want to show something in a more hasting, fleeting manner. In particular 
  when playing a harmonic reduction, you must always increase the sketchiness significantly (i.e. > 2.0).
  A value of 1.0 means "normal". Do *not* reflect about sketchiness in your speech.
- For "exaggaration", values less than 1.0 will flatten the expressivity, values greater than 1.0 will exaggerate it.
- Set the "extent" to "pick" when the decision spans a long passage, i.e. you pick a representative portion to exemplify.
  Set it to "contextualize" when the decision is very short, i.e. include some musical context before and after the decision.
  Otherwise, set it to null.

# Decisions
You have made the following interpretative decisions:
${list}
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
                                decision: { type: ["string", "null"] },
                                mode: { type: "string", enum: ["all", "harmony-only", "melody-only"] },
                                exaggeration: { type: "number" },
                                sketchiness: { type: "number" },
                                overlap: { type: "boolean" },
                                extent: {
                                    type: ["string", "null"],
                                    enum: ["pick", "contextualize", null],
                                }
                            },
                            required: [
                                "type",
                                "decision",
                                "mode",
                                "exaggeration",
                                "sketchiness",
                                "overlap",
                                "extent"
                            ],
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
2) Get more details about how your decision works internally by calling retrieve_info(decision_id).
3) Understand the detailed info and communicate the answer both musically and verbally with clear "play"
and "explanation" steps.`
        : `
- Give an overview over the decisions.
- You may choose to start with giving a harmonic reduction (mode: "harmony-only") of the whole piece.
- Also for decisions encompassing many measures, you may play a harmonic reduction.
`;

    // Helper: run a single streamed turn, and if it makes tool calls, resolve them and recurse.
    async function run(args: {
        previous_response_id?: string;
        input: any[];
    }) {
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
                // console.log('function call args done', ev, toolName, callId);
                if (!toolName || !callId) continue; // should not happen

                let toolOutput: any = { ok: true };
                const args = JSON.parse(ev.arguments);
                const stepId = crypto.randomUUID();
                // console.log('args', args);

                if (toolName === "push_step") {
                    const step: Step = args.step;
                    // console.log('step.type=', step.type);
                    if (step.type === "explanation") {
                        const audio = await speakExplanation(args.step);
                        send("step", {
                            ...step,
                            audio,
                            stepId,
                        });
                    }
                    else {
                        const midi = await performInIsolation(step, decisions || []);
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
