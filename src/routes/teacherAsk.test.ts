import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The OpenAI client is constructed when `../config` is first evaluated, so the
// key has to exist before these modules load. No request is ever made here.
process.env.OPENAI_API_KEY ||= 'smoke-test-placeholder';

const synthesizeCueAudio = vi.hoisted(() => vi.fn(async () => 'AUDIO'));
vi.mock('../tts/synthesize', () => ({ synthesizeCueAudio }));

const { buildAskInput, parseTeacherAskBody, runTeacherAsk } = await import('./teacherAsk');
const { runTeacherStream } = await import('./teacherStream');
const { buildTeacherSystemPrompt } = await import('../prompts/teacherStream');
const { audioExtension } = await import('../audio/transcribe');
const {
    __resetSessionStore, buildTakeRecord, flushProfileUpdates, readSession, recordTake,
} = await import('../sessions');
const { openai } = await import('../config');

const SESSION = 'b34f50c6-490c-4999-860e-52fd563d150c';
const QUESTION = 'Warum wird es in Takt vier langsamer?';
const ANSWER = 'Weil die Phrase dort zum Ziel hin nachgibt — Grünfeld lässt sie atmen, statt sie durchzuziehen.';
/** What the profile side-channel answers when a take drags it along. */
const PROFILE = JSON.stringify({ tendencies: [], improvements: [], addressed: [], note: 'Ruhig.' });

describe('request body', () => {
    it('rejects a body with neither a question nor a recording', () => {
        expect(parseTeacherAskBody({})).toBeNull();
        expect(parseTeacherAskBody(undefined)).toBeNull();
        expect(parseTeacherAskBody({ question: '   ' })).toBeNull();
        expect(parseTeacherAskBody({ audio: { mimeType: 'audio/webm' } })).toBeNull();
        expect(parseTeacherAskBody({ audio: { data: '' } })).toBeNull();
    });

    it('accepts a typed question', () => {
        expect(parseTeacherAskBody({ question: `  ${QUESTION}  ` })).toMatchObject({
            question: QUESTION,
            mode: 'balanced',
        });
    });

    it('accepts a recording and assumes webm when the recorder said nothing', () => {
        expect(parseTeacherAskBody({ audio: { data: 'AAAA' } })?.audio)
            .toEqual({ data: 'AAAA', mimeType: 'audio/webm' });
        expect(parseTeacherAskBody({ audio: { data: 'AAAA', mimeType: 'audio/mp4' } })?.audio?.mimeType)
            .toBe('audio/mp4');
    });

    it('answers the text when both arrive, so the harness never pays for transcription', () => {
        const parsed = parseTeacherAskBody({ question: QUESTION, audio: { data: 'AAAA' } })!;
        expect(parsed.question).toBe(QUESTION);
        expect(parsed.audio).toBeDefined();
    });

    it('caps an over-long question instead of refusing it', () => {
        expect(parseTeacherAskBody({ question: 'a'.repeat(5000) })?.question).toHaveLength(800);
    });

    it('carries a valid session id and drops an unusable one', () => {
        expect(parseTeacherAskBody({ question: QUESTION, sessionId: SESSION })?.sessionId).toBe(SESSION);
        expect(parseTeacherAskBody({ question: QUESTION, sessionId: '../escape' })?.sessionId).toBeUndefined();
    });

    it('defaults an unknown mode to balanced', () => {
        expect(parseTeacherAskBody({ question: QUESTION, mode: 'turbo' })?.mode).toBe('balanced');
        expect(parseTeacherAskBody({ question: QUESTION, mode: 'realtime' })?.mode).toBe('realtime');
    });
});

describe('input assembly', () => {
    it('puts the question last, after whatever is remembered', () => {
        const input = buildAskInput(QUESTION, '=== PREVIOUS TAKES ===\n[take 1] | m1.2–m5.4');
        expect(input.indexOf('PREVIOUS TAKES')).toBeLessThan(input.indexOf('STUDENT QUESTION'));
        expect(input.endsWith(`=== STUDENT QUESTION ===\n${QUESTION}`)).toBe(true);
    });

    it('is just the question when there is nothing to remember', () => {
        expect(buildAskInput(QUESTION)).toBe(`=== STUDENT QUESTION ===\n${QUESTION}`);
    });
});

