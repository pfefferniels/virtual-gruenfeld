import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The OpenAI client is constructed when `../config` is first evaluated, so the
// key has to exist before these modules load. No request is ever made here.
process.env.OPENAI_API_KEY ||= 'smoke-test-placeholder';

const { buildUserInput, parseTeacherStreamBody, runTeacherStream } = await import('./teacherStream');
const { buildTeacherSystemPrompt } = await import('../prompts/teacherStream');
const { sanitizeJudgementText } = await import('../prompts/judgement');
const { __resetSessionStore, flushProfileUpdates, readSession } = await import('../sessions');
const { openai } = await import('../config');

const JUDGEMENT = { score: 61, verdict: 'mixed', eventCount: 10 };
const EVENTS = [
    { id: 'tempo_m2.2_0', position: 'm2.2', type: 'tempo', severity: 'large', primaryAttr: 'bpm', refValue: 43, studentValue: 172, direction: 'less' },
    { id: 'dynamics_m1.4_1', position: 'm1.4', type: 'dynamics', severity: 'large', primaryAttr: 'volume', refValue: 35, studentValue: 70, direction: 'less' },
];
const CANDIDATES = [{ position: 'm2.2', issues: [{ type: 'tempo', direction: 'less' }] }];
const RANGE = { from: 720, to: 13680 };

const SESSION = 'b34f50c6-490c-4999-860e-52fd563d150c';

describe('request body', () => {
    it('rejects the empty probe body', () => {
        expect(parseTeacherStreamBody({})).toBeNull();
        expect(parseTeacherStreamBody(undefined)).toBeNull();
    });

    it('carries a valid session id and drops an unusable one', () => {
        const withSession = parseTeacherStreamBody({ judgement: JUDGEMENT, diff: 'x', sessionId: SESSION });
        expect(withSession?.sessionId).toBe(SESSION);
        expect(parseTeacherStreamBody({ judgement: JUDGEMENT, diff: 'x', sessionId: '../escape' })?.sessionId)
            .toBeUndefined();
        expect(parseTeacherStreamBody({ judgement: JUDGEMENT, diff: 'x' })?.sessionId).toBeUndefined();
    });

    it('accepts the legacy shape with only a diff string', () => {
        const parsed = parseTeacherStreamBody({ judgement: JUDGEMENT, diff: 'table', mode: 'studio' });
        expect(parsed).toMatchObject({ diff: 'table', mode: 'studio' });
        expect(parsed?.structuredDiff).toBeUndefined();
        expect(parsed?.range).toBeUndefined();
    });

    it('accepts the grounded shape without a diff string', () => {
        const parsed = parseTeacherStreamBody({ judgement: JUDGEMENT, structuredDiff: EVENTS, range: RANGE });
        expect(parsed?.structuredDiff).toHaveLength(2);
        expect(parsed?.range).toEqual(RANGE);
    });

    it('defaults an unknown mode to balanced', () => {
        expect(parseTeacherStreamBody({ judgement: JUDGEMENT, diff: 'x', mode: 'turbo' })?.mode).toBe('balanced');
    });

    it('ignores a malformed range instead of failing the request', () => {
        const parsed = parseTeacherStreamBody({ judgement: JUDGEMENT, diff: 'x', range: { from: 900, to: 100 } });
        expect(parsed?.range).toBeUndefined();
    });
});

