import { Agent, run, user } from "@openai/agents";

export const summaryAgent = new Agent({
    name: "SummaryAgent",
    instructions: `
The JSON data summarizes which modifications you have applied to an interpretation. 
Summarize it in one short sentence in non-technical, musical language.
Examples:
- "I am playing the passage with slightly exaggerated dynamics."
- "I am playing a harmonic reduction of the piece at a faster tempo to better show
the overarching structure."
Keep the reply sober.`,
    model: 'gpt-5-nano',
    modelSettings: {
        providerData: {
            reasoning: {
                effort: 'low' // minimal introduced too many incorrect statements
            },
            text: {
                verbosity: 'low'
            }
        }
    }
});

export async function summarize(data: object): Promise<string> {
    const res = await run(summaryAgent, [
        user(JSON.stringify(data))
    ]);

    return res.finalOutput || 'No summary available.';
}

