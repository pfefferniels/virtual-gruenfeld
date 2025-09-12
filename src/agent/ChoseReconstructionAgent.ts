// ChooseReconstructionAgent.ts
import { Agent, run, system, user } from '@openai/agents';
import { z } from 'zod';
import { listAvailableReconstructions } from '../utils/fileSystem';

// Build a Zod enum from a non-empty string array
function reconEnum(ids: string[]) {
    return z.enum(ids as [string, ...string[]]);
}

const chooseAgent = new Agent({
    name: 'ChooseReconstruction',
    instructions: `You pick the best matching reconstruction id for a piano performance app.
Return ONLY JSON like {"reconId":"<one of the provided ids>"}. If nothing specific is
indicated prefer the one most likely default.`
});

export async function chooseReconstruction(message: string): Promise<string> {
    // Load available reconstructions
    const list = listAvailableReconstructions(); // e.g., [{ id: 'full_reconstruction', label: '...' }, ...]
    const ids = list.map(r => r.id);

    if (ids.length === 0) {
        throw new Error('No reconstructions available');
    }

    // Build a schema constrained to current ids
    const Schema = z.object({ reconId: reconEnum(ids) });

    const res = await run(chooseAgent, [
        system(
            `You must select exactly one of these reconstruction ids: ${JSON.stringify(
                ids
            )}. Also consider their labels: ${JSON.stringify(list)}.`
        ),
        user(`User message: ${message}\nReturn only: {"reconId":"<one-of-ids>"}`),
    ]);

    const raw = (res.finalOutput ?? '').trim();
    const json = raw.startsWith('```')
        ? raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
        : raw;

    const { reconId } = Schema.parse(JSON.parse(json));
    return reconId;
}
