import express from "express";
import type { Request, Response } from "express";
import OpenAI from "openai";
import path from 'path';
import fs from 'fs';
import { AnyDefinition, AnyInstruction, importMPM } from "mpm-ts";
import { asMSM, extractInfo, getMeasureForDate } from "../utils/asMSM";
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

const scores = new Map<PlayMode, string>();

for (const mode of ['all', 'harmony-only', 'melody-only'] as PlayMode[]) {
    const scorePath = path.join(process.cwd(), 'assets', mode, 'score.mei');
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

type DecisionDetails = {
    elements: AnyInstruction[],
    definitions: AnyDefinition[],
    affectedNotes: object,
    note?: string
};

type Decision = {
    id: string;
    summary: string;
    measures: string;
    details: DecisionDetails;
    mpmIDs: string[];
};

const rangeOfNotes = (notes: string[], msm: Document): string => {
    const dates = notes.map(id => {
        const el = Array.from(msm.querySelectorAll('note')).find(n => n.getAttribute('xml:id') === id);
        if (el) {
            return +(el.getAttribute('date') || 0);
        } else {
            return null;
        }
    }).filter(d => d !== null) as number[];

    if (dates.length === 0) return '';

    const min = Math.min(...dates);
    const max = Math.max(...dates);

    const info = extractInfo(msm);
    const minInfo = getMeasureForDate(info, min);
    const maxInfo = getMeasureForDate(info, max);

    return `T. ${minInfo.measure}/${minInfo.beat} bis T. ${maxInfo.measure}/${maxInfo.beat}${maxInfo.inRepeat ? ' (Wdh.)' : ''}`;
}

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

    const mpm = importMPM(mpmContent)

    const decisions: Decision[] = []
    for (const arg of json.creation.argumentations) {
        if (arg.conclusion.that.assigned.length === 0) continue

        const mpmIDs: Set<string> = new Set(arg.calls.map(c => c.created).flat())
        const notes = Array
            .from(msm.querySelectorAll('note'))
            .filter(note => {
                const effective = new Set(mpm.instructionsEffectiveAtDate(+(note.getAttribute('date') || 0)).map(i => i["xml:id"]));
                return effective.intersection(mpmIDs).size > 0
            })
        const range = rangeOfNotes(notes.map(n => n.getAttribute('xml:id') || ''), msm)

        const instructions = mpm.getInstructions().filter(i => mpmIDs.has(i["xml:id"]))
        const definitions = instructions
            .filter(i => i["name.ref"] !== undefined)
            .map(i => {
                return mpm.getAnyDefinition(i["name.ref"]!)
            })
            .filter(def => def !== null)

        const readableNotes: object = {}
        notes.forEach(n => {
            const acc = n.getAttribute('accidentals') || ''
            const readableAcc = acc === '-1.0' ? 'b' : acc === '1.0' ? '#' : acc === '2.0' ? 'x' : '';
            const readable = `${n.getAttribute('pitchname') || ''}${readableAcc}`;
            const date = n.getAttribute('date')
            if (date === null) return;

            if (Array.isArray(readableNotes[date])) {
                (readableNotes[date] as string[]).push(readable);
            }
            else {
                readableNotes[date] = [readable];
            }
        })

        decisions.push({
            id: arg.id,
            summary: arg.conclusion.that.assigned,
            measures: range,
            details: {
                elements: instructions,
                definitions,
                note: arg.note,
                affectedNotes: readableNotes
            },
            mpmIDs: instructions.map(i => i["xml:id"])
        })
    }

    return decisions
}

