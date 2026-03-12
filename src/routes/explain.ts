import { Router } from 'express';
import { openai, MODEL } from '../config';
import { EXPLANATION_SYSTEM_PROMPT } from '../prompts/explanation';

const streamExplanation = async (
    diff: string,
    send: (event: string, data: unknown) => void,
): Promise<void> => {
    const stream = await openai.responses.create({
        model: MODEL,
        stream: true,
        instructions: EXPLANATION_SYSTEM_PROMPT,
        input: diff,
    });

    for await (const event of stream as any) {
        if (event.type === 'response.output_text.delta') {
            const delta: string = event.delta ?? '';
            if (!delta) continue;
            send('delta', delta);
        } else if (event.type === 'response.failed' || event.type === 'response.incomplete') {
            send('error', { type: event.type });
            return;
        }
    }
};

export const explainRouter = Router();

explainRouter.post('/explain', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const send = (event: string, data: any) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    };

    try {
        await streamExplanation(req.body.diff, send);
    } catch (e) {
        console.error('explain error', e);
        send('error', { message: String(e) });
    } finally {
        res.end();
    }
});
