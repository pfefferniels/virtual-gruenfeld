import OpenAI from "openai";
import { listAvailableReconstructions } from "../utils/fileSystem";
import { ReconInfo } from "../types";
import { cos, EMBEDDING_MODEL, getClient, normalize } from "./embeddings";

const asText = (r: ReconInfo) => {
    return [r.id, r.label, r.description || ''].join(' • ').trim();
}

let index: { id: string; vec: number[] }[] | null = null;

export async function buildReconIndex() {
    const list = listAvailableReconstructions()
    if (!list.length) throw new Error("No reconstructions available");

    const inputs = list.map(asText);

    // Batch-embed in one request
    const client = getClient();
    const emb = await client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: inputs,
    });

    // Normalize once for fast cosine
    index = emb.data.map((d, i) => ({
        id: list[i].id,
        vec: normalize(d.embedding as number[]),
    }));
    return index.map(x => x.id);
}

/**
 * Finds the most relevant reconstruction for a given message.
 * @returns reconstruction ID, or undefined if no good match found
 */
export async function chooseReconstruction(message: string, threshold = 0.15): Promise<string | undefined> {
    const list = listAvailableReconstructions()
    const ids = list.map(r => r.id);
    if (!ids.length) throw new Error("No reconstructions available");

    if (!index) await buildReconIndex();

    const client = getClient();
    const msgEmb = await client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: message,
    });
    const q = normalize(msgEmb.data[0].embedding as number[]);

    // Argmax cosine similarity
    let bestId = ids[0], bestScore = -Infinity;
    for (const item of index!) {
        const s = cos(q, item.vec);
        if (s > bestScore) { bestScore = s; bestId = item.id; }
    }

    console.log('bestId', bestId, 'score', bestScore.toFixed(3));

    if (bestScore >= threshold) return bestId
}
