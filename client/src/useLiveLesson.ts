/**
 * The live lesson, assembled for the browser.
 *
 * Everything the loop needs from the world, supplied: the student's playing from Web MIDI, the
 * scoring from the evidence worker, the decision from the teacher server, and the playing from the
 * Disklavier — or, when there is no instrument in the room, from the sampler.
 *
 * Until somebody plays, Grünfeld practises on his own (`practice/`). The first note the student
 * strikes stops him and starts the lesson; when the room has been quiet long enough he goes back
 * to his practice where he left it (`practice/room.ts`).
 *
 * `useTake` is the same shell for the take-based lesson. The difference is that this one never
 * waits for the playing to stop before it forms an opinion.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { read as readMidi, type MidiFile } from 'midifile-ts';
import { boot } from './pipeline/boot';
import { createLiveInput, listenTo, type LiveInput } from './liveInput';
import { createLiveLesson, type Window } from './pipeline/liveLesson';
import { createTracker } from './tracker';
import { createDisklavier, type Disklavier } from './disklavier/disklavier';
import { planDemonstration } from './disklavier/plan';
import { MIDI_IN_DELAY_MS } from './disklavier/demonstrate';
import { appendSustainTail } from './pianosound/midiSequence';
import { findDisklavierOutput, webMidiPort } from './disklavier/port';
import { implantLocal } from './matcher';
import { counterPerformance } from './mpm/counter';
import { deviationsFrom, requestDecision, type LivePlan } from './services/decide';
import { convert, perform } from './services/mpmRenderer';
import { interestOf } from './practice/planner';
import { createPracticeRenderer } from './practice/render';
import { createPractice, type Practice, type PracticeNow } from './practice/session';
import { createRoom, RESUME_AFTER_MS, type RoomMode } from './practice/room';
import { assertOk } from './services/api';
import { midiOfPlayed } from './smf';
import { tickToPos } from './shared/constants';
import { runEvidence } from './workers/evidenceClient';
import type { StudentNote } from './matcher';
import type { PipelineContext } from './pipeline/types';
import type { Evidence } from './mpm/evidence';

/** The loop must also run while nothing is being struck: that is when he may come in. */
const IDLE_TICK_MS = 250;

/** Long enough for a one-bar fragment at Grünfeld's tempo, with room either side. */
const DEMONSTRATION_MS = 6000;

const TEACHER_URL = (import.meta.env.VITE_TEACHER_URL as string | undefined) ?? 'http://localhost:3002';

/** Room for the scheduler's first slice on top of the instrument's own lead. */
const PRACTICE_LEAD_MS = MIDI_IN_DELAY_MS + 100;

/** Has no upstream counterpart, so it is served with the app (`LIVE.md` §0). */
const loadReductionMsm = async (): Promise<string> => {
    const response = await fetch(`${import.meta.env.BASE_URL}harmonic_reduction.mei`);
    await assertOk(response);
    return convert(await response.text());
};

/** What the counter-performance needs from the window that provoked it. */
type ScoredWindow = {
    readonly measuredTypes: readonly string[];
    readonly peaks: Evidence['peaks'];
};

type LiveStatus = {
    readonly started: boolean;
    /** Where the tracker thinks the student is. */
    readonly position: string;
    readonly teacherPlaying: boolean;
    /** Practising on his own, or teaching the student who came in. */
    readonly mode: RoomMode;
    /** The pass he is practising, while he is. */
    readonly practice: PracticeNow | null;
    readonly lines: readonly string[];
};