async function retrieveInfo(decisionIds: string[]): Promise<any[]> {
    const decisions = await readDecisions();
    if (!decisions) return [];

    return decisions
        .filter(d => decisionIds.includes(d.id))
        .map(({ measures, details, ...info }) => {
            const { affectedNotes, elements, definitions, note } = details

            const elementStrings = elements.map(el => {
                let str = `<${el.type}> `;
                if ('endDate' in el) {
                    str += `${el.date}-${el.endDate}`;
                }
                else {
                    str += `${el.date}`;
                }
                str += ': ';
                for (let [key, value] of Object.entries(el)) {
                    if (key === 'xml:id' || key === 'type' || key === 'date' || key === 'endDate' || key === 'children' || key === 'corresp') continue;
                    if (typeof value === 'number') {
                        value = value.toFixed(1);
                    }
                    if (['boolean', 'number', 'string'].includes(typeof value)) {
                        str += `${key}=${value} `;
                    }
                    else if (Array.isArray(value)) {
                        str += `${key}=[${value.map(v => JSON.stringify(v)).join(', ')}] `;
                    }
                    else {
                        str += `${key}=${JSON.stringify(value)} `;
                    }
                }
                return str.trim();
            })

            const definitionStrings = definitions.map(def => {
                let str = `${def.type} ${def.name}: `;
                for (let [key, value] of Object.entries(def)) {
                    if (key === 'xml:id' || key === 'type' || key === 'name') continue;
                    if (key === 'children' && Array.isArray(value) && value.length === 0) continue

                    if (typeof value === 'number') {
                        value = value.toFixed(1);
                    }
                    if (['boolean', 'number', 'string'].includes(typeof value)) {
                        str += `${key}=${value} `;
                    }
                    else if (Array.isArray(value)) {
                        str += `${key}=[${value.map(v => JSON.stringify(v)).join(', ')}] `;
                    }
                    else {
                        str += `${key}=${JSON.stringify(value)} `;
                    }
                }
                return str.trim();
            })

            return {
                id: info.id,
                summary: info.summary,
                instructions: elementStrings,
                definitions: definitionStrings.length > 0 ? definitionStrings : undefined,
                note: (note && note.length > 0) ? note : undefined
            }
        })
}

async function affectedNotes(decisionId: string): Promise<any> {
    const decisions = await readDecisions();
    if (!decisions) return [];

    const decision = decisions.find(d => d.id === decisionId);
    if (!decision) return [];

    return decision.details.affectedNotes;
}

type PlayMode = "all" | "harmony-only" | "melody-only";

