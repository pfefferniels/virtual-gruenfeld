import { Agent, run, user } from "@openai/agents";
import { z } from "zod";

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

export const modifyAgent = new Agent({
    name: "ModifyAgent",
    instructions: `
You are a parameter extraction agent.
From a natural language description, output only valid JSON matching this shape:

{
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
- Use numbers (floats or integers) for all values.
- If a parameter is not described, do not set it.

Mapping examples (non-exhaustive):
- "swing", "inegalité", "inégalité" -> "exaggerate.rubato"
`,
});

function extractJson(raw: string): string {
    const s = raw.trim();
    if (s.startsWith("```")) {
        return s.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    }
    return s;
}

export async function modify(message: string): Promise<ModifyParams> {
    const res = await run(modifyAgent, [user(message)]);
    const raw = (res.finalOutput ?? "").trim();
    const jsonText = extractJson(raw);

    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        const preview = jsonText.slice(0, 500);
        throw new Error(`Model did not return valid JSON. Preview:\n${preview}`);
    }

    const result = ModifyParamsSchema.safeParse(parsed);
    if (!result.success) {
        const preview = jsonText.slice(0, 500);
        throw new Error(
            `Output failed schema validation: ${result.error.message}\nPreview:\n${preview}`
        );
    }
    return result.data;
}
