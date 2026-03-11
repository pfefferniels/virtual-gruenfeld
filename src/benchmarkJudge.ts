import 'dotenv/config';
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SAMPLE_SUMMARY = {
    score: 72,
    verdict: 'good',
    rangeBeats: 12,
    eventCount: 3,
    dominantTypes: [
        { type: 'dynamics', penalty: 4.5, count: 2, worstSeverity: 'mod' },
        { type: 'tempo', penalty: 2.5, count: 1, worstSeverity: 'mod' },
    ],
    topIssues: [
        { type: 'dynamics', severity: 'mod', cueText: 'leiser', position: 'm2.2' },
        { type: 'tempo', severity: 'mod', cueText: 'ruhiger', position: 'm3.1' },
    ],
};

const CURRENT_PROMPT = `Du bist ein kurzer, ehrlicher und ermutigender Klavierlehrer.

Du bekommst NUR eine kompakte, strukturierte Bewertung einer Passage.
Deine Aufgabe:
- Formuliere genau EINEN kurzen deutschen Satz.
- Ideal 3 bis 8 Woerter, maximal 10.
- Ehrlich, knapp, natuerlich, ermutigend.
- Wenn die Passage insgesamt gut war, lobe kurz.
- Wenn etwas noch klar heraussticht, nenne maximal EIN Hauptfeld.
- Erfinde niemals Details, Stellen, Taktzahlen, Techniken oder Fehler, die nicht im Input stehen.
- Erwaehne nur Problemfelder, die explizit in dominantTypes oder topIssues vorkommen.
- Keine Listen, keine Zahlen, keine Begruendung.

Antworte nur als JSON im Schema {"text": "..."} .`;

const COMPACT_PROMPT = `Ein kurzer Klavierlehrer-Satz auf Deutsch.
Genau 1 Satz, 3 bis 8 Woerter, maximal 10.
Ehrlich und ermutigend.
Nur loben oder maximal EIN Problemfeld nennen.
Nur Felder aus dominantTypes oder topIssues verwenden.
Nichts erfinden.
Antworte nur als JSON: {"text":"..."}.`;

const PLAIN_PROMPT = `Ein kurzer deutscher Klavierlehrer-Satz.
3 bis 8 Woerter.
Ehrlich, knapp, ermutigend.
Nur loben oder maximal EIN Problemfeld aus dominantTypes/topIssues nennen.
Nichts erfinden.
Antworte nur mit dem Satz.`;

type Config = {
    name: string;
    model: string;
    prompt: string;
    schema: 'json' | 'plain';
    reasoningEffort?: 'none' | 'minimal' | 'low';
    verbosity?: 'low' | 'medium' | 'high';
    maxOutputTokens?: number;
};

const CONFIGS: Config[] = [
    {
        name: 'baseline_nano_json',
        model: 'gpt-5-nano',
        prompt: CURRENT_PROMPT,
        schema: 'json',
        maxOutputTokens: 24,
    },
    {
        name: 'nano_minimal_low_json',
        model: 'gpt-5-nano',
        prompt: COMPACT_PROMPT,
        schema: 'json',
        reasoningEffort: 'minimal',
        verbosity: 'low',
        maxOutputTokens: 18,
    },
    {
        name: 'mini_minimal_low_json',
        model: 'gpt-5-mini',
        prompt: COMPACT_PROMPT,
        schema: 'json',
        reasoningEffort: 'minimal',
        verbosity: 'low',
        maxOutputTokens: 18,
    },
    {
        name: 'gpt51_none_plain',
        model: 'gpt-5.1',
        prompt: PLAIN_PROMPT,
        schema: 'plain',
        reasoningEffort: 'none',
        verbosity: 'low',
        maxOutputTokens: 16,
    },
    {
        name: 'gpt41mini_plain',
        model: 'gpt-4.1-mini',
        prompt: PLAIN_PROMPT,
        schema: 'plain',
        maxOutputTokens: 16,
    },
    {
        name: 'gpt41mini_json',
        model: 'gpt-4.1-mini',
        prompt: COMPACT_PROMPT,
        schema: 'json',
        maxOutputTokens: 18,
    },
];

const extractText = (response: any, schema: 'json' | 'plain'): string => {
    const outputText = typeof response.output_text === 'string' ? response.output_text.trim() : '';
    if (schema === 'plain') return outputText.replace(/^"+|"+$/g, '').trim();
    if (!outputText) return '';
    try {
        const parsed = JSON.parse(outputText);
        return typeof parsed?.text === 'string' ? parsed.text.trim() : '';
    } catch {
        return outputText;
    }
};

const runOne = async (config: Config) => {
    const startedAt = Date.now();
    const response = await client.responses.create({
        model: config.model,
        instructions: config.prompt,
        input: JSON.stringify(SAMPLE_SUMMARY),
        max_output_tokens: config.maxOutputTokens,
        ...(config.reasoningEffort ? { reasoning: { effort: config.reasoningEffort } } : {}),
        ...(config.verbosity ? { text: { verbosity: config.verbosity } } : {}),
        ...(config.schema === 'json'
            ? {
                text: {
                    ...(config.verbosity ? { verbosity: config.verbosity } : {}),
                    format: {
                        type: 'json_schema',
                        name: 'judge',
                        strict: true,
                        schema: {
                            type: 'object',
                            additionalProperties: false,
                            properties: { text: { type: 'string' } },
                            required: ['text'],
                        },
                    },
                },
            }
            : {}),
    } as any);

    return {
        name: config.name,
        model: config.model,
        ms: Date.now() - startedAt,
        text: extractText(response, config.schema),
        usage: response.usage,
    };
};

const main = async () => {
    for (const config of CONFIGS) {
        try {
            const result = await runOne(config);
            const promptTokens = result.usage?.input_tokens ?? '?';
            const outputTokens = result.usage?.output_tokens ?? '?';
            const reasoningTokens = result.usage?.output_tokens_details?.reasoning_tokens ?? 0;
            console.log([
                result.name,
                `model=${result.model}`,
                `ms=${result.ms}`,
                `prompt_tokens=${promptTokens}`,
                `output_tokens=${outputTokens}`,
                `reasoning_tokens=${reasoningTokens}`,
                `text=${JSON.stringify(result.text)}`,
            ].join(' | '));
        } catch (error) {
            console.log(`${config.name} | model=${config.model} | error=${String(error)}`);
        }
    }
};

void main();
