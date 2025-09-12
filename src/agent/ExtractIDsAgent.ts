// src/ai/ExtractIDsFromMEIAgent.ts
import { Agent, run, system, user, tool, RunContext } from '@openai/agents';
import { z } from 'zod';
import { DOMParser } from '@xmldom/xmldom';
import { evaluateXPathToNodes } from 'fontoxpath';

/** Public API: call from your PianistAgent
 *   const meiXml = await loadMEI(reconstruction)
 *   const ids = await extractIDsFromMessage(meiXml, userMessage)
 */
export async function extractIDsFromMessage(meiXml: string, message: string): Promise<string[]> {
    const env = buildMeiEnv(meiXml);
    const agent = createIdsAgent();

    const res = await run(
        agent,
        [
            system(
                [
                    'Du bist ein exzellenter Musiktheoretiker (DE/EN), spezialisiert auf MEI-XML.',
                    'Arbeite ausschließlich mit dem Tool "queryXPath".',
                    'Antworte NUR als JSON {"ids":[...]} – keine Erklärungen, kein Markdown.',
                    'Nutze local-name() für Element-Namen. Sei kreativ mit deinen XPath-Ausdrücken.',
                    'Ein XPath-Beispiel:',
                    '  ////*[local-name()="measure" and @n=3]//*[local-name()="note"][@pname="f" and @oct="5"]/preceding::*[local-name()="note"][1]/@xml:id',

                ].join('\n')
            ),
            user(`MEI ist geladen. Aufgabe: Wähle präzise Noten-IDs.\nNutzer: ${message}`),
        ],
        { context: { env } }
    );

    const raw = (res.finalOutput ?? '').toString().trim();
    const json = raw.startsWith('```') ? raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim() : raw;
    try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed?.ids) ? parsed.ids : [];
    } catch {
        return [];
    }
}

/* ───────────────────────── Agent + Tool ───────────────────────── */

type MeiContext = { env: MeiEnv };

export function createIdsAgent() {
    // Single tool: agent supplies the XPath; we return IDs.
    const queryXPath = tool({
        name: 'queryXPath',
        description:
            'Evaluate an XPath on the MEI DOM.' +
            'You do not need to use a particular prefix',
        // SDK constraint: all fields required → use nullable() for “optional”
        parameters: z.object({
            xpath: z.string(),                                   // REQUIRED
            limit: z.number().int().min(1).max(20000).nullable() // pass null if unused
        }),
        async execute({ xpath, limit }, ctx?: RunContext<MeiContext>) {
            if (!ctx) throw new Error('Missing context');
            const { env } = ctx.context;
            const ids = evalXPathForIds(env, xpath, limit ?? undefined);
            return { ids };
        },
    });

    return new Agent<MeiContext>({
        name: 'ExtractIDsAgent',
        instructions: [
            'Du bist ein exzellenter Musiktheoretiker (DE/EN), spezialisiert auf MEI-XML.',
            'Ziel: Wähle präzise Noten-IDs für das Abspielen.',
            'Verwende ausschließlich "queryXPath".',
            'Antworte NUR als JSON {"ids":[...]} – keine Erklärungen.',
        ].join('\n'),
        tools: [queryXPath],
    });
}

/* ───────────────────── MEI env + XPath helper ─────────────────── */

type MeiEnv = { xml: string; doc: Document };

function buildMeiEnv(xml: string): MeiEnv {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return { xml, doc };
}

//const ns = (prefix: string) => (prefix === 'mei' ? 'http://www.music-encoding.org/ns/mei' : null);

/** Map XPath result to xml:ids:
 *  - If attribute nodes: accept @xml:id or @id values
 *  - If element nodes: only <note>/<rest>; read @xml:id or @id
 *  - Ignore other node types
 */
function evalXPathForIds(env: MeiEnv, xpath: string, limit?: number): string[] {
    const nodes = evaluateXPathToNodes(xpath, env.doc, null) as Node[];
    const out: string[] = [];
    const cap = Math.min(limit ?? 5000, 20000); // hard cap

    for (const n of nodes) {
        if (n.nodeType === 2 /* ATTRIBUTE_NODE */) {
            const a = n as Attr;
            if (a.name === 'xml:id' || a.name === 'id') out.push(a.value);
        } else if (n.nodeType === 1 /* ELEMENT_NODE */) {
            const el = n as Element;
            const ln = (el.localName || el.nodeName).replace(/^.*:/, '').toLowerCase();
            if (ln === 'note' || ln === 'rest') {
                const id = el.getAttribute('xml:id') || el.getAttribute('id');
                if (id) out.push(id);
            }
        }
        if (out.length >= cap) break;
    }
    return out;
}