describe('user input assembly', () => {
    const grounded = () => buildUserInput(
        { judgement: JUDGEMENT, candidates: CANDIDATES, structuredDiff: EVENTS, range: RANGE, mode: 'balanced' },
        true,
    );

    it('leads with the scholarly record so the take stays closest to the answer', () => {
        const input = grounded();
        expect(input.indexOf('=== SCHOLARLY RECORD FOR m1.2–m5.4 ===')).toBe(0);
        expect(input.indexOf('SCHOLARLY RECORD')).toBeLessThan(input.indexOf('JUDGEMENT SUMMARY'));
        expect(input.indexOf('JUDGEMENT SUMMARY')).toBeLessThan(input.indexOf('=== DIFF'));
        expect(input.indexOf('=== DIFF')).toBeLessThan(input.indexOf('CUE CANDIDATES'));
    });

    it('sends every structured event, not a summary', () => {
        const input = grounded();
        expect(input).toContain('=== DIFF (2 measured deviations) ===');
        for (const event of EVENTS) expect(input).toContain(JSON.stringify(event));
    });

    it('falls back to the ASCII table when no structured diff is sent', () => {
        const input = buildUserInput(
            { judgement: JUDGEMENT, candidates: [], diff: '10 deviations in m1.2–m5.4:', mode: 'balanced' },
            true,
        );
        expect(input).toContain('10 deviations in m1.2–m5.4:');
        expect(input).not.toContain('measured deviations');
        expect(input).not.toContain('SCHOLARLY RECORD');
    });

    it('omits the scholarly record when the tier or the request has no range', () => {
        const withoutRange = buildUserInput(
            { judgement: JUDGEMENT, candidates: [], structuredDiff: EVENTS, mode: 'realtime' },
            true,
        );
        const suppressed = buildUserInput(
            { judgement: JUDGEMENT, candidates: [], structuredDiff: EVENTS, range: RANGE, mode: 'realtime' },
            false,
        );
        expect(withoutRange).not.toContain('SCHOLARLY RECORD');
        expect(suppressed).not.toContain('SCHOLARLY RECORD');
    });

    it('is deterministic for identical takes', () => {
        expect(grounded()).toBe(grounded());
    });

    it('puts the session history last, after the candidates', () => {
        const input = buildUserInput(
            { judgement: JUDGEMENT, candidates: CANDIDATES, structuredDiff: EVENTS, range: RANGE, mode: 'balanced' },
            true,
            '=== PREVIOUS TAKES ===\n[take 1] | m1.2–m5.4',
        );
        expect(input.indexOf('CUE CANDIDATES')).toBeLessThan(input.indexOf('PREVIOUS TAKES'));
        expect(input.endsWith('=== PREVIOUS TAKES ===\n[take 1] | m1.2–m5.4')).toBe(true);
    });

    it('is byte-identical to the stateless input when there is no history', () => {
        expect(buildUserInput(
            { judgement: JUDGEMENT, candidates: CANDIDATES, structuredDiff: EVENTS, range: RANGE, mode: 'balanced' },
            true,
            '',
        )).toBe(grounded());
    });
});

