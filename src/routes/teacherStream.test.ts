import { describe, expect, it } from 'vitest';

// The OpenAI client is constructed when `../config` is first evaluated, so the
// key has to exist before these modules load. No request is ever made here.
process.env.OPENAI_API_KEY ||= 'smoke-test-placeholder';

const { buildUserInput, parseTeacherStreamBody } = await import('./teacherStream');
const { buildTeacherSystemPrompt } = await import('../prompts/teacherStream');
const { sanitizeJudgementText } = await import('../prompts/judgement');

const JUDGEMENT = { score: 61, verdict: 'mixed', eventCount: 10 };
const EVENTS = [
    { id: 'tempo_m2.2_0', position: 'm2.2', type: 'tempo', severity: 'large', primaryAttr: 'bpm', refValue: 43, studentValue: 172, direction: 'less' },
    { id: 'dynamics_m1.4_1', position: 'm1.4', type: 'dynamics', severity: 'large', primaryAttr: 'volume', refValue: 35, studentValue: 70, direction: 'less' },
];
const CANDIDATES = [{ position: 'm2.2', issues: [{ type: 'tempo', direction: 'less' }] }];
const RANGE = { from: 720, to: 13680 };

describe('request body', () => {
    it('rejects the empty probe body', () => {
        expect(parseTeacherStreamBody({})).toBeNull();
        expect(parseTeacherStreamBody(undefined)).toBeNull();
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
});

describe('system prompt', () => {
    it('is byte-stable across calls', () => {
        expect(buildTeacherSystemPrompt()).toBe(buildTeacherSystemPrompt());
    });

    it('carries persona, primer, corpus and output contract in that order', () => {
        const prompt = buildTeacherSystemPrompt();
        expect(prompt.indexOf('You are a piano teacher')).toBe(0);
        expect(prompt.indexOf('MPM CONCEPTS')).toBeLessThan(prompt.indexOf('SCHOLARLY CORPUS'));
        expect(prompt.indexOf('SCHOLARLY CORPUS')).toBeLessThan(prompt.indexOf('OUTPUT FORMAT'));
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

    it('tells the teacher to ground its choices without reciting the corpus', () => {
        const prompt = buildTeacherSystemPrompt();
        expect(prompt).toContain('Brevity always wins');
        expect(prompt).toContain('Never cite the corpus out loud');
    });

    it('trims the corpus for the realtime tier only', () => {
        expect(buildTeacherSystemPrompt({ compactCorpus: true }).length)
            .toBeLessThan(buildTeacherSystemPrompt().length);
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
