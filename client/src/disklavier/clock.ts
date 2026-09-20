/**
 * The page clock, and work deferred against it.
 *
 * `performance.now()` is the one clock this path needs. An incoming `MIDIMessageEvent.timeStamp`
 * and the timestamp handed to `MIDIOutput.send` are the same domain, so input and output are
 * directly comparable and nothing here converts between clocks — in particular there is no
 * AudioContext on the Disklavier path.
 *
 * Both are injected rather than reached for, so that the scheduler can be driven by a test clock
 * and every timing decision asserted without waiting for real time to pass.
 */

export type Clock = () => number;

/** Run `task` after `delayMs`. The returned function cancels it while it is still pending. */
export type Defer = (delayMs: number, task: () => void) => () => void;

export type Timing = { readonly now: Clock; readonly defer: Defer };

export const pageTiming: Timing = {
    now: () => performance.now(),
    defer: (delayMs, task) => {
        const id = window.setTimeout(task, delayMs);
        return () => window.clearTimeout(id);
    },
};

export type TestTiming = Timing & {
    /** Move the clock forward, running whatever falls due on the way at the time it falls due. */
    advance(byMs: number): void;
};

type Pending = { readonly atMs: number; readonly task: () => void; cancelled: boolean };

export const createTestTiming = (startMs = 0): TestTiming => {
    let nowMs = startMs;
    let pending: Pending[] = [];

    const nextDue = (untilMs: number): Pending | undefined =>
        pending.filter((p) => !p.cancelled && p.atMs <= untilMs).sort((a, b) => a.atMs - b.atMs)[0];

    return {
        now: () => nowMs,

        defer: (delayMs, task) => {
            const entry: Pending = { atMs: nowMs + delayMs, task, cancelled: false };
            pending.push(entry);
            return () => {
                entry.cancelled = true;
            };
        },

        advance(byMs) {
            const targetMs = nowMs + byMs;
            for (let due = nextDue(targetMs); due; due = nextDue(targetMs)) {
                pending = pending.filter((p) => p !== due);
                nowMs = Math.max(nowMs, due.atMs);
                due.task();
            }
            nowMs = targetMs;
        },
    };
};