describe('system prompt', () => {
    it('is byte-stable across calls', () => {
        expect(buildTeacherSystemPrompt()).toBe(buildTeacherSystemPrompt());
    });

    it('carries persona, voice, primer, corpus and output contract in that order', () => {
        const prompt = buildTeacherSystemPrompt();
        expect(prompt.indexOf('You are Alfred Grünfeld')).toBe(0);
        expect(prompt.indexOf('VOICE — your own way of speaking')).toBeLessThan(prompt.indexOf('MPM CONCEPTS'));
        expect(prompt.indexOf('MPM CONCEPTS')).toBeLessThan(prompt.indexOf('SCHOLARLY CORPUS'));
        expect(prompt.indexOf('SCHOLARLY CORPUS')).toBeLessThan(prompt.indexOf('OUTPUT FORMAT'));
    });

    it('speaks as Grünfeld himself, in his documented manner, dosed', () => {
        const prompt = buildTeacherSystemPrompt();
        expect(prompt.indexOf('VOICE — your own way of speaking')).toBeGreaterThan(0);
        expect(prompt).toContain('your own playing: „so spiel ich das"');
        expect(prompt).toContain('Der Rhythmus ist die Seele der Musik');
        expect(prompt).toContain('kleine Dosen');
        expect(prompt).toContain('Every word limit and format rule below outranks the voice.');
    });

    it('retires the DIFF GLOSSARY in favour of the primer', () => {
        const prompt = buildTeacherSystemPrompt();
        expect(prompt).not.toContain('DIFF GLOSSARY');
        expect(prompt).toContain('ARPEGGIATION');
    });

    it('keeps every rule the client choreography depends on', () => {
        const prompt = buildTeacherSystemPrompt();
        for (const rule of [
            '«JUDGE»',
            '3-8 word',
            'Each cue is 1-4 words, maximum 5.',
            'Do NOT add any closing remark',
            'Only use positions from the given candidates',
            'MUST NOT reverse the direction',
            '[softly]',
            'Write everything in German',
        ]) {
            expect(prompt).toContain(rule);
        }
    });

    it('explains the two judgement numbers where the payload carries them', () => {
        const prompt = buildTeacherSystemPrompt();
        // Every field name the JUDGEMENT SUMMARY can carry has to be named here or the model is
        // reading JSON keys it was never told about (inventory §2.3's risk).
        expect(prompt).toContain('distanceJnd');
        expect(prompt).toContain('subThresholdFraction');
        expect(prompt).toContain('Never say either number out loud');
        // Appended after the existing contract, so everything above it stays cacheable.
        expect(prompt.indexOf('distanceJnd')).toBeGreaterThan(prompt.indexOf('«MARKER» delimiters'));
    });

    it('tells the teacher to ground its choices without reciting the corpus', () => {
        const prompt = buildTeacherSystemPrompt();
        expect(prompt).toContain('Brevity always wins');
        expect(prompt).toContain('Never cite the corpus out loud');
    });

    it('trims the corpus for the realtime tier only', () => {
        expect(buildTeacherSystemPrompt({ compactCorpus: true }).length)
            .toBeLessThan(buildTeacherSystemPrompt().length);
    });

    it('says nothing about memory unless the request has a session', () => {
        const stateless = buildTeacherSystemPrompt({ compactCorpus: false });
        expect(stateless).toBe(buildTeacherSystemPrompt({ compactCorpus: false, memory: false }));
        expect(stateless).not.toContain('CONTINUITY');
    });

    it('appends the memory rules as a suffix, so the cacheable prefix survives', () => {
        const withMemory = buildTeacherSystemPrompt({ compactCorpus: false, memory: true });
        expect(withMemory.startsWith(buildTeacherSystemPrompt({ compactCorpus: false }))).toBe(true);
        expect(withMemory).toContain('PREVIOUS TAKES');
        expect(withMemory).toContain('never imply a shared past');
        expect(withMemory).toContain('«JUDGE» stays 3-8 words');
    });

    it('is byte-stable per variant', () => {
        expect(buildTeacherSystemPrompt({ memory: true })).toBe(buildTeacherSystemPrompt({ memory: true }));
        expect(buildTeacherSystemPrompt({ compactCorpus: true, memory: true }))
            .toBe(buildTeacherSystemPrompt({ compactCorpus: true, memory: true }));
    });
});

