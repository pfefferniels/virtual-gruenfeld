import express from "express";
import type { Request, Response } from "express";
import OpenAI from "openai";
import path from 'path';
import fs from 'fs';
import { AnyInstruction, ArticulationDef, importMPM, OrnamentDef } from "mpm-ts";
import { asMSM, ExtractedInfo, extractInfo, getMeasureForDate } from "../utils/asMSM";
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

const scores = new Map<PlayMode, string>();

for (const mode of ['all', 'harmony-only', 'melody-only'] as PlayMode[]) {
    const scorePath = path.join(process.cwd(), 'assets', mode, 'score.mei');
    const meiContent = fs.readFileSync(scorePath, 'utf8');
    scores.set(mode, meiContent);
}

const mpmPath = path.join(process.cwd(), 'assets', 'all', 'performance.mpm');
const mpmContent = fs.readFileSync(mpmPath, 'utf8');

type Session = {
    pendingCalls: Map<string, { resolve: (v: any) => void } | null>,
    responseId?: string
}

const sessions = new Map<string, Session>();

function getOrCreateSession(id: string): Session {
    let s = sessions.get(id);
    if (!s) {
        s = { pendingCalls: new Map() };
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

type Decision = {
    id: string;
    range: MeasureRange | null;
    summary: string;
    elements: string[];
    notes: string;
    mpmIDs: string[];
};

const rangeOfNotes = (notes: string[], msm: Document): MeasureRange | null => {
    const dates = notes.map(id => {
        const el = Array.from(msm.querySelectorAll('note')).find(n => n.getAttribute('xml:id') === id);
        if (el) {
            return +(el.getAttribute('date') || 0);
        } else {
            return null;
        }
    }).filter(d => d !== null) as number[];

    if (dates.length === 0) return null;

    const min = Math.min(...dates);
    const max = Math.max(...dates);

    const info = extractInfo(msm);
    const from = getMeasureForDate(info, min);
    const to = getMeasureForDate(info, max);

    return { from, to }
}

const stringify = <T extends AnyInstruction>(el: T, info: ExtractedInfo, indent = 0) => {
    let str = ''
    str += `${el.type} `;
    if ('date' in el && typeof el.date === 'number') {
        const location = getMeasureForDate(info, el.date)
        str += `b.${serializeLocation(location)}`;
    }
    if ('endDate' in el && typeof el.endDate === 'number') {
        const location = getMeasureForDate(info, el.endDate)
        str += `-b. ${serializeLocation(location)} `;
    }
    str += ': ';

    if (el.type === 'dynamics') {
        if ('volume' in el)
            str += `${(+el.volume).toFixed(0)} `;
        if (el['transition.to']) {
            str += `→${(+el['transition.to']).toFixed(0)}`;
        }
        return str
    }
    else if (el.type === 'tempo') {
        str += `${el.bpm.toFixed(0)}bpm`
        if (el["transition.to"]) {
            str += `→${el['transition.to'].toFixed(0)}bpm`;
        }
        return str
    }
    else if (el.type === 'movement') {
        str += `${el.controller} ${el.position.toFixed(1)}`;
        if (el["transition.to"]) {
            str += `→${el['transition.to'].toFixed(1)}`;
        }
    }
    else if (el.type === 'ornament') {
        const def = el as unknown as OrnamentDef;
        if (def.temporalSpread) {
            str += `temporalSpread=${def.temporalSpread.frameLength} ticks`;
        }
    }
    else if (el.type === 'rubato') {
        if (el.intensity !== undefined) {
            str += `intensity=${el.intensity.toFixed(2)} `;
        }
        if (el.frameLength !== undefined) {
            str += `length=${el.frameLength / 720 / 4}`;
        }
    }
    else if (el.type === 'articulation') {
        const def = el as unknown as ArticulationDef;
        if (def.relativeDuration) {
            str += `relativeDuration=${def.relativeDuration.toFixed(2)} `;
        }
    }

    return str.trim();
}

let decisions: Decision[] | null = null;

const readDecisions = async (): Promise<Decision[] | undefined> => {
    if (decisions) return decisions;

    // Construct path to MEI file
    const infoPath = path.join(process.cwd(), 'assets', 'all', 'info.json');

    // Check if file exists
    if (!fs.existsSync(infoPath) || /*!fs.existsSync(scorePath) ||*/ !fs.existsSync(mpmPath)) {
        return
    }

    const info = fs.readFileSync(infoPath, 'utf8');
    const json = JSON.parse(info)

    const msm = await asMSM(scores.get('all') || '')

    const mpm = importMPM(mpmContent)

    const result: Decision[] = []
    for (const arg of json.creation.argumentations) {
        if (arg.conclusion.that.assigned.length === 0) continue

        const mpmIDs: Set<string> = new Set(arg.calls.map(c => c.created).flat())
        const notes = Array
            .from(msm.querySelectorAll('note'))
            .filter(note => {
                const effective = new Set(mpm.instructionsEffectiveAtDate(+(note.getAttribute('date') || 0)).map(i => i["xml:id"]));
                return effective.intersection(mpmIDs).size > 0
            })
        if (notes.length === 0) continue;

        const readableNotes = notes
            .map(n => {
                const acc = n.getAttribute('accidentals') || ''
                const readableAcc = acc === '-1.0' ? 'b' : acc === '1.0' ? '#' : acc === '2.0' ? 'x' : '';
                const readable = `${n.getAttribute('pitchname') || ''}${readableAcc}`;
                const date = n.getAttribute('date')
                return { date, readable };
            })
            .filter((n): n is { date: string, readable: string } => n.date !== null && n.readable.length > 0);

        let notesStr = ''
        {
            const notesByDate = Map.groupBy(readableNotes, n => n.date)
            for (const arr of notesByDate.values()) {
                notesStr += arr.map(n => n.readable).join('/');
                notesStr += ' ';
            }
        }

        const range = rangeOfNotes(notes.map(n => n.getAttribute('xml:id') || ''), msm)
        const extractedInfo = extractInfo(msm);

        const instructions = mpm.getInstructions()
            .filter(i => mpmIDs.has(i["xml:id"]))
            .map(i => {
                if ('name.ref' in i && i['name.ref']) {
                    const def = mpm.getAnyDefinition(i['name.ref']);
                    if (def) {
                        return { ...def, ...i };
                    }
                }
                return i;
            })
            .filter(i => !!i)


        result.push({
            id: arg.id,
            range,
            summary: `${arg.conclusion.that.assigned}. ${arg.note ? `(${arg.note})` : ''}`,
            elements: instructions.map(i => stringify(i, extractedInfo)),
            notes: notesStr,
            mpmIDs: instructions.map(i => i["xml:id"])
        })
    }

    // set cache
    decisions = result;
    return result
}

type EmbeddedDecision = Decision & {
    embedding: number[];
};

let embeddedDecisions: EmbeddedDecision[] | null = null

async function embedDecisions(): Promise<EmbeddedDecision[]> {
    if (embeddedDecisions) return embeddedDecisions;

    const decisions = await readDecisions();
    if (!decisions) return [];

    const texts = decisions.map(({ summary }) => summary);
    const embeddings = await openai.embeddings.create({
        model: 'text-embedding-3-large',
        input: texts
    });

    // set cache
    embeddedDecisions = embeddings.data.map((e, i) => ({
        ...decisions[i],
        embedding: normalize(e.embedding)
    }));

    return embeddedDecisions
}

async function embedQuery(q: string): Promise<number[]> {
    const res = await openai.embeddings.create({
        model: "text-embedding-3-large",
        input: q,
    });
    return normalize(res.data[0].embedding);
}

function normalize(v: number[]): number[] {
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map(x => x / norm);
}

function dot(a: number[], b: number[]): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}

async function retrieveInfo(query: string | null, range: MeasureRange | null, decisions: EmbeddedDecision[], k = 5): Promise<any[]> {
    if (decisions.length === 0) return [];

    const filtered = decisions
        .filter(d => {
            if (!d.range || !range) return true
            return overlaps(d.range, range)
        })

    if (!query) return filtered
        .map(d => ({
            id: d.id,
            summary: d.summary,
            elements: d.elements,
            notes: d.notes,
        }))
        .slice(0, k)

    const queryVector = await embedQuery(query);

    return filtered
        .map(d => ({
            id: d.id,
            summary: d.summary,
            elements: d.elements,
            notes: d.notes,
            score: dot(queryVector, d.embedding),
        }))
        .sort((x, y) => y.score - x.score)
        .slice(0, k)
}

type PlayMode = "all" | "harmony-only" | "melody-only";

export type Location = {
    measure: number;
    beat: number;
    inRepeat: boolean;
}

type MeasureRange = {
    from: Location;
    to: Location;
}

const serializeLocation = (location: Location) => {
    return `${location.measure}/${location.beat}${location.inRepeat ? '-rpt' : ''}`
}

const isWithin = (location: Location, range: MeasureRange) => {
    const fromCmp = (a: Location, b: Location) => {
        if (a.measure !== b.measure) return a.measure - b.measure;
        if (a.beat !== b.beat) return a.beat - b.beat;
        if (a.inRepeat !== b.inRepeat) return (a.inRepeat ? 1 : 0) - (b.inRepeat ? 1 : 0);
        return 0;
    }

    return fromCmp(location, range.from) >= 0 && fromCmp(location, range.to) <= 0;
}

const overlaps = (a: MeasureRange, b: MeasureRange) => {
    const fromCmp = (locA: Location, locB: Location) => {
        if (locA.measure !== locB.measure) return locA.measure - locB.measure;
        if (locA.beat !== locB.beat) return locA.beat - locB.beat;
        if (locA.inRepeat !== locB.inRepeat) return (locA.inRepeat ? 1 : 0) - (locB.inRepeat ? 1 : 0);
        return 0;
    }

    return fromCmp(a.from, b.to) <= 0 && fromCmp(b.from, a.to) <= 0;
}

type Step = {
    what: string | null | MeasureRange;
    mode: PlayMode;
    exaggeration: number;
    flightiness: number;
    cap: boolean;
    context: number;
    message: string;
    emotion: string;
    overlap: boolean
}

const speakExplanation = async (explanation: Step): Promise<string | undefined> => {
    const { message, emotion } = explanation;
    const instructions = `
You speak German, it's the early 1900s. You speak quietly and like a refined, well-educated pianist and pedagogue.
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

const speakExplanation2 = async (explanation: Step): Promise<string | undefined> => {
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

const performInIsolation = async (step: Step, decisions: Decision[]): Promise<any> => {
    // let ids: string[] = [];
    let mpmIds: string[] = [];
    let measures: string[] = [];
    if (typeof step.what === 'string') {
        mpmIds = decisions.find((d) => d.id === step.what)?.mpmIDs || [];
        // console.log('performing with MPM IDs:', mpmIds);
    }
    else if (step.what && typeof step.what === 'object') {
        measures = [serializeLocation(step.what.from), serializeLocation(step.what.to)];
    }

    const response = await fetch('http://localhost:8080/perform', {
        method: 'POST',
        body: JSON.stringify({
            mpm: mpmContent,
            mei: scores.get(step.mode),
            mpmIds,
            measures,
            exaggerate: step.exaggeration,
            sketchiness: step.flightiness,
            exemplify: step.cap,
            context: step.context
        })
    });
    try {
        const text = await response.text();
        const payload = JSON.parse(text);
        // console.log('payload=', payload);
        return payload;
    } catch (e) {
        console.error('Error parsing perform response', e);
        throw e;
    }
}

const systemPrompt = `
You are Alfred Grünfeld, the pianist. You are performing "Träumerei" by Robert
Schumann. Your role is to demonstrate your decision to a student.
Produce the lesson by repeatedly calling \`play_and_explain\`.

## Procedure
- You may respond with message content only, if something went wrong.
  Otherwise, you may only respond by calling one of the allowed tools.
- Call \`retrieve_info\` every time to gather relevant musical decisions.
  This function returns the top 5 decisions matching a specified query and
  measure range. Example:
      query: "direction towards, dynamics", range: { from: { measure: 1, beat: 1, inRepeat: false }, to: { measure: 8, beat: 4, inRepeat: true } }
      => retrieves all decisions about the musical direction towards something, realised through <dynamics> element, within
         the first 8 measures (including the repetition).
- Frame your explanations within an overarching narrative.
- Work from general to specific elements (e.g., begin with harmonic reduction, then
  dive into detailed decisions), moving left to right through the piece.
- Repeat yourself, i.e., call play_and_explain multiple times for the same decision,
  but e.g. with varied exaggeration, sketchiness, context or mode.
- When \`play_and_explain\`'s return value indicates that you were interrupted by the student,
  stop generating your response immediately.
- The student can see what you are pointing at, there is no need to refer to bar numbers. You may
  mention however, about which beat inside the bar you are talking.
- When repeating differently, reflect briefly on what is different.
- When you chose to speak while playing, slightly increase the flightiness and always repeat
  once more afterwards without speaking.
- After demonstrating decisions, summarize with a performance of the whole relevant passage.
- For understanding ambiguous descriptions, look at all available data, including the numeric
  attributes  of instructions and definitions, then provide a concrete explanation. However,
  do not talk about numbers.
- When multiple decisions correspond to a single gesture (e.g., dynamic shading), demonstrate one instance
  and mention where others occur.

## Parameter descriptions
- "overlap":
   - true → narrate while playing (use only for longer passages)
   - false → explain first, then play
- "exaggeration": controls how strongly a decision is expressed
- "flightiness": increases fleetingness of the playing. For harmonic reductions always set flightiness > 1.8.
  Flightiness < 1.0 is not allowed.
- Exaggeration < 1.0 flattens expressivity; >1.0 enhances it.
- When "what" is a specific decision spanning many measures, you might cap it. This limits 
  the playing to the a maximum length of two measures.
- For very short decisions (~3–4 beats or less, even across measures), add context (as beat length, e.g., 0.25 = a quarter note before/after).
- Never mention decision IDs in the spoken/described output.

## Hints
Some basic principles of MPM:
* The following instruction types are used: tempo, dynamics, accentuationPattern, ornament, rubato, articulation.
* dates are in given ticks with PPQ = 720
* \`<accentuationPattern>\` defines the dynamic accentuation patterns on top of the macro dynamics (given
   with <dynamics>).
* \`<ornament>\` is used to specify arpeggiations. @scale refers to how the associated dynamicsGradient should be scaled.
* \`<rubato>\` defines micro-timing distortion on top of the macro <tempo> modifications.
  Within each frame, the timing is stretched or compressed through the
  @intensity parameter.
`.trim();

const tools: OpenAI.Responses.Tool[] = [
    {
        type: "function",
        name: "retrieve_info",
        description: "Get detailed info about performance decisions.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                range: {
                    anyOf: [
                        { type: "null" },
                        {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                from: {
                                    type: "object",
                                    additionalProperties: false,
                                    properties: {
                                        measure: { type: "number" },
                                        beat: { type: "number" },
                                        inRepeat: { type: "boolean" }
                                    },
                                    required: ["measure", "beat", "inRepeat"]
                                },
                                to: {
                                    type: "object",
                                    additionalProperties: false,
                                    properties: {
                                        measure: { type: "number" },
                                        beat: { type: "number" },
                                        inRepeat: { type: "boolean" }
                                    },
                                    required: ["measure", "beat", "inRepeat"]
                                },
                            },
                            required: ["from", "to"],
                        }
                    ],
                    description: "Leave null to not apply any range filter."
                },
                query: {
                    type: ["string", "null"],
                    description: "Leave null to include everything."
                },
            },
            required: ["query", "range"],
        },
        strict: true,
    },
    {
        "type": "function",
        "name": "play_and_explain",
        "description": "Emit a single teaching step.",
        "strict": true,
        "parameters": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "what": {
                    "description": "Which portion to play. Can be a single decision ID (string), a measure-range object (from-to), or null for the full piece.",
                    "anyOf": [
                        {
                            "type": "null",
                        },
                        {
                            "type": "string"
                        },
                        {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                from: {
                                    type: "object",
                                    additionalProperties: false,
                                    properties: {
                                        measure: { type: "number" },
                                        beat: { type: "number" },
                                        inRepeat: { type: "boolean" }
                                    },
                                    required: ["measure", "beat", "inRepeat"]
                                },
                                to: {
                                    type: "object",
                                    additionalProperties: false,
                                    properties: {
                                        measure: { type: "number" },
                                        beat: { type: "number" },
                                        inRepeat: { type: "boolean" }
                                    },
                                    required: ["measure", "beat", "inRepeat"]
                                },
                            },
                            required: ["from", "to"],
                        }
                    ]
                },
                "mode": {
                    "type": "string",
                    "enum": ["all", "harmony-only", "melody-only"],
                    "description": "Which play mode to use. use \"all\" to play all notes and \"harmony-only\" or \"melody-only\" to play only the harmonic structure or melodic line."
                },
                "exaggeration": {
                    "type": "number"
                },
                "flightiness": {
                    "type": "number"
                },
                "overlap": {
                    "type": "boolean"
                },
                "cap": {
                    "type": "boolean"
                },
                "context": {
                    "type": "number"
                },
                "message": {
                    "type": "string"
                },
                "emotion": {
                    "type": "string"
                }
            },
            "required": [
                "what",
                "mode",
                "exaggeration",
                "flightiness",
                "overlap",
                "cap",
                "context",
                "message",
                "emotion"
            ]
        }
    }
];