describe('the question prompt', () => {
    it('is the take prompt plus a suffix, so both share one cached prefix', () => {
        const take = buildTeacherSystemPrompt({ compactCorpus: true });
        const ask = buildTeacherSystemPrompt({ compactCorpus: true, qa: true });
        expect(ask.startsWith(take)).toBe(true);
        expect(ask.length).toBeGreaterThan(take.length);
    });

    it('never leaks into a take prompt, in any of its variants', () => {
        for (const options of [
            {},
            { compactCorpus: true },
            { memory: true },
            { agentic: true },
            { compactCorpus: true, memory: true, agentic: true },
        ]) {
            expect(buildTeacherSystemPrompt(options)).not.toContain('ANSWERING A QUESTION');
        }
    });

    it('retires the marker contract and keeps the answer short and grounded', () => {
        const ask = buildTeacherSystemPrompt({ qa: true });
        expect(ask).toContain('The «MARKER» output format above does NOT apply');
        expect(ask).toContain('About 60 spoken words');
        expect(ask).toContain('Never invent a documented intention');
        expect(ask).toContain('Write the answer in German');
    });

    it('is byte-stable per variant', () => {
        expect(buildTeacherSystemPrompt({ qa: true })).toBe(buildTeacherSystemPrompt({ qa: true }));
        expect(buildTeacherSystemPrompt({ compactCorpus: true, qa: true }))
            .toBe(buildTeacherSystemPrompt({ compactCorpus: true, qa: true }));
        expect(buildTeacherSystemPrompt({ qa: true })).not.toBe(buildTeacherSystemPrompt());
    });
});

describe('audio containers', () => {
    it('names the file after what the recorder produced', () => {
        expect(audioExtension('audio/webm;codecs=opus')).toBe('webm');
        expect(audioExtension('audio/mp4')).toBe('mp4');
        expect(audioExtension('AUDIO/WAV')).toBe('wav');
        expect(audioExtension('audio/mpeg')).toBe('mp3');
    });

    it('falls back to webm rather than refusing an unknown container', () => {
        expect(audioExtension('audio/weird')).toBe('webm');
        expect(audioExtension('')).toBe('webm');
    });
});

