// src/ai/ExtractIDsFromMEIAgent.ts
import { Agent, run, system, user, tool, RunContext } from '@openai/agents';
import { z } from 'zod';
import { DOMParser } from '@xmldom/xmldom';
import { evaluateXPath } from 'fontoxpath';

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
                    'Nutze local-name() für Element-Namen. Sei kreativ mit deinen XPath-Ausdrücken.',
                    'Nutze zur zeitlichen Orientierung besonders das @qstamp-Attribut, das jedem <note>-Element zugeordnet wurde. Es zählt durchgängig über Taktgrenzen hinweg.',
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
            xpath: z.string()
        }),
        async execute({ xpath }, ctx?: RunContext<MeiContext>) {
            if (!ctx) throw new Error('Missing context');
            const { env } = ctx.context;
            return evaluateXPath(xpath, env.doc, null, null)
        },
    });

    return new Agent<MeiContext>({
        name: 'ExtractIDsAgent',
        instructions: [
            'Du bist ein exzellenter Musiktheoretiker (DE/EN), spezialisiert auf MEI-XML und Notation polyphoner Klaviermusik des 19. Jahrhunderts..',
            'Ziel: Wähle präzise Noten-IDs für das Abspielen.',
            'Verwende ausschließlich "queryXPath".',
            'Antworte NUR als JSON {"ids":[...]} – keine Erklärungen.',
        ].join('\n'),
        tools: [queryXPath],
    });
}

type MeiEnv = { xml: string; doc: Document };

function buildMeiEnv(xml: string): MeiEnv {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return { xml, doc };
}