type Step = {
    what: string | null | {
        from: string;
        to: string;
    };
    mode: PlayMode;
    exaggeration: number;
    sketchiness: number;
    exemplify: boolean;
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
    }
    else if (step.what && typeof step.what === 'object') {
        measures = [step.what.from, step.what.to];
    }

    const response = await fetch('http://localhost:8080/perform', {
        method: 'POST',
        body: JSON.stringify({
            mpm: mpmContent,
            mei: scores.get(step.mode),
            mpmIds,
            measures,
            exaggerate: step.exaggeration,
            sketchiness: step.sketchiness,
            exemplify: step.exemplify,
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

function systemPrompt(decisions: Decision[]) {
    const list = decisions.map((d) => `- ${d.measures}: "${d.id}"`).join("\n");
    return `
You are Alfred Grünfeld, the pianist. You are performing "Träumerei" by Robert
Schumann. Your role is to demonstrate these decision to a student.
Produce the lesson by repeatedly calling \`play_and_explain\`.

## Procedure
- To retrieve information about a set of decisions, call \`retrieve_info\`.
- To retrieve the chords and the notes affected by a particular decision, call \`affected_notes\`.
  When talking about vertical units, i.e. chords, refer to chord names (e.g. "F major", etc.) instead
  of single notes.
- Verbalize only the given information. Put them into context of an overarching narrative.
  If you do not know something for sure, do not say anything about it.
- Work from general to specific, e.g. start with playing the harmonic reduction and then dive into details
  of specific decision(s), and from left to right.
- The student can see what you are pointing at, there is no need to refer to bar numbers. You may
  mention however, about which beat inside the bar you are talking.
- Use repetition pedagogically, e.g. by playing the same thing three, four, five times.
- When repeating, you may change e.g. the exaggeration, the sketchiness, by playing only the
  melody for reference, or by giving it context, or all of these. However, you may also
  repeat exactly as before.
- If you change something, reflect in two or three words about what you were changing
  (e.g. "with a bit of context", when using context, "as written" when using mode \`all\` after having 
  played a harmonic reduction etc.)
- After having demonstrated some decisions, you should summarize e.g. by playing the whole passage in which
  they all occur.
- When a decision's description is somewhat ambigious, you should reason about it by looking at 
  the raw data, i.e. the associated instructions and definitions. You could e.g. first demonstrate and embrace
  the ambiguity, then think about it more thoroughly and explain and demonstrate more concretely.
- Many decisions are about the same kind of musical gesture (e.g. shading something dynamically, etc.).
  Demonstrate only one instance and mention that (and where) there are more instances of the same gesture.

## Parameter descriptions
- Use "mode" to define, what to play: this can be "all" (playing all notes, as written), "harmony-only"
  playing a harmonic reduction, or "melody-only" (playing only the melody line).
- Use "what" to define which portion to play. Possible values are:
  - string (= decision ID): play only a specific decision
  - from-to pair of measure numbers. Measures must be given as "[measure number][-rpt]", e.g. "1", "1-rpt".
    Do not include beat information.
  - null (= play everything, i.e. the whole piece, from first to the last measure)
- When "overlap" is set to true, you speak while playing. Otherwise, you first explain and then demonstrate.
  Do not use overlap when playing a harmonic reduction.
- When playing, exaggerate your decision to communicate its character using "exaggeration".
- Use "sketchiness" to play in a more hasting, fleeting manner. When playing a harmonic reduction,
  you must always increase the sketchiness significantly (i.e. > 2.0).
  Do not reduce sketchiness to less than 1.0.
- For "exaggaration", values less than 1.0 will flatten the expressivity, values greater than 1.0 will exaggerate it.
- When the decision spans a long passage, e.g. many measures, or basically throughout the whole piece, you
  should "exemplify", meaning that only a representative portion will be played. Do not use this option when "what" is a 
  measure range. To know how long a passage is, you should consider the given bar numbers over which it spans.
- When the decision is somewhat short, e.g. around three, four beats or less (NB: may cross measure boundary),
  add "context" around it. Context is given as beat length, e.g. 0.25 = a quarter note before and after.
- addition about "message": Never speak decision IDs.

## Hints
Some basic principles of MPM:
* dates are in given ticks, PPQ = 720
* \`<accentuationPattern>\` defines the dynamic accentuation patterns on top of the macro dynamics (given
   with <dynamics>).
* \`<ornament>\` is used to specify arpeggiations. @scale refers to how the associated dynamicsGradient should be scaled.
* \`<rubato>\` defines micro-timing distortion on top of the macro <tempo> modifications.
  Within each frame, the timing is stretched/compressed through the
  @intensity parameter.

## Decisions
Measures are given as "T. [bar]/[beat]". Wdh. indicates that the decision occurs in a repeat. Measure 0 refers
to the initial upbeat before bar 1.
Format: "measures: "decision_id""

Your decisions:
${list}
`.trim();
}

const tools: OpenAI.Responses.Tool[] = [
    {
        type: "function",
        name: "affected_notes",
        description: "Get the notes affected by a given decision ID.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                decision_id: {
                    type: "string",
                    description: "Exact ID of decision to look up."
                },
            },
            required: ["decision_id"],
        },
        strict: true,
    },
    {
        type: "function",
        name: "retrieve_info",
        description: "Get detailed info on a given set of decision IDs.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                decision_ids: {
                    type: "array",
                    items: { type: "string" },
                    description: "Exact IDs of decision to look up."
                },
            },
            required: ["decision_ids"],
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
                    "anyOf": [
                        {
                            "type": "null"
                        },
                        {
                            "type": "string"
                        },
                        {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "from": { "type": "string" },
                                "to": { "type": "string" }
                            },
                            "required": ["from", "to"]
                        }
                    ]
                },
                "mode": {
                    "type": "string",
                    "enum": ["all", "harmony-only", "melody-only"]
                },
                "exaggeration": {
                    "type": "number"
                },
                "sketchiness": {
                    "type": "number"
                },
                "overlap": {
                    "type": "boolean"
                },
                "exemplify": {
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
                "sketchiness",
                "overlap",
                "exemplify",
                "context",
                "message",
                "emotion"
            ]
        }
    }
];

type Query = { question: string; at?: string, session?: string };

lessonRouter.get("/", async (req: Request<{}, {}, {}, Query>, res: Response) => {
    const { question: userRequest, at } = req.query;

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

    let selectedNotes: string | undefined = undefined;
    if (at) {
        const notes = at
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0);

        if (notes.length > 0) {
            const msm = await asMSM(scores.get('all') || '');
            selectedNotes = rangeOfNotes(notes, msm);
        }
    }

    const system = systemPrompt(decisions);
    const user = `${userRequest}
${selectedNotes ? `User selection: ${selectedNotes}` : ''}`;

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

                if (toolName === "play_and_explain") {
                    const step: Step = args;
                    const [audio, performance] = await Promise.all([
                        speakExplanation(step),
                        performInIsolation(step, decisions || [])
                    ]);
                    const { midi_b64, noteIDs } = performance;
                    send("step", {
                        ...step,
                        audio,
                        midi: midi_b64,
                        noteIDs,
                        stepId
                    });

                    const ack = await new Promise((resolve) => {
                        session.waiters.set(stepId, { resolve });
                    });

                    toolOutput = ack;
                } else if (toolName === "retrieve_info") {
                    const info = await retrieveInfo(args.decision_ids);
                    // console.log('info', info)
                    toolOutput = info;
                } else if (toolName === "affected_notes") {
                    const notes = await affectedNotes(args.decision_id);
                    toolOutput = notes;
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