describe('answering a question', () => {
    let dir = '';
    let create: ReturnType<typeof vi.spyOn>;
    let transcribe: ReturnType<typeof vi.spyOn>;

    const ask = (overrides: Record<string, unknown> = {}) => runTeacherAsk({
        question: QUESTION,
        mode: 'realtime',
        ...overrides,
    } as Parameters<typeof runTeacherAsk>[0]);

    type Call = { instructions: string; input: string; text?: unknown };

    /** The last teacher call — the student-profile side-channel shares this client. */
    const lastCall = (): Call => {
        const teacherCalls = create.mock.calls
            .map((call) => call[0] as Call)
            .filter((request) => !request.text);
        return teacherCalls[teacherCalls.length - 1];
    };

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'vg-ask-'));
        process.env.SESSIONS_DIR = dir;
        process.env.ELEVENLABS_API_KEY = 'test-key';
        __resetSessionStore();
        synthesizeCueAudio.mockClear();
        synthesizeCueAudio.mockImplementation(async () => 'AUDIO');
        create = vi.spyOn(openai.responses, 'create')
            .mockImplementation((async (request: Record<string, unknown>) => ({
                output_text: request.text ? PROFILE : ANSWER,
            })) as never);
        transcribe = vi.spyOn(openai.audio.transcriptions, 'create')
            .mockImplementation((async () => ({ text: `  ${QUESTION}  ` })) as never);
    });

    afterEach(async () => {
        await flushProfileUpdates();
        rmSync(dir, { recursive: true, force: true });
        delete process.env.SESSIONS_DIR;
        delete process.env.ELEVENLABS_API_KEY;
        __resetSessionStore();
        vi.restoreAllMocks();
    });

    it('answers a typed question without ever transcribing anything', async () => {
        const result = await ask();

        expect(transcribe).not.toHaveBeenCalled();
        expect(result.transcript).toBe(QUESTION);
        expect(result.answerText).toBe(ANSWER);
        expect(result.audioBase64).toBe('AUDIO');
        expect(result.stats.transcribeMs).toBe(0);
        expect(lastCall().instructions).toContain('ANSWERING A QUESTION');
        expect(lastCall().input).toContain(QUESTION);
        // Free prose, not a lesson plan.
        expect(lastCall().text).toBeUndefined();
    });

    it('transcribes a recording first and names the upload after its container', async () => {
        const result = await ask({ question: undefined, audio: { data: 'AAAA', mimeType: 'audio/webm;codecs=opus' } });

        const upload = (transcribe.mock.calls[0][0] as { file: { name: string }; model: string; language?: string });
        expect(upload.file.name).toBe('question.webm');
        expect(upload.model).toBe('gpt-transcribe');
        expect(upload.language).toBe('de');
        expect(result.transcript).toBe(QUESTION);
        expect(result.answerText).toBe(ANSWER);
    });

    it('says nothing at all when the recording held no words', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        transcribe.mockImplementation((async () => ({ text: '   ' })) as never);

        const result = await ask({ question: undefined, audio: { data: 'AAAA', mimeType: 'audio/webm' }, sessionId: SESSION });

        expect(result.transcript).toBe('');
        expect(result.answerText).toBe('');
        expect(create).not.toHaveBeenCalled();
        expect(synthesizeCueAudio).not.toHaveBeenCalled();
        expect(readSession(SESSION)).toBeNull();
    });

    it('still answers in text when the voice fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        synthesizeCueAudio.mockImplementation(async () => { throw new Error('elevenlabs down'); });

        const result = await ask({ sessionId: SESSION });

        expect(result.answerText).toBe(ANSWER);
        expect(result.audioBase64).toBe('');
        // …and the exchange is still part of the lesson.
        expect(readSession(SESSION)?.qa).toHaveLength(1);
    });

    it('does not reach for the voice at all without a key', async () => {
        delete process.env.ELEVENLABS_API_KEY;
        const result = await ask();

        expect(synthesizeCueAudio).not.toHaveBeenCalled();
        expect(result.audioBase64).toBe('');
        expect(result.answerText).toBe(ANSWER);
    });

    it('drops cue markers if the model falls back into the monologue format', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        create.mockImplementation((async () => ({ output_text: '«JUDGE» Weil die Phrase nachgibt «m4.1» ruhiger' })) as never);

        const result = await ask();
        expect(result.answerText).toBe('Weil die Phrase nachgibt ruhiger');
        expect(synthesizeCueAudio).toHaveBeenCalledWith('Weil die Phrase nachgibt ruhiger', 'test-key', expect.any(String), expect.any(String));
    });

    it('remembers the exchange, so the next question can build on it', async () => {
        await ask({ sessionId: SESSION });
        await ask({ sessionId: SESSION, question: 'Und im zweiten Teil?' });

        const second = lastCall();
        expect(second.input).toContain('=== EARLIER QUESTIONS ===');
        expect(second.input).toContain(`- asked "${QUESTION}" — you answered "${ANSWER}"`);
        expect(second.input.endsWith('=== STUDENT QUESTION ===\nUnd im zweiten Teil?')).toBe(true);
        expect(readSession(SESSION)?.qa).toHaveLength(2);
    });

    it('knows what the student just played', async () => {
        recordTake(SESSION, buildTakeRecord({
            judgement: { score: 61, verdict: 'mixed', topIssues: [] },
            structuredDiff: [{ position: 'm2.2', type: 'tempo', severity: 'large' }],
            range: { from: 720, to: 13680 },
            anchors: [{ marker: 'JUDGE', charOffset: 0, text: 'Zu hastig, aber warm.' }],
        }));

        await ask({ sessionId: SESSION });
        expect(lastCall().input).toContain('=== PREVIOUS TAKES ===');
        expect(lastCall().input).toContain('you said: "Zu hastig, aber warm."');
    });

    it('leaves a question without a session id out of every record', async () => {
        await ask();
        expect(lastCall().input).toBe(`=== STUDENT QUESTION ===\n${QUESTION}`);
        expect(readSession(SESSION)).toBeNull();
    });

    it('hands the exchange on to the next take', async () => {
        await ask({ sessionId: SESSION });

        await runTeacherStream({
            judgement: { score: 61, verdict: 'mixed' },
            candidates: [],
            structuredDiff: [{ position: 'm2.2', type: 'tempo', severity: 'large' }],
            range: { from: 720, to: 13680 },
            mode: 'realtime',
            sessionId: SESSION,
            skipTts: true,
        });

        const take = lastCall();
        expect(take.input).toContain('=== EARLIER QUESTIONS ===');
        expect(take.input).toContain(`- asked "${QUESTION}"`);
        // The take path's own rules are untouched by the question having happened.
        expect(take.instructions).toContain('CONTINUITY');
        expect(take.instructions).not.toContain('ANSWERING A QUESTION');
    });

    it('does not disturb the take path it shares a prompt prefix with', async () => {
        await ask();
        const askInstructions = lastCall().instructions;

        await runTeacherStream({
            judgement: { score: 61, verdict: 'mixed' },
            candidates: [],
            structuredDiff: [{ position: 'm2.2', type: 'tempo', severity: 'large' }],
            range: { from: 720, to: 13680 },
            mode: 'realtime',
            skipTts: true,
        });
        const takeInstructions = lastCall().instructions;

        expect(takeInstructions).not.toContain('ANSWERING A QUESTION');
        expect(askInstructions.startsWith(takeInstructions)).toBe(true);
    });
});
