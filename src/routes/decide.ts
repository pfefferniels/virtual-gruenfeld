/**
 * `POST /decide` — one window of playing in, one verdict and a playable plan out.
 *
 * The key stays here. The round trip to Jev crosses the Atlantic once whether the browser makes
 * it or this server does, so the hop costs almost nothing and buys the key not being in a page.
 *
 * What this route does *not* do is decide whether Grünfeld comes in. That is a local rule on the
 * client (`pipeline/standingVerdict.ts`), because at 367 ms p50 and 883 ms p99 nothing over a
 * network can be a reflex.
 */
import type { Request, Response } from 'express';
import { decide } from '../jev/client';
import { planFrom } from '../jev/decide';
import type { DecisionState, Deviation } from '../jev/state';

const asDeviations = (raw: unknown): Deviation[] => {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 8).map((event: Record<string, unknown>) => ({
        at: String(event.at ?? ''),
        dimension: String(event.dimension ?? ''),
        attribute: String(event.attribute ?? ''),
        severity: String(event.severity ?? ''),
        direction: String(event.direction ?? ''),
        cue: String(event.cue ?? ''),
        gruenfeld: Number(event.gruenfeld ?? 0),
        student: Number(event.student ?? 0),
    }));
};

export const decideRoute = async (req: Request, res: Response): Promise<void> => {
    const body = req.body as Record<string, unknown> | undefined;
    const range = body?.range as { from?: unknown; to?: unknown } | undefined;
    const from = Number(range?.from);
    const to = Number(range?.to);

    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
        res.status(400).json({ error: 'range: {from, to} in ticks, with to > from' });
        return;
    }

    const state: DecisionState = {
        position: String(body?.position ?? ''),
        barsMeasured: String(body?.barsMeasured ?? ''),
        handsOffKeys: body?.handsOffKeys === true,
        alreadyCorrectedThisLesson: Array.isArray(body?.alreadyCorrectedThisLesson)
            ? (body.alreadyCorrectedThisLesson as DecisionState['alreadyCorrectedThisLesson'])
            : [],
        deviations: asDeviations(body?.deviations),
    };

    const measuredTypes = Array.isArray(body?.measuredTypes) ? (body.measuredTypes as string[]) : [];
    const outcome = await decide(state);

    if (!outcome.ok) {
        // A missing verdict is not an error the student should see: the lesson goes on in silence.
        res.status(outcome.reason === 'unconfigured' ? 503 : 200)
            .json({ verdict: null, plan: null, skipped: outcome.reason, detail: outcome.detail });
        return;
    }

    const { plan, warnings } = planFrom(outcome.verdict, { range: { from, to }, measuredTypes });
    res.json({ verdict: outcome.verdict, plan, warnings });
};