export const useLiveLesson = (
    inputId: string | null | undefined,
    outputId: string | null | undefined,
    sampler: { play: (midi: MidiFile) => void; stop: () => void },
) => {
    const [status, setStatus] = useState<LiveStatus>({
        started: false, position: '—', teacherPlaying: false, mode: 'practising', practice: null, lines: [],
    });

    /** The sampler comes from a hook whose identity changes; the effect must not restart on it. */
    const samplerRef = useRef(sampler);
    samplerRef.current = sampler;

    const log = useCallback((line: string) => {
        setStatus((previous) => ({ ...previous, lines: [...previous.lines.slice(-200), line] }));
    }, []);

    const { started } = status;

    useEffect(() => {
        if (!started) return;

        let disposed = false;
        let detach: (() => void) | null = null;
        let live: LiveInput | null = null;
        let piano: Disklavier | null = null;
        let practice: Practice | null = null;
        let idle: ReturnType<typeof setInterval> | null = null;
        let driving = false;

        const room = createRoom({
            onChange: (mode) => setStatus((previous) => ({ ...previous, mode })),
        });

        const demonstrate = (ctx: PipelineContext, plan: LivePlan, fragment: Window, evidence: ScoredWindow) => {
            const range = plan.range ?? fragment;
            // `peaks` is what the push is computed from — without them the counter-performance
            // comes back as the plain reference, which is a demonstration of nothing.
            const mpm = plan.mode === 'reference'
                ? ctx.referenceMpmText
                : counterPerformance({
                    referenceMpmText: ctx.referenceMpmText,
                    range,
                    dimensions: plan.dimensions,
                    peaks: evidence.peaks,
                    measured: evidence.measuredTypes,
                    log,
                });

            const midi = perform(ctx.mei, mpm, range);
            if (!midi) { log('DEMO: nothing rendered'); return; }

            log(`GRÜNFELD: ${plan.mode}, ${tickToPos(range.from)}–${tickToPos(range.to)}`);
            setStatus((previous) => ({ ...previous, teacherPlaying: true }));
            room.teacherPlayed(performance.now(), DEMONSTRATION_MS);

            if (piano) {
                piano.demonstrate(planDemonstration(midi), performance.now() + 250);
            } else {
                samplerRef.current.play(appendSustainTail(midi));
            }
            window.setTimeout(
                () => setStatus((previous) => ({ ...previous, teacherPlaying: false })),
                DEMONSTRATION_MS,
            );
        };

        const run = async () => {
            const ctx = await boot(log);
            if (disposed) return;

            const access = await navigator.requestMIDIAccess({ sysex: false });
            if (disposed) return;

            const output = findDisklavierOutput(access, outputId);
            piano = output ? createDisklavier({ port: webMidiPort(output) }) : null;
            log(piano ? `DISKLAVIER: ${output?.name}` : 'DISKLAVIER: none, the sampler answers instead');

            const reductionMsm = await loadReductionMsm();
            if (disposed) return;
            const practiceRenderer = createPracticeRenderer({
                scoreMsm: ctx.scoreMsm,
                referenceMpmText: ctx.referenceMpmText,
                reductionMsm,
            });
            practice = createPractice({
                interest: interestOf(ctx.referenceMpmText),
                render: (pass) => practiceRenderer.render(pass),
                // Through the same path as a demonstration, so on the Disklavier the echo guard
                // knows his practising for his own and the student's first note is the only one
                // that stops him.
                play: (midi, durationMs) => {
                    if (piano) {
                        const startAt = performance.now() + PRACTICE_LEAD_MS;
                        return piano.demonstrate(planDemonstration(midi), startAt).endsAtMs - performance.now();
                    }
                    samplerRef.current.play(midi);
                    return durationMs;
                },
                // Only what he struck: on the Disklavier the student's own keys stay as they are.
                silence: () => (piano ? piano.silence() : samplerRef.current.stop()),
                onPass: (now) => {
                    setStatus((previous) => ({ ...previous, practice: now }));
                    if (now) log(`PRACTICE: ${now.episode}/${now.episodes} ${now.bars}, ${now.title}, pass ${now.pass}/${now.passes} · ${now.character}`);
                },
                log,
            });
            if (room.mode === 'practising') practice.resume();

            /** The last window's evidence: the counter-performance is built from it, not from the plan. */
            let scored: ScoredWindow = { measuredTypes: [], peaks: [] };

            const lesson = createLiveLesson<LivePlan>({
                tracker: createTracker(ctx.scoreNotes),

                score: async (played, window) => {
                    try {
                        const asMidi: MidiFile = readMidi(midiOfPlayed(played.map((note) => ({
                            pitch: note.pitch,
                            onsetMs: note.onset * 1000,
                            durationMs: note.duration * 1000,
                            velocity: note.velocity,
                        }))));
                        const { notes } = implantLocal(ctx.scoreNotes, asMidi, (window.from + window.to) / 2);
                        const evidence = await runEvidence({
                            notes,
                            range: window,
                            scoreMsm: ctx.scoreMsm,
                            scoreNotes: ctx.scoreNotes,
                            referenceMpmText: ctx.referenceMpmText,
                        }, log);
                        scored = { measuredTypes: evidence.measuredTypes, peaks: evidence.peaks };
                        return { measuredTypes: evidence.measuredTypes, structuredDiff: evidence.structuredDiff };
                    } catch (error) {
                        log(`EVIDENCE: ${error instanceof Error ? error.message : String(error)}`);
                        return null;
                    }
                },

                deliberate: async (request) => {
                    try {
                        const answer = await requestDecision<LivePlan>(TEACHER_URL, {
                            range: request.window,
                            position: `${request.position.section} ${tickToPos(request.position.tick)}`,
                            barsMeasured: `${tickToPos(request.window.from)}–${tickToPos(request.window.to)}`,
                            handsOffKeys: request.handsOffKeys,
                            measuredTypes: request.measuredTypes,
                            alreadyCorrectedThisLesson: request.alreadyCorrectedThisLesson,
                            deviations: deviationsFrom(request.structuredDiff),
                        });
                        if (answer.verdict) {
                            log(`JEV: ${answer.verdict.dimension} p=${answer.verdict.interrupt.toFixed(2)} → ${answer.verdict.mode}`);
                        } else if (answer.skipped) {
                            log(`JEV: ${answer.skipped}`);
                        }
                        return { verdict: answer.verdict, plan: answer.plan };
                    } catch (error) {
                        log(`JEV: ${error instanceof Error ? error.message : String(error)}`);
                        return { verdict: null, plan: null };
                    }
                },

                play: (plan, fragment) => demonstrate(ctx, plan, fragment, scored),
            });

            const drive = async (played: readonly StudentNote[], atMs: number) => {
                if (driving || disposed || room.mode !== 'teaching') return;
                driving = true;
                try {
                    const heard = await lesson.heard(played, atMs);
                    const where = heard.position;
                    if (where) {
                        setStatus((previous) => ({
                            ...previous,
                            position: `${where.section} ${tickToPos(where.tick)} · ${where.confidence.toFixed(2)}`,
                        }));
                    }
                } finally {
                    driving = false;
                }
            };

            live = createLiveInput({
                accepts: piano ? (data, atMs) => piano!.accepts(data, atMs) : undefined,
                onStruck: (atMs) => {
                    if (!room.studentPlayed(atMs)) return;
                    // Somebody has come in. He stops mid-phrase, and the lesson starts from this
                    // note: whatever was played on an earlier visit is not part of it.
                    practice?.pause();
                    live?.clear();
                    lesson.newAttempt();
                    log('ROOM: the student is playing, Grünfeld stops practising and listens');
                },
                onHeard: (played, atMs) => { void drive(played, atMs); },
            });

            const input = inputId ? access.inputs.get(inputId) : [...access.inputs.values()][0];
            if (!input) { log('MIDI: no input to listen to'); return; }
            detach = listenTo(input, live);
            log(`MIDI: listening to ${input.name}`);

            idle = setInterval(() => {
                const now = performance.now();
                if (room.tick(now)) {
                    log(`ROOM: ${RESUME_AFTER_MS / 1000} s of quiet, Grünfeld goes back to practising`);
                    live?.clear();
                    lesson.newAttempt();
                    practice?.resume();
                    return;
                }
                if (live) void drive(live.played(now), now);
            }, IDLE_TICK_MS);
        };

        void run().catch((error) => log(`BOOT: ${error instanceof Error ? error.message : String(error)}`));

        return () => {
            disposed = true;
            if (idle) clearInterval(idle);
            practice?.pause();
            detach?.();
            live?.dispose();
            piano?.silence();
            samplerRef.current.stop();
        };
    }, [started, inputId, outputId, log]);

    return {
        ...status,
        start: () => setStatus((previous) => ({ ...previous, started: true })),
        clearLines: () => setStatus((previous) => ({ ...previous, lines: [] })),
    };
};
