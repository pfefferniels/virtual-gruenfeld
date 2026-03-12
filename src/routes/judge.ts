import { Router } from 'express';
import { openai, JUDGEMENT_MODEL } from '../config';
import { JUDGEMENT_SYSTEM_PROMPT, sanitizeJudgementText } from '../prompts/judgement';

export const judgeRouter = Router();

judgeRouter.post('/judge', async (req, res) => {
    try {
        const startedAt = Date.now();
        const summary = req.body?.summary;
        if (typeof summary !== 'object' || summary === null) {
            res.json({ text: '' });
            return;
        }

        const response = await openai.responses.create({
            model: JUDGEMENT_MODEL,
            instructions: JUDGEMENT_SYSTEM_PROMPT,
            input: JSON.stringify(summary),
            max_output_tokens: 18,
        });

        const text = sanitizeJudgementText(response.output_text ?? '');
        console.log('judge', {
            model: JUDGEMENT_MODEL,
            judgement_ms: Date.now() - startedAt,
            text,
        });
        res.json({ text });
    } catch (e) {
        console.error('judge error', e);
        res.status(500).json({ error: String(e) });
    }
});
