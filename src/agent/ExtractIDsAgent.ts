import { Agent, run, system, user, tool, RunContext } from '@openai/agents';
import { z } from 'zod';
import { DOMParser } from '@xmldom/xmldom';
import { evaluateXPath } from 'fontoxpath';

export async function extractIDsFromMessage(meiXml: string, message: string): Promise<string[]> {
    const env = buildMeiEnv(meiXml);
    const agent = createIdsAgent();

    const res = await run(
        agent,
        [
            system(
                [
                    'Nutze local-name()="..." für Element-Namen.',
                    'Nutze zur zeitlichen Orientierung auch das @qstamp-Attribut, das jedem <note>-Element zugeordnet wurde. Es zählt durchgängig über Taktgrenzen hinweg. Aber Achtung: Der Baum ist *nicht* nach @qstamp sortiert.',
                    'Ein XPath-Beispiel:',
                    '  ////*[local-name()="measure" and @n=3]//*[local-name()="note"][@pname="f" and @oct="5"]/preceding::*[local-name()="note"][1]/@xml:id',
                ].join('\n')
            ),
            user(message),
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
            'Du bist ein Musiktheoretiker (DE/EN), spezialisiert auf MEI-XML und Notation polyphoner Klaviermusik des 19. Jahrhunderts..',
            'Ziel: Wähle präzise Noten-IDs für das Abspielen.',
            'Verwende ausschließlich "queryXPath". Mache zunächst einen Plan und führe dann die XPath-Abfragen durch. Bevorzuge kleinere und effiziente Abfragen.',
            'Antworte NUR als JSON {"ids":[...]} – keine Erklärungen, Markdown oder ähnliches.',
        ].join('\n'),
        tools: [queryXPath],
    });
}

type MeiEnv = { xml: string; doc: Document };

function buildMeiEnv(xml: string): MeiEnv {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return { xml, doc };
}