type Query = { question: string; at?: string, session?: string };

const msms = new Map<PlayMode, Document>();

const abortPendingCalls = async (session: Session) => {
    if (!session.pendingCalls.size || !session.responseId) return;

    const abortOutputs = Array
        .from(session.pendingCalls.keys())
        .map((callId) => ({
            type: "function_call_output" as const,
            call_id: callId,
            output: JSON.stringify({ status: "aborted" }),
        }));

    for (const waiter of session.pendingCalls.values()) {
        if (waiter && waiter.resolve) {
            waiter.resolve({ status: "aborted" });
        }
    }

    // Single responses.create that advances the chain
    const abortResponse = await openai.responses.create({
        model: MODEL,
        previous_response_id: session.responseId,
        input: abortOutputs,
    });

    session.responseId = abortResponse.id;
    session.pendingCalls.clear();
}

lessonRouter.get("/", async (req: Request<{}, {}, {}, Query>, res: Response) => {
    const { question: userRequest, at } = req.query;

    const sessionId = (req.query.session as string) || crypto.randomUUID();
    const session = getOrCreateSession(sessionId);

    abortPendingCalls(session)

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    // send sessionId to client right away (so client knows where to ack)
    if (!req.query.session) {
        res.write(`event: session\n`);
        res.write(
            `data: ${JSON.stringify({ sessionId })}\n\n`
        );
    }

    const decisions = await readDecisions();
    if (!decisions) {
        res.status(500).json({ error: "No decision data available." });
        return;
    }

    const embeddedDecisions = await embedDecisions();

    const send = (event: string, data: any) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
    };

    let selectedNotes: string | undefined = undefined;
    if (at) {
        const notes = at
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);

        if (notes.length > 0) {
            let msm = msms.get("all");
            if (!msm) {
                msm = await asMSM(scores.get("all") || "");
                msms.set("all", msm);
            }

            const range = rangeOfNotes(notes, msm);
            if (range) {
                selectedNotes = `b. ${serializeLocation(range.from)} to b. ${serializeLocation(range.to)}`;
            }
        }
    }

    const user = `${userRequest} ${selectedNotes ? `\nUser selection: ${selectedNotes}` : ""}`;

    // Helper: run a single streamed turn, and if it makes tool calls, resolve them and recurse.
    async function run(args: {
        previous_response_id?: string;
        input: any[];
    }) {
        if (!args.previous_response_id) {
            args.input.push({
                role: "system",
                content: systemPrompt,
            });
        }

        const stream = await openai.responses.create({
            model: MODEL,
            stream: true,
            tools,
            ...args,
            parallel_tool_calls: false,
        });

        let toolName: string | undefined;
        let callId: string | undefined;

        for await (const ev of stream) {
            if (ev.type === "response.created") {
                // track the latest response id for this session
                session.responseId = ev.response.id;
            }

            if (
                ev.type === "response.output_item.added" &&
                ev.item.type === "function_call"
            ) {
                toolName = ev.item.name;
                callId = ev.item.call_id;

                console.log("added tool call", toolName, callId);
                if (callId) {
                    session.pendingCalls.set(callId, null);
                }
            }

            // Accumulate arguments as they stream in
            if (ev.type === "response.function_call_arguments.done") {
                if (!toolName || !callId) continue; // should not happen

                let toolOutput: any = { ok: true };
                const args = JSON.parse(ev.arguments);

                if (toolName === "play_and_explain") {
                    const step: Step = args;
                    const [audio, performance] = await Promise.all([
                        speakExplanation(step),
                        performInIsolation(step, decisions || []),
                    ]);
                    const { midi_b64, noteIDs } = performance;
                    send("step", {
                        ...step,
                        audio,
                        midi: midi_b64,
                        noteIDs,
                        stepId: callId,
                    });

                    // Wait for client ACK
                    const ack = await new Promise((resolve) => {
                        session.pendingCalls.set(callId!, { resolve });
                    });

                    toolOutput = ack;
                } else if (toolName === "retrieve_info") {
                    const info = await retrieveInfo(
                        args.query,
                        args.range,
                        embeddedDecisions
                    );
                    toolOutput = info;
                }

                session.pendingCalls.delete(callId);

                // Continue conversation with tool output
                await run({
                    previous_response_id: session.responseId,
                    input: [
                        {
                            type: "function_call_output",
                            call_id: callId,
                            output: JSON.stringify(toolOutput),
                        },
                    ],
                });
            }
        }
    }

    try {
        await run({
            input: [{ role: "user", content: user }],
            previous_response_id: session.responseId,
        });
    } catch (e: any) {
        send("error", { message: e?.message ?? String(e) });
    } finally {
        res.end();
    }
});

lessonRouter.post("/:session/ack", express.json(), (req: Request, res: Response) => {
    const session = sessions.get(req.params.session);
    if (!session)
        return res.status(404).json({ error: "unknown session" });

    const { stepId, status } = req.body || {};
    const waiter = session.pendingCalls.get(stepId);
    if (!waiter) return res.status(410).json({ error: "no pending step" });

    waiter.resolve({ status: status || "started" });
    session.pendingCalls.delete(stepId);
    res.json({ ok: true });
});
