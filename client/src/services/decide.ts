/**
 * Asking the server what Grünfeld makes of a window.
 *
 * The request is deliberately small. There is no prompt caching at the other end, so every call
 * re-sends and re-bills its whole state, and state size drives the latency tail more than
 * anything else — a 5000-token payload produced a 2.5 s outlier where a 1000-token one did not.
 */
import { assertOk } from './api';

/** The dimensions a short window can identify. `LIVE.md` §1 says why the others cannot. */
const LIVE_DIMENSIONS = ['tempo', 'dynamics'] as const;

/** Mirrors `src/jev/state.ts`. Kept in step by `decide.test.ts`. */
export type Deviation = {
    at: string;
    dimension: string;
    attribute: string;
    severity: string;
    direction: string;
    cue: string;
    gruenfeld: number;
    student: number;
};

export type DecisionRequest = {
    range: { from: number; to: number };
    position: string;
    barsMeasured: string;
    handsOffKeys: boolean;
    measuredTypes: readonly string[];
    alreadyCorrectedThisLesson: readonly { bar: number; dimension: string; times: number }[];
    deviations: readonly Deviation[];
};

export type DecisionVerdict = {
    interrupt: number;
    dimension: string;
    severity: number;
    exaggeration: number;
    mode: string;
    latencyMs: number;
};

export type DecisionResponse<TPlan> = {
    verdict: DecisionVerdict | null;
    plan: TPlan | null;
    /** Set when there is no verdict: the lesson goes on in silence rather than showing an error. */
    skipped?: 'abandoned' | 'refused' | 'unconfigured';
};

/** Turns a window's structured diff into the few fields the decision actually reads. */
export const deviationsFrom = (
    structuredDiff: readonly Record<string, unknown>[],
    dimensions: readonly string[] = LIVE_DIMENSIONS,
): Deviation[] =>
    structuredDiff
        .filter((event) => dimensions.includes(String(event.type)))
        .slice(0, 8)
        .map((event) => ({
            at: String(event.position ?? ''),
            dimension: String(event.type ?? ''),
            attribute: String(event.primaryAttr ?? ''),
            severity: String(event.severity ?? ''),
            direction: String(event.direction ?? ''),
            cue: String(event.cueText ?? ''),
            gruenfeld: Number(event.refValue ?? 0),
            student: Number(event.studentValue ?? 0),
        }));

export const requestDecision = async <TPlan>(
    serverUrl: string,
    request: DecisionRequest,
    signal?: AbortSignal,
): Promise<DecisionResponse<TPlan>> => {
    const response = await fetch(`${serverUrl.replace(/\/$/, '')}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal,
    });
    await assertOk(response);
    return response.json() as Promise<DecisionResponse<TPlan>>;
};
