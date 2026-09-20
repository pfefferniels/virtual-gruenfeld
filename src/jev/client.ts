/**
 * The call to Jev, and the connection it rides on.
 *
 * Measured from Germany: p50 367 ms, p95 525 ms, p99 883 ms on a warm connection; a cold socket
 * pays a TLS handshake and costs 2.1–2.4 s instead. Nothing in the live loop can wait that long,
 * so the socket is kept warm rather than reopened, and a call that misses its budget is abandoned
 * rather than waited out — a verdict two seconds late points at the wrong bar.
 */
import { QUESTIONS } from './questions';
import { stateFor, type DecisionState } from './state';

const ENDPOINT = process.env.JEV_ENDPOINT ?? 'https://api.typesafe.ai/v1/systemone';

/**
 * Pinned, not `jev-latest`. The thresholds in `decide.ts` are calibrated against this model's
 * probabilities, and an alias that moves underneath them would move the teaching with it.
 */
const MODEL = process.env.JEV_MODEL ?? 'jev-1.13.0';

/**
 * Measured through this route with the connection warm: 588–783 ms. The bare API in a tight loop
 * gives p50 367 ms, so the budget is set against what the server actually sees, not the floor.
 */
const ABANDON_MS = Number(process.env.JEV_ABANDON_MS ?? 1200);

/** Under undici's 4 s keep-alive, so the socket never goes cold between takes. */
const HEARTBEAT_MS = Number(process.env.JEV_HEARTBEAT_MS ?? 3000);

export type Verdict = {
    readonly interrupt: number;
    readonly dimension: string;
    readonly severity: number;
    readonly exaggeration: number;
    readonly mode: string;
    readonly confidence: { readonly dimension: number; readonly severity: number };
    readonly latencyMs: number;
    readonly inputTokens: number;
};

type JevOutcome =
    | { readonly ok: true; readonly verdict: Verdict }
    | { readonly ok: false; readonly reason: 'abandoned' | 'refused' | 'unconfigured'; readonly detail: string };

const apiKey = () => process.env.TYPESAFE_API_KEY;

const post = async (body: unknown, timeoutMs: number): Promise<Response> => {
    const key = apiKey();
    if (!key) throw new Error('TYPESAFE_API_KEY is not set');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
};

export const decide = async (state: DecisionState): Promise<JevOutcome> => {
    if (!apiKey()) return { ok: false, reason: 'unconfigured', detail: 'TYPESAFE_API_KEY is not set' };

    const started = Date.now();
    try {
        const response = await post({ state: stateFor(state), model: MODEL, questions: QUESTIONS }, ABANDON_MS);
        const body = await response.json() as {
            answers: Record<string, { noul?: number; choice?: string; score?: number; confidence?: number }>;
            usage?: { input_tokens?: number };
        };
        if (!response.ok) {
            return { ok: false, reason: 'refused', detail: `HTTP ${response.status} ${JSON.stringify(body).slice(0, 200)}` };
        }
        const answers = body.answers;
        return {
            ok: true,
            verdict: {
                interrupt: answers.interrupt.noul ?? 0,
                dimension: answers.dimension.choice ?? 'none',
                severity: answers.severity.score ?? 0,
                exaggeration: answers.exaggeration.score ?? 0,
                mode: answers.mode.choice ?? 'none',
                confidence: {
                    dimension: answers.dimension.confidence ?? 0,
                    severity: answers.severity.confidence ?? 0,
                },
                latencyMs: Date.now() - started,
                inputTokens: body.usage?.input_tokens ?? 0,
            },
        };
    } catch (error) {
        const abandoned = error instanceof Error && error.name === 'AbortError';
        return {
            ok: false,
            reason: abandoned ? 'abandoned' : 'refused',
            detail: abandoned ? `no answer within ${ABANDON_MS} ms` : String(error instanceof Error ? error.message : error),
        };
    }
};

/**
 * Keeps the connection warm.
 *
 * The cheapest question there is, asked often enough that the socket never closes. Failures are
 * ignored: a heartbeat that cannot reach the service tells the next real call nothing it will not
 * find out for itself.
 */
let heartbeat: NodeJS.Timeout | null = null;

export const startHeartbeat = (): void => {
    if (heartbeat || !apiKey()) return;
    const beat = () => {
        void post(
            { state: 'x', model: MODEL, questions: { warm: { type: 'noul', instructions: 'Is this the letter x?' } } },
            HEARTBEAT_MS,
        ).then(
            (response) => response.body?.cancel(),
            () => undefined,
        );
    };
    heartbeat = setInterval(beat, HEARTBEAT_MS);
    heartbeat.unref();
    beat();
};
