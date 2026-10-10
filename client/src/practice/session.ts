/**
 * Grünfeld at the piano on his own: a planned session, played pass by pass, that can be put down
 * the moment somebody comes in and picked up again where it was.
 *
 * The playing itself is injected, like everything that touches the world in `pipeline/`: the
 * Disklavier or the sampler, and the clock. Putting it down silences the pass in flight; picking
 * it up plays that pass again from its start, as a pianist interrupted would. When a session is
 * over he plans the next one and carries on.
 */
import type { MidiFile } from 'midifile-ts';
import { makePlan, rangeLabel, type Episode, type Pass } from './planner';
import type { RenderedPass } from './render';

type PracticeDeps = {
    readonly interest: readonly number[];
    readonly render: (pass: Pass) => RenderedPass;
    /** Start the pass now. Returns how long from now until it has finished sounding. */
    readonly play: (midi: MidiFile, durationMs: number) => number;
    /** Take the hands off the keys. */
    readonly silence: () => void;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly seed?: number;
    /** Every pass as it starts, and null when the practice is put down. */
    readonly onPass?: (now: PracticeNow | null) => void;
    readonly log?: (line: string) => void;
};

export type PracticeNow = {
    readonly seed: number;
    readonly episode: number;
    readonly episodes: number;
    readonly pass: number;
    readonly passes: number;
    readonly bars: string;
    readonly title: string;
    readonly character: string;
    readonly source: Pass['source'];
    readonly speed?: number;
};

export type Practice = {
    /** Play on from where he was. Does nothing while already playing. */
    resume(): void;
    /** Stop at once, mid-pass. The interrupted pass is played again on {@link resume}. */
    pause(): void;
    readonly playing: boolean;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const describe = (seed: number, plan: readonly Episode[], e: number, k: number): PracticeNow => {
    const episode = plan[e];
    const pass = episode.passes[k];
    return {
        seed,
        episode: e + 1,
        episodes: plan.length,
        pass: k + 1,
        passes: episode.passes.length,
        bars: rangeLabel(pass.range[0], pass.range[1]),
        title: episode.title,
        character: pass.character,
        source: pass.source,
        speed: pass.speed,
    };
};

export const createPractice = (deps: PracticeDeps): Practice => {
    const sleep = deps.sleep ?? defaultSleep;
    let seed = deps.seed ?? 1 + Math.floor(Math.random() * 9998);
    let plan = makePlan(seed, deps.interest);
    let at = { e: 0, k: 0 };
    let token = 0;
    let playing = false;

    const run = async (mine: number) => {
        while (mine === token) {
            if (at.e >= plan.length) {
                seed += 1;
                plan = makePlan(seed, deps.interest);
                at = { e: 0, k: 0 };
                deps.log?.(`PRACTICE: session ${seed}, ${plan.length} episodes`);
            }
            const pass = plan[at.e].passes[at.k];
            let finishesInMs = 0;
            try {
                const rendered = deps.render(pass);
                if (mine !== token) return;
                if (rendered.durationMs > 0) {
                    deps.onPass?.(describe(seed, plan, at.e, at.k));
                    finishesInMs = deps.play(rendered.midi, rendered.durationMs);
                }
            } catch (error) {
                deps.log?.(`PRACTICE: pass skipped (${error instanceof Error ? error.message : String(error)})`);
            }
            await sleep(finishesInMs);
            if (mine !== token) return;

            // The pass is over: an interruption from here on resumes with the next one.
            at = at.k + 1 < plan[at.e].passes.length ? { e: at.e, k: at.k + 1 } : { e: at.e + 1, k: 0 };
            await sleep(pass.pause * 1000);
        }
    };

    return {
        resume() {
            if (playing) return;
            playing = true;
            void run(++token);
        },
        pause() {
            if (!playing) return;
            playing = false;
            token++;
            deps.silence();
            deps.onPass?.(null);
        },
        get playing() { return playing; },
    };
};
