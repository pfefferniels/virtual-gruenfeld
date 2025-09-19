import { Agent, run, system, user, tool, RunContext } from '@openai/agents';
import { z } from 'zod';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { evaluateXPath } from 'fontoxpath';

const evalOptions = {
    namespaceResolver: (prefix: string) => {
        if (prefix === '' || prefix === 'mei') return 'http://www.music-encoding.org/ns/mei'
        return null
    }
}

const isScalar = (v: any) => ['string', 'number', 'boolean'].includes(typeof v);

export function evaluate(xpath: string, env: MeiEnv) {
    const value = evaluateXPath(xpath, env.doc, null, null, undefined, evalOptions);

    if (Array.isArray(value)) {
        if (value.every(isScalar)) {
            // console.log('returning scalar array', value)
            return value;
        }

        const ser = new XMLSerializer();
        const nodes = value as Node[];
        const result = { kind: 'nodes', items: nodes.map(n => (n as any).nodeType === 2 ? (n as Attr).value : ser.serializeToString(n)) };
        console.log('serialized to', result)
        return result;
    }

    if (isScalar(value)) {
        console.log('returning scalar', value)
        return value;
    }

    const ser = new XMLSerializer();
    const result = ser.serializeToString(value as Node);
    return result;
}

export type LabelEntry = {
    key: string;
    description?: string;
    xpath: string;
}

type MeiEnv = { xml: string; doc: Document; labels: LabelIndex };

type MeiContext = { env: MeiEnv };

export async function understandSelection(
    meiXml: string,
    message: string,
    labels?: LabelEntry[]
): Promise<string[]> {
    const env = await buildMeiEnv(meiXml, labels);
    const agent = createIdsAgent();

    const res = await run(
        agent,
        [
            system(
                [].join('\n')
            ),
            user(message),
        ],
        { context: { env } }
    );

    if (!res || !res.finalOutput) {
        throw new Error('No response from agent');
    }

    const ids = evaluate(res.finalOutput.xpath, env)
    if (Array.isArray(ids)) {
        return ids.filter(isScalar).map(String);
    }
    else if (typeof ids === 'string') {
        return [ids]
    }
    else {
        console.log('Something went wrong, ids=', ids)
    }

    return []
}

const buildMeiEnv = async (xml: string, labels?: LabelEntry[]): Promise<MeiEnv> => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return { xml, doc, labels: await buildLabelIndex(labels || []) };
}

export function createIdsAgent() {
    // Tool A: list relevant labels
    const relevantLabels = tool({
        name: 'relevantLabels',
        description: 'Filters all labels relevant for the given message.',
        parameters: z.object({
            message: z.string().describe('The user message to be analyzed'),
        }),
        async execute({ message }, ctx?: RunContext<MeiContext>) {
            if (!ctx) throw new Error('Missing context');
            const labels: LabelIndex = ctx.context.env.labels ?? []
            return filterRelevantLabels(message, labels);
        }
    });

    // Tool C: raw XPath (for full freedom)
    const queryXPath = tool({
        name: 'queryXPath',
        description:
            'Evaluate an XPath on the MEI DOM',
        parameters: z.object({
            xpath: z.string(),
        }),
        async execute({ xpath }, ctx?: RunContext<MeiContext>) {
            if (!ctx) throw new Error('Missing context');
            const { env } = ctx.context;
            return evaluate(xpath, env)
        },
    });

    const ExtractionResult = z.object({
        xpath: z.string().describe('XPath expression returning the xml:ids of the notes to be played'),
    });

    // type ExtractionResult = z.infer<typeof ExtractionResult>;

    return new Agent<MeiContext, typeof ExtractionResult>({
        name: 'SelectionAgent',
        instructions: [
            'Du bist spezialisiert auf MEI-XML, XPath und polyphone Klaviernotation.',
            'Ziel: Korrekter XPath-Ausdruck, der die *xml:ids der <note>-Elemente* zurückgibt, die abgespielt werden sollen. Der finale Ausdruck muss /@xml:id enthalten, pure Nodes sind nicht erlaubt.',
            '   Vorgehen:',
            '    1) Find all relevant predefined labels using relevantLabels(). Then:',
            '     Ideally:',
            '       1) If relevantLabels() returns precisely one entry, take its XPath and return it',
            '       2) If it returns multiple relevant labels, combine their XPath expressions in a way, that they represent the user request best (e.g. by intersecting or unioning) and return that new XPath',
            '     Or less ideal, since expensive and slow:',
            '       1) Falls ein Label beinahe passt: nimm den dazugehörigen XPath-Ausdruck und verfeinere ihn punktuell – teste nur, wenn es komplex wird',
            '       1) falls kein Label passt: probiere und verfeinere iterativ mit queryXPath',
            '          Beachte: Es gibt zur zeitlichen Orientierung taktbasierte @tstamp-Attribute.',
            ' Beispiel: "Spiele die rechte Hand der erste Phrase" = listLabels → "right_hand" und "first_phrase" sind relevant → kombiniere die XPaths zu einem Ausdruck → return',
            ' Beispiel: "Spiele den Akkord auf T. 2, Zählzeit 2 = listLabels  → no label fits  → queryXPath("//measure[@n=2]//note[@tstamp=2]/@xml:id") =>  → return',
        ].join('\n'),
        tools: [relevantLabels, queryXPath],
        outputType: ExtractionResult,
    });
}

import { cos, EMBEDDING_MODEL, getClient, normalize } from "./embeddings";

const asText = (label: LabelEntry) => {
    return [label.key, label.description || ''].join(' • ').trim();
}

type LabelIndex = Array<Pick<LabelEntry, 'key' | 'xpath'> & { vec: number[] }>

export async function buildLabelIndex(labels: LabelEntry[]): Promise<LabelIndex> {
    const inputs = labels.map(asText);

    // Batch-embed in one request
    const client = getClient();
    const emb = await client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: inputs,
    });

    // Normalize
    return emb.data.map((d, i) => ({
        key: labels[i].key,
        xpath: labels[i].xpath,
        vec: normalize(d.embedding as number[]),
    }));
}

/**
 * Finds the most relevant label for a given message.
 * @returns Array of relevant labels (key and xpath), sorted by relevance
 */
async function filterRelevantLabels(message: string, index: LabelIndex, threshold = 0.5): Promise<Pick<LabelEntry, 'key' | 'xpath'>[]> {
    if (!index.length) return []

    const client = getClient();
    const msgEmb = await client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: message,
    });
    const q = normalize(msgEmb.data[0].embedding as number[]);

    // Argmax cosine similarity
    const relevant: (Pick<LabelEntry, 'key' | 'xpath'> & { score: number })[] = []
    for (const item of index) {
        const score = cos(q, item.vec);
        if (score >= threshold) {
            relevant.push({
                key: item.key,
                xpath: item.xpath,
                score
            })
        }
    }
    relevant.sort((a, b) => b.score - a.score);
    console.log('relevant labels', relevant);

    return relevant.map(({ score, ...rest }) => rest);
}
