import { Agent, run, system, user, tool, RunContext } from '@openai/agents';
import { z } from 'zod';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { evaluateXPath, evaluateXPathToNodes } from 'fontoxpath';

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
} & ({ ids: string[] } | { xpath: string });

type MeiEnv = { xml: string; doc: Document; labels?: LabelEntry[] };

type MeiContext = { env: MeiEnv };

export async function extractIDsFromMessage(
    meiXml: string,
    message: string,
    labels?: LabelEntry[]
): Promise<string[]> {
    const env = buildMeiEnv(meiXml, labels);
    const meta = summarizeMei(env.doc);

    const agent = createIdsAgent(meta);

    const res = await run(
        agent,
        [
            system(
                [
                ].join('\n')
            ),
            user(message),
        ],
        { context: { env } }
    );

    if (!res || !res.finalOutput) {
        throw new Error('No response from agent');
    }

    const json = JSON.parse(res.finalOutput)
    if (!('xpath' in json)) {
        throw new Error('Invalid response from agent');
    }

    const ids = evaluate(json.xpath, env)
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

function buildMeiEnv(xml: string, labels?: LabelEntry[]): MeiEnv {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return { xml, doc, labels };
}

export function createIdsAgent(meta: any) {
    // Tool A: list labels (so the agent knows what exists)
    const listLabels = tool({
        name: 'listLabels',
        description: 'List available semantic labels for this piece (keys + description).',
        parameters: z.object({}),
        async execute(_args, ctx?: RunContext<MeiContext>) {
            if (!ctx) throw new Error('Missing context');
            const labels: LabelEntry[] = ctx.context.env.labels ?? []

            return {
                labels: labels.map(l => ({
                    key: l.key,
                    description: l.description
                }))
            };
        },
    });

    // Tool B: resolve a label to ids and/or a base XPath (agent can refine further)
    const resolveLabel = tool({
        name: 'resolveLabel',
        description:
            'Resolve a label to an array of IDs or to an XPath expression.',
        parameters: z.object({
            key: z.string()
        }),
        async execute({ key }, ctx?: RunContext<MeiContext>) {
            if (!ctx) throw new Error('Missing context');
            const { env } = ctx.context;
            const labels = env.labels ?? [];
            const entry = labels.find(l => l.key === key)
            if (!entry) return { ids: [], meta: { ok: false, reason: 'unknown_label' } };
            return entry
        },
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

    return new Agent<MeiContext>({
        name: 'ExtractIDsAgent',
        instructions: [
            'Du bist spezialisiert auf MEI-XML, XPath und polyphone Klaviernotation.',
            'Ziel: Korrekter XPath-Ausdruck, der die *xml:ids der <note>-Elemente* zurückgibt, die abgespielt werden sollen. Der finale Ausdruck muss /@xml:id enthalten, pure Nodes sind nicht erlaubt.',
            `Dokument-Überblick: ${JSON.stringify(meta)}`,
            '   Vorgehen:',
            '    1) Finde zuerst alle vordefinierten Labels (listLabels), die für die Anfrage relevant sind. Dann:',
            '     Idealer Pfad:',
            '       1) Falls genau eines perfekt passt: Löse es auf (resolveLabel) und gib den XPath-Ausdruck zurück',
            '       2) falls mehrere Labels relevant sind: kombiniere/verknüpfe die dazugehörigen XPath-Ausdrücke so, dass sie dem Nutzerwunsch entsprechen und gib sie *ohne Tests mit queryXPath* zurück',
            '     Weniger ideal, da teuer – versuche nicht, ein Perfektionist zu sein:',
            '       1) Falls ein Label beinahe passt: nimm es (resolveLabel) und verfeinere es punktuell – teste nur, wenn es komplex wird',
            '       1) falls kein Label passt: probiere und verfeinere iterativ mit queryXPath',
            '          Beachte: Es gibt zur zeitlichen Orientierung taktbasierte @tstamp-Attribute.',
            ' Beispiel: "Spiele die rechte Hand der erste Phrase" = listLabels → resolveLabel("right_hand") + resolveLabel("first_phrase") → kombiniere die XPaths zu einem Ausdruck → return',
            ' Beispiel: "Spiele den Akkord auf T. 2, Zählzeit 2 = listLabels  → no label fits  → queryXPath("//measure[@n=2]//note[@tstamp=2]/@xml:id") =>  → return',
            '*Antworte immer nur als JSON {"xpath":"[XPath-Ausdruck, der xml:ids zurückgibt]"} – keine Erklärungen, kein Markdown*',
        ].join('\n'),
        tools: [listLabels, resolveLabel, queryXPath],
    });
}

/** doc summary to help in system prompt (MEI-aware) */
function summarizeMei(doc: Document) {
    const measureEls = evaluateXPathToNodes('//measure[@n]', doc, null, null, evalOptions) as Element[]

    const measures = measureEls
        .map((m) => ({
            no: parseInt(m.getAttribute('n') || '', 10),
            el: m,
            xmlId: m.getAttribute('xml:id') || undefined,
        }))
        .filter((x) => Number.isFinite(x.no))
        .sort((a, b) => a.no - b.no);

    const sections = evaluateXPathToNodes('//section[@xml:id]/@xml:id', doc, null, null, evalOptions) as Attr[];
    const sectionIds = sections.map((s => s.value))

    // --- First measure @metcon (anacrusis / pickup) ---
    const firstMeasure = measures[0];
    const firstMetcon = firstMeasure?.el.getAttribute('metcon') ?? undefined;
    const upbeat = firstMetcon === 'false';

    // --- Staff numbers present in notes/rests ---
    const noteOrRest = evaluateXPathToNodes('//note | //rest', doc, null, null, evalOptions) as Element[];
    const staffNums = new Set<number>();
    for (const el of noteOrRest) {
        const s = parseInt(el.getAttribute('staff') || '', 10);
        if (Number.isFinite(s)) staffNums.add(s);
    }

    const staffDef = (evaluateXPathToNodes('//staffDef', doc, null, null, evalOptions) as Element[])[0];
    let meterCount: string | null = null;
    let meterUnit: string | null = null;
    if (staffDef) {
        meterCount = staffDef.getAttribute('meter.count')
        meterUnit = staffDef.getAttribute('meter.unit')
    }

    return `${measures.length} measures, 2 piano staves, meter: ${meterCount}/${meterUnit}, pickup: ${upbeat}, sections: ${sectionIds.join(', ')}`
}
