import { Agent, run, system, user } from '@openai/agents';
import { z } from 'zod';

const intentAgent = new Agent({
    name: 'IntentClassifier',
    instructions: `Classify the user's intent for a piano performance app.
Return ONLY JSON like {"intent":"play"} or {"intent":"stop"}.
If they say "Danke", "Stopp", "Hör auf", "es reicht" or similar → "stop".
Otherwise → "play".`
});

const IntentSchema = z.object({ intent: z.enum(['play', 'stop']) });

export async function extractIntent(message: string): Promise<'play' | 'stop'> {
    try {
        const res = await run(intentAgent, [
            system('Return ONLY valid JSON with the exact schema: {"intent":"play"|"stop"}'),
            user(message),
        ]);
        const raw = (res.finalOutput ?? '').trim();
        const json = raw.startsWith('```') ? raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim() : raw;
        const { intent } = IntentSchema.parse(JSON.parse(json));
        return intent;
    } catch {
        // Safe default
        return 'play';
    }
}