describe('a session across two takes', () => {
    const MONOLOGUE = '«JUDGE» Zu hastig, aber warm «m2.2» [softly] ruhiger atmen';
    const PROFILE = JSON.stringify({
        tendencies: ['eilt am Phrasenende'],
        improvements: [],
        addressed: ['Puls'],
        note: 'Energisch, aber grob in der Dynamik.',
    });

    let dir = '';
    let create: ReturnType<typeof vi.spyOn>;

    const take = (overrides: Record<string, unknown> = {}) => runTeacherStream({
        judgement: JUDGEMENT,
        candidates: CANDIDATES,
        structuredDiff: EVENTS,
        range: RANGE,
        mode: 'realtime',
        skipTts: true,
        ...overrides,
    } as Parameters<typeof runTeacherStream>[0]);

    /** The prompt bytes of the nth call the route made to the model. */
    const callArgs = (n: number) => create.mock.calls[n][0] as { instructions: string; input: string };
    /** Only the monologue calls — the profile side-channel also uses this client. */
    const teacherCalls = () => create.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .filter((request) => !request.text);

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'vg-route-'));
        process.env.SESSIONS_DIR = dir;
        __resetSessionStore();
        create = vi.spyOn(openai.responses, 'create').mockImplementation((async (request: Record<string, unknown>) => ({
            output_text: request.text ? PROFILE : MONOLOGUE,
        })) as never);
    });

    afterEach(async () => {
        await flushProfileUpdates();
        rmSync(dir, { recursive: true, force: true });
        delete process.env.SESSIONS_DIR;
        __resetSessionStore();
        vi.restoreAllMocks();
    });

    it('shows the second take what the first one sounded like', async () => {
        await take({ sessionId: SESSION });
        await flushProfileUpdates();
        await take({ sessionId: SESSION });

        const second = teacherCalls()[1] as { instructions: string; input: string };
        expect(second.input).toContain('=== PREVIOUS TAKES ===');
        expect(second.input).toContain('The take you just heard is take 2.');
        expect(second.input).toContain('[take 1] | m1.2–m5.4 | 61 mixed');
        expect(second.input).toContain('you said: "Zu hastig, aber warm." -> m2.2 "[softly] ruhiger atmen"');
        expect(second.input).toContain('recurring: eilt am Phrasenende');
        expect(second.instructions).toContain('CONTINUITY');
    });

    it('gives the first take of a session no history to lean on', async () => {
        await take({ sessionId: SESSION });
        expect(callArgs(0).input).not.toContain('PREVIOUS TAKES');
        // The rules are there from the start so the model knows not to invent one.
        expect(callArgs(0).instructions).toContain('never imply a shared past');
    });

    it('stamps a take with what it could hear, and says so when reading it back (R7)', async () => {
        await take({ sessionId: SESSION, measuredTypes: ['tempo', 'dynamics'] });
        expect(readSession(SESSION)?.takes[0].measured).toEqual(['tempo', 'dynamics']);

        await flushProfileUpdates();
        await take({ sessionId: SESSION });
        expect((teacherCalls()[1] as { input: string }).input).toContain('measured tempo dynamics');
    });

    it('renders a take stored before the dimensions were measurable as exactly that', async () => {
        await take({ sessionId: SESSION });
        expect(readSession(SESSION)?.takes[0].measured).toBeUndefined();

        await flushProfileUpdates();
        await take({ sessionId: SESSION });
        // Silence about tempo in an old record means nothing was listening for it, not that the
        // student's tempo was fine — and the teacher is told which of the two it is reading.
        expect((teacherCalls()[1] as { input: string }).input).toContain('(earlier take, fewer dimensions measured)');
    });

    it('records the take and answers before the profile side-channel returns', async () => {
        let release = () => {};
        const held = new Promise<void>((resolve) => { release = resolve; });
        create.mockImplementation((async (request: Record<string, unknown>) => {
            if (!request.text) return { output_text: MONOLOGUE };
            await held;
            return { output_text: PROFILE };
        }) as never);

        const result = await take({ sessionId: SESSION });
        expect(result.cleanedText).toBe('Zu hastig, aber warm. [softly] ruhiger atmen');

        const stored = readSession(SESSION)!;
        expect(stored.takes).toHaveLength(1);
        expect(stored.takes[0].diffDigest).toMatchObject({ total: 2 });
        expect(stored.takes[0].teacherSaid.cues).toEqual([{ position: 'm2.2', text: '[softly] ruhiger atmen' }]);
        // The answer is out while the profile call is still in flight.
        expect(stored.profile).toBeNull();

        release();
        await flushProfileUpdates();
        expect(readSession(SESSION)?.profile?.note).toBe('Energisch, aber grob in der Dynamik.');
    });

    it('answers normally when the profile side-channel fails', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        create.mockImplementation((async (request: Record<string, unknown>) => {
            if (request.text) throw new Error('side-channel down');
            return { output_text: MONOLOGUE };
        }) as never);

        const result = await take({ sessionId: SESSION });
        await flushProfileUpdates();

        expect(result.anchors).toHaveLength(2);
        expect(readSession(SESSION)?.takes).toHaveLength(1);
        expect(readSession(SESSION)?.profile).toBeNull();
    });

    it('leaves a take without a session id byte-identical to the stateless one', async () => {
        await take();
        await take({ sessionId: SESSION });
        await flushProfileUpdates();
        await take();

        const [first, , third] = teacherCalls() as Array<{ instructions: string; input: string }>;
        expect(third.input).toBe(first.input);
        expect(third.instructions).toBe(first.instructions);
        expect(third.instructions).not.toContain('CONTINUITY');
        expect(third.input).not.toContain('PREVIOUS TAKES');
        // …and the stateless takes left no trace on the session.
        expect(readSession(SESSION)?.takes).toHaveLength(1);
    });
});

