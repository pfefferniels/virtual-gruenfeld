import OpenAI from "openai"

let client: OpenAI | null = null;

export function getClient() {
    if (!client) {
        if (!process.env.OPENAI_API_KEY) {
            throw new Error("OPENAI_API_KEY missing");
        }
        client = new OpenAI();
    }
    return client;
}

export const EMBEDDING_MODEL = "text-embedding-3-small";

export function l2norm(v: number[]) {
    let s = 0; for (const x of v) s += x * x;
    return Math.sqrt(s);
}

export function normalize(v: number[]) {
    const n = l2norm(v) || 1;
    return v.map(x => x / n);
}

export function cos(a: number[], b: number[]) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s; // works because both are normalized
}

