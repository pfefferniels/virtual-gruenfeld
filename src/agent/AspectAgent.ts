import { Agent, run, system, user } from "@openai/agents";
import { z } from "zod";
import { listAvailableReconstructions } from "../utils/fileSystem";

const factor = z.number().finite().nonnegative();

const IncreaseSchema = z
    .object({
        tempo: factor.optional(),
        dynamics: factor.optional(),
    })
    .strict();

const ExaggerateSchema = z
    .object({
        rubato: factor.optional(),
        tempo: factor.optional(),
        dynamics: factor.optional(),
        temporalSpread: factor.optional(),
        dynamicsGradient: factor.optional(),
        relativeVelocity: factor.optional(),
        relativeDuration: factor.optional(),
    })
    .strict();

export const ModifyParamsSchema = z
    .object({
        reconstruction: z.string().optional(),
        increase: IncreaseSchema.optional(),
        exaggerate: ExaggerateSchema.optional(),
    })
    .strict()
    .refine(
        (obj) =>
            (obj.increase && Object.keys(obj.increase).length > 0) ||
            (obj.exaggerate && Object.keys(obj.exaggerate).length > 0),
        { message: "Payload must include at least one parameter under increase or exaggerate." }
    );

export type ModifyParams = z.infer<typeof ModifyParamsSchema>;

export const aspectAgent = new Agent({
    name: "AspectAgent",
    instructions: `
Your job is to find out how best to render a piece of music, so that the user can 
hear what he is interested in. If e.g. the user is interested in the overall phrasing
of the whole piece, it might be a good strategy to choose the reconstruction called "harmonic-reduction"
and to play it with increased tempo, so that the user gets a feeling of what the 
overall phrases sound like. If the user is interested in the melodic shape,
you might choose the reconstruction "melodic-focus" and play it with some exaggeration
of the dynamics. In general however, it is best to stick to the default reconstruction.

Technically, output only valid JSON matching this shape:

{
  "reconstruction": <string>,
  "increase": {
    "tempo": <number>,
    "dynamics": <number>
  },
  "exaggerate": {
    "rubato": <number>,
    "tempo": <number>,
    "dynamics": <number>,
    "temporalSpread": <number>,
    "dynamicsGradient": <number>,
    "relativeVelocity": <number>,
    "relativeDuration": <number>
  }
}

Rules:
- Output JSON only, no explanation or text.
- Use numbers (floats or integers) for all values in the interval [-1, 1], where 0 means no modification.

Mapping examples (non-exhaustive):
- "swing", "inegalité", "inégalité" -> "exaggerate.rubato"`,
});

function extractJson(raw: string): string {
    const s = raw.trim();
    if (s.startsWith("```")) {
        return s.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    }
    return s;
}

export async function understandAspect(message: string): Promise<ModifyParams | null> {
    if (message.length === 0) return null

    const res = await run(aspectAgent, [
        system(`Available reconstructions are:
${listAvailableReconstructions().map(({ id, label, description }) => `- ID: "${id}", Label: "${label}", Description: "${description}"`).join('\n')}`),
        user(message)
    ]);
    const raw = (res.finalOutput ?? "").trim();
    const jsonText = extractJson(raw);

    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        const preview = jsonText.slice(0, 500);
        throw new Error(`Model did not return valid JSON. Preview:\n${preview}`);
    }

    // console.log('parsed=', parsed)

    const result = ModifyParamsSchema.safeParse(parsed);
    if (!result.success) {
        const preview = jsonText.slice(0, 500);
        console.log(
            `Output failed schema validation: ${result.error.message}\nPreview:\n${preview}`
        );
        return null
    }
    return result.data;
}
