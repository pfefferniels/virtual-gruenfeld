import { Router } from 'express';
import { openai, DEFAULT_CUE_MODELS, type CuePrepMode } from '../config';
import { MPM_GLOSSARY } from '../prompts/explanation';
import { CUE_SYSTEM_PROMPT, CUE_CONTOUR_SYSTEM_PROMPT, REALTIME_CUE_SYSTEM_PROMPT, CUE_PLAN_SCHEMA } from '../prompts/cuePlanning';

const parseRealtimeCueLines = (text: string): Array<{ position: string; text: string }> => {
    const results: Array<{ position: string; text: string }> = [];
    const seen = new Set<string>();
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        const match = line.match(/^(m\d+\.\d+)\s*[|:-]\s*(.+)$/i);
        if (!match) continue;
        const position = match[1];
        const cueText = match[2].trim();
        if (!cueText || seen.has(position)) continue;
        seen.add(position);
        results.push({ position, text: cueText });
    }
    return results;
};

const planCueTexts = async (
    diff: string,
    candidates: Array<Record<string, unknown>>,
    mode: CuePrepMode,
): Promise<Array<{ position: string; text: string }>> => {
    const model = DEFAULT_CUE_MODELS[mode];
    if (mode === 'realtime') {
        const response = await openai.responses.create({
            model,
            instructions: REALTIME_CUE_SYSTEM_PROMPT,
            input: JSON.stringify({ candidates }),
            max_output_tokens: 120,
        });
        return parseRealtimeCueLines(response.output_text ?? '');
    }

    const response = await openai.responses.create({
        model,
        instructions: CUE_SYSTEM_PROMPT,
        input: JSON.stringify({
            glossary: MPM_GLOSSARY,
            diff,
            candidates,
        }),
        text: { format: CUE_PLAN_SCHEMA },
    });

    const outputText = response.output_text?.trim();
    if (!outputText) return [];

    const parsed = JSON.parse(outputText);
    if (!Array.isArray(parsed?.cues)) return [];

    const seen = new Set<string>();
    const deduped: Array<{ position: string; text: string }> = [];
    for (const cue of parsed.cues) {
        if (typeof cue?.position !== 'string' || typeof cue?.text !== 'string') continue;
        if (seen.has(cue.position)) continue;
        seen.add(cue.position);
        deduped.push(cue);
    }
    if (deduped.length < 2) return deduped;

    try {
        const contourResponse = await openai.responses.create({
            model,
            instructions: CUE_CONTOUR_SYSTEM_PROMPT,
            input: JSON.stringify({ cues: deduped }),
            text: { format: CUE_PLAN_SCHEMA },
        });

        const contourText = contourResponse.output_text?.trim();
        if (!contourText) return deduped;
        const contourParsed = JSON.parse(contourText);
        if (!Array.isArray(contourParsed?.cues)) return deduped;

        const byPosition = new Map(deduped.map((cue) => [cue.position, cue]));
        const shaped: Array<{ position: string; text: string }> = [];
        for (const cue of contourParsed.cues) {
            if (typeof cue?.position !== 'string' || typeof cue?.text !== 'string') continue;
            if (!byPosition.has(cue.position)) continue;
            if (shaped.some((existing) => existing.position === cue.position)) continue;
            shaped.push({ position: cue.position, text: cue.text });
        }
        return shaped.length > 0 ? shaped : deduped;
    } catch {
        return deduped;
    }
};

export const planCuesRouter = Router();

planCuesRouter.post('/plan-cues', async (req, res) => {
    try {
        const startedAt = Date.now();
        const diff = typeof req.body?.diff === 'string' ? req.body.diff : '';
        const candidates = Array.isArray(req.body?.candidates) ? req.body.candidates : [];
        const mode: CuePrepMode = req.body?.mode === 'studio' || req.body?.mode === 'balanced' || req.body?.mode === 'realtime'
            ? req.body.mode
            : 'balanced';
        if (!diff || candidates.length === 0) {
            res.json({ cues: [] });
            return;
        }

        const cues = await planCueTexts(diff, candidates, mode);
        console.log('plan-cues', {
            mode,
            model: DEFAULT_CUE_MODELS[mode],
            candidates: candidates.length,
            returned: cues.length,
            plan_cues_ms: Date.now() - startedAt,
        });
        res.json({ cues });
    } catch (e) {
        console.error('plan-cues error', e);
        res.status(500).json({ error: String(e) });
    }
});