describe('the agentic turn', () => {
    const MONOLOGUE = '«JUDGE» Zu hastig, aber warm «m2.2» [softly] ruhiger atmen';

    let create: ReturnType<typeof vi.spyOn>;

    const answer = (payload: unknown) => {
        create = vi.spyOn(openai.responses, 'create').mockImplementation((async () => ({
            output_text: typeof payload === 'string' ? payload : JSON.stringify(payload),
        })) as never);
    };

    const take = (overrides: Record<string, unknown> = {}) => runTeacherStream({
        judgement: JUDGEMENT,
        candidates: CANDIDATES,
        structuredDiff: EVENTS,
        range: RANGE,
        mode: 'realtime',
        skipTts: true,
        ...overrides,
    } as Parameters<typeof runTeacherStream>[0]);

    const lastCall = () => create.mock.calls[create.mock.calls.length - 1][0] as {
        instructions: string;
        input: string;
        text?: { format: { type: string; name: string; strict: boolean } };
    };

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('asks for the strict lesson-plan schema only when the request is agentic', async () => {
        answer({ monologue: MONOLOGUE, demo: { mode: 'none', range: null, dimensions: null } });

        await take({ agentic: true });
        expect(lastCall().text?.format).toMatchObject({ type: 'json_schema', name: 'lesson_plan', strict: true });

        await take();
        expect(lastCall().text).toBeUndefined();
    });

    it('leaves the non-agentic prompt byte-identical and the response plan-free', async () => {
        answer(MONOLOGUE);
        const plain = await take();
        const plainInstructions = lastCall().instructions;

        answer({ monologue: MONOLOGUE, demo: { mode: 'exaggerated', range: null, dimensions: [] } });
        const agentic = await take({ agentic: true });
        const agenticInstructions = lastCall().instructions;

        expect(plainInstructions).not.toContain('DEMONSTRATION PLAN');
        expect(agenticInstructions.startsWith(plainInstructions)).toBe(true);
        expect(agenticInstructions).toContain('Teach ONE thing per take');
        expect('plan' in plain).toBe(false);
        expect(agentic.plan).toBeDefined();
    });

    it('teaches the fourth mode and its edit count, in the suffix and nowhere else', async () => {
        answer(MONOLOGUE);
        await take();
        const plain = lastCall().instructions;

        answer({ monologue: MONOLOGUE, demo: { mode: 'path', range: null, dimensions: null, edits: 3 } });
        await take({ agentic: true });
        const agentic = lastCall().instructions;

        expect(plain).not.toContain('demo.edits');
        expect(agentic).toContain('"path" — their OWN playing back to them');
        expect(agentic).toContain('demo.edits');
        expect(agentic.startsWith(plain)).toBe(true);
    });

    it('parses the monologue inside the JSON exactly as it parses free text', async () => {
        answer(MONOLOGUE);
        const freeText = await take();

        answer({ monologue: MONOLOGUE, demo: { mode: 'reference', range: null, dimensions: null } });
        const structured = await take({ agentic: true });

        expect(structured.rawText).toBe(freeText.rawText);
        expect(structured.cleanedText).toBe(freeText.cleanedText);
        expect(structured.anchors).toEqual(freeText.anchors);
    });

    it('validates the plan against the take range and the measured diff types', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        answer({
            monologue: MONOLOGUE,
            demo: {
                mode: 'exaggerated',
                range: { from: 'm3.1', to: 'm9.1' },
                dimensions: [
                    { type: 'tempo', strength: 5 },
                    { type: 'ornament', strength: 0.3 },
                ],
            },
        });

        const result = await take({ agentic: true });
        // m9.1 is past the take's m5.4; ornament was never measured in EVENTS.
        expect(result.plan).toEqual({
            mode: 'exaggerated',
            range: { from: 5760, to: RANGE.to },
            dimensions: [{ type: 'tempo', strength: 0.5 }],
            edits: null,
        });
    });

    it('lets a plan name a dimension the take measured but had nothing to say about', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        answer({
            monologue: MONOLOGUE,
            demo: { mode: 'exaggerated', range: null, dimensions: [{ type: 'rubato', strength: 0.2 }], edits: null },
        });

        // `rubato` produced no event in EVENTS, so the pre-S7 rule (the events' own types) would
        // have dropped it. `measuredTypes` is what the take could hear, which is the right gate.
        const result = await take({ agentic: true, measuredTypes: ['tempo', 'dynamics', 'rubato'] });
        expect(result.plan?.dimensions).toEqual([{ type: 'rubato', strength: 0.2 }]);
    });

    it('plans the corrected take, with its edit count and its own passage', async () => {
        answer({
            monologue: MONOLOGUE,
            demo: { mode: 'path', range: { from: 'm3.1', to: 'm5.1' }, dimensions: [{ type: 'tempo', strength: 0.2 }], edits: 2 },
        });

        const result = await take({ agentic: true, measuredTypes: ['tempo', 'dynamics', 'rubato'] });
        expect(result.plan).toEqual({
            mode: 'path',
            range: { from: 5760, to: 11520 },
            dimensions: [{ type: 'tempo', strength: 0.2 }],
            edits: 2,
        });
    });

    it('keeps the take when the model answers with something that is not a plan', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        answer(MONOLOGUE);

        const result = await take({ agentic: true });
        expect(result.cleanedText).toBe('Zu hastig, aber warm. [softly] ruhiger atmen');
        expect(result.plan).toEqual({ mode: 'exaggerated', range: null, dimensions: [], edits: null });
    });

    it('only turns agentic when the body says so literally', () => {
        expect(parseTeacherStreamBody({ judgement: JUDGEMENT, diff: 'x', agentic: true })?.agentic).toBe(true);
        for (const agentic of ['true', 1, undefined, false]) {
            expect(parseTeacherStreamBody({ judgement: JUDGEMENT, diff: 'x', agentic })?.agentic).toBeUndefined();
        }
    });
});

describe('judgement sanitizer', () => {
    it('leaves speakable text untouched', () => {
        expect(sanitizeJudgementText('Guter Ansatz, Timing noch wackelig.')).toBe('Guter Ansatz, Timing noch wackelig.');
    });

    it('strips numeric tokens instead of discarding the sentence', () => {
        expect(sanitizeJudgementText('In m2.3 klingt das noch hart')).toBe('In klingt das noch hart');
        expect(sanitizeJudgementText('Takt 3 war unruhig')).toBe('Takt war unruhig');
    });

    it('rejects text with nothing speakable left', () => {
        expect(sanitizeJudgementText('m2.3 m4.1')).toBe('');
        expect(sanitizeJudgementText('   ')).toBe('');
    });

    it('caps the judgement at ten words', () => {
        const long = 'eins zwei drei vier fuenf sechs sieben acht neun zehn elf zwoelf';
        expect(sanitizeJudgementText(long).split(' ')).toHaveLength(10);
    });
});
