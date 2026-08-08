import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `../config` constructs the OpenAI client on import; no request is made here.
process.env.OPENAI_API_KEY ||= 'smoke-test-placeholder';

const { buildDiffDigest, buildTakeRecord, buildTeacherSaid } = await import('./record');
const { formatSessionHistory, HISTORY_MAX_TAKES, HISTORY_HEADING, PROFILE_HEADING } = await import('./history');
const {
    __resetSessionStore, isValidSessionId, readSession, recordTake, setStudentProfile,
    MAX_TAKES_PER_SESSION, SESSION_TTL_MS,
} = await import('./store');
const { buildProfileInput, parseProfileResponse, updateStudentProfile } = await import('./profile');
const { openai } = await import('../config');

const SESSION = 'b34f50c6-490c-4999-860e-52fd563d150c';

const EVENTS = [
    { id: 'a', position: 'm2.2', type: 'tempo', severity: 'large', primaryAttr: 'bpm', magnitude: 129, refValue: 43, studentValue: 172, direction: 'less' },
    { id: 'b', position: 'm1.4', type: 'dynamics', severity: 'mod', primaryAttr: 'volume', magnitude: 35, refValue: 35, studentValue: 70, direction: 'less' },
    { id: 'c', position: 'm3.1', type: 'tempo', severity: 'slight', primaryAttr: 'bpm', magnitude: 4, refValue: 50, studentValue: 54, direction: 'less' },
    { id: 'd', position: 'm4.1', type: 'rubato', severity: 'large', primaryAttr: 'intensity', magnitude: 0.6, refValue: 1, studentValue: 1.6, direction: 'less' },
];

const JUDGEMENT = {
    score: 61,
    verdict: 'mixed',
    eventCount: 4,
    topIssues: [
        { type: 'tempo', severity: 'large', cueText: 'ruhiger', position: 'm2.2' },
        { type: 'rubato', severity: 'large', cueText: 'mehr atmen', position: 'm4.1' },
        { type: 'dynamics', severity: 'mod', cueText: 'leiser', position: 'm1.4' },
        { type: 'tempo', severity: 'slight', cueText: 'ruhiger', position: 'm3.1' },
    ],
};

const ANCHORS = [
    { marker: 'JUDGE', charOffset: 0, text: 'Sehr hastig, aber engagiert.' },
    { marker: 'm2.2', charOffset: 30, text: 'ruhiger... atmen' },
    { marker: 'm4.1', charOffset: 50, text: '[softly] zum c hin' },
];

const takeRecord = (overrides: Partial<Parameters<typeof buildTakeRecord>[0]> = {}) => buildTakeRecord({
    judgement: JUDGEMENT,
    structuredDiff: EVENTS,
    range: { from: 720, to: 13680 },
    anchors: ANCHORS,
    at: new Date('2026-08-08T10:00:00.000Z'),
    ...overrides,
});

let dir = '';

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vg-sessions-'));
    process.env.SESSIONS_DIR = dir;
    __resetSessionStore();
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SESSIONS_DIR;
    __resetSessionStore();
    vi.restoreAllMocks();
});

describe('take records', () => {
    it('counts deviations per type, biggest group first', () => {
        expect(buildDiffDigest(EVENTS).byType).toEqual([
            { type: 'tempo', count: 2 },
            { type: 'dynamics', count: 1 },
            { type: 'rubato', count: 1 },
        ]);
    });

    it('keeps only the three dominant deviations, severity before magnitude', () => {
        const { total, largest } = buildDiffDigest(EVENTS);
        expect(total).toBe(4);
        expect(largest.map((event) => event.position)).toEqual(['m2.2', 'm4.1', 'm1.4']);
        expect(largest[0]).toMatchObject({ severity: 'large', refValue: 43, studentValue: 172 });
    });

    it('survives an empty or missing diff', () => {
        expect(buildDiffDigest(undefined)).toEqual({ total: 0, byType: [], largest: [] });
        expect(buildDiffDigest([])).toEqual({ total: 0, byType: [], largest: [] });
    });

    it('splits the monologue into the reaction and its cues', () => {
        expect(buildTeacherSaid(ANCHORS)).toEqual({
            judge: 'Sehr hastig, aber engagiert.',
            cues: [
                { position: 'm2.2', text: 'ruhiger... atmen' },
                { position: 'm4.1', text: '[softly] zum c hin' },
            ],
        });
    });

    it('labels the range the way the teacher would name it', () => {
        expect(takeRecord().rangeLabel).toBe('m1.2–m5.4');
        expect(takeRecord({ range: undefined }).rangeLabel).toBeUndefined();
    });

    it('caps the judgement at its three worst issues', () => {
        expect(takeRecord().judgement.topIssues).toHaveLength(3);
    });
});

describe('session store', () => {
    it('accepts uuids and rejects ids that would escape the data dir', () => {
        expect(isValidSessionId(SESSION)).toBe(true);
        expect(isValidSessionId('../../etc/passwd')).toBe(false);
        expect(isValidSessionId('short')).toBe(false);
        expect(isValidSessionId(42)).toBe(false);
    });

    it('has no history before the first take', () => {
        expect(readSession(SESSION)).toBeNull();
    });

    it('round-trips takes through disk', () => {
        expect(recordTake(SESSION, takeRecord())).toBe(1);
        expect(recordTake(SESSION, takeRecord())).toBe(2);

        __resetSessionStore();
        const reloaded = readSession(SESSION);
        expect(reloaded?.takes).toHaveLength(2);
        expect(reloaded?.takes[0].teacherSaid.judge).toBe('Sehr hastig, aber engagiert.');
        expect(reloaded?.takes[0].diffDigest.total).toBe(4);
    });

    it('round-trips the student profile', () => {
        recordTake(SESSION, takeRecord());
        setStudentProfile(SESSION, {
            tendencies: ['eilt am Phrasenende'],
            improvements: [],
            addressed: ['Puls'],
            note: 'Energisch, aber undifferenziert.',
            updatedAt: '2026-08-08T10:01:00.000Z',
        });

        __resetSessionStore();
        expect(readSession(SESSION)?.profile?.tendencies).toEqual(['eilt am Phrasenende']);
    });

    it('keeps only the last MAX_TAKES_PER_SESSION takes', () => {
        for (let i = 0; i < MAX_TAKES_PER_SESSION + 7; i++) {
            recordTake(SESSION, takeRecord({ at: new Date(Date.UTC(2026, 7, 8, 10, i)) }));
        }
        const stored = readSession(SESSION)!;
        expect(stored.takes).toHaveLength(MAX_TAKES_PER_SESSION);
        expect(stored.takes[0].at).toBe(new Date(Date.UTC(2026, 7, 8, 10, 7)).toISOString());
    });

    it('prunes sessions that aged out, and deletes their files', () => {
        const stale = 'aaaaaaaa-0000-0000-0000-000000000000';
        writeFileSync(join(dir, `${stale}.json`), JSON.stringify({
            id: stale,
            createdAt: new Date(Date.now() - SESSION_TTL_MS * 2).toISOString(),
            updatedAt: new Date(Date.now() - SESSION_TTL_MS - 1000).toISOString(),
            takes: [takeRecord()],
            profile: null,
        }));
        recordTake(SESSION, takeRecord());

        __resetSessionStore();
        expect(readSession(stale)).toBeNull();
        expect(readSession(SESSION)?.takes).toHaveLength(1);
        expect(readdirSync(dir)).toEqual([`${SESSION}.json`]);
    });

    it('skips a corrupt file instead of failing the request', () => {
        writeFileSync(join(dir, 'broken.json'), '{ not json');
        writeFileSync(join(dir, 'shapeless.json'), JSON.stringify({ id: 42 }));
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        __resetSessionStore();
        expect(recordTake(SESSION, takeRecord())).toBe(1);
        expect(readSession(SESSION)?.takes).toHaveLength(1);
    });

    it('ignores an invalid session id rather than writing a file for it', () => {
        expect(recordTake('../escape', takeRecord())).toBe(0);
        expect(readdirSync(dir)).toEqual([]);
    });
});

describe('history formatter', () => {
    const sessionWith = (takes: number) => {
        for (let i = 0; i < takes; i++) {
            recordTake(SESSION, takeRecord({ at: new Date(Date.UTC(2026, 7, 8, 10, i)) }));
        }
        return readSession(SESSION);
    };

    it('is empty when there is nothing to remember', () => {
        expect(formatSessionHistory(null)).toBe('');
        expect(formatSessionHistory(undefined)).toBe('');
        expect(formatSessionHistory({
            id: SESSION, createdAt: '', updatedAt: '', takes: [], profile: null,
        })).toBe('');
    });

    it('renders one take as two lines: what was measured and what was said', () => {
        const text = formatSessionHistory(sessionWith(1));
        const lines = text.split('\n');
        expect(lines[0]).toBe(HISTORY_HEADING);
        expect(lines[1]).toContain('take 2');
        expect(lines[2]).toContain('[take 1] | m1.2–m5.4 | 61 mixed | 4 dev: tempox2 dynamicsx1 rubatox1');
        expect(lines[2]).toContain('worst m2.2 tempo large 43->172');
        expect(lines[3]).toBe('  you said: "Sehr hastig, aber engagiert." -> m2.2 "ruhiger... atmen"; m4.1 "[softly] zum c hin"');
        expect(lines).toHaveLength(4);
    });

    it(`shows at most the last ${HISTORY_MAX_TAKES} takes, still numbered absolutely`, () => {
        const text = formatSessionHistory(sessionWith(HISTORY_MAX_TAKES + 3));
        const shown = text.match(/\[take \d+\]/g) ?? [];
        expect(shown).toHaveLength(HISTORY_MAX_TAKES);
        expect(shown[0]).toBe('[take 4]');
        expect(text).toContain('The take you just heard is take 9.');
    });

    it('stays small enough to ride in a realtime prompt', () => {
        const text = formatSessionHistory(sessionWith(HISTORY_MAX_TAKES));
        // ~4 chars per token: a full history must not cost more than ~500 tokens.
        expect(text.length).toBeLessThan(2000);
    });

    it('appends the profile only once it has content', () => {
        sessionWith(1);
        expect(formatSessionHistory(readSession(SESSION))).not.toContain(PROFILE_HEADING);

        setStudentProfile(SESSION, {
            tendencies: ['eilt am Phrasenende'],
            improvements: ['Dynamikumfang'],
            addressed: ['Puls'],
            note: 'Energisch.',
            updatedAt: '2026-08-08T10:05:00.000Z',
        });
        const text = formatSessionHistory(readSession(SESSION));
        expect(text).toContain(`${PROFILE_HEADING}\nrecurring: eilt am Phrasenende`);
        expect(text).toContain('improving: Dynamikumfang');
        expect(text).toContain('already told them: Puls');
        expect(text).toContain('in short: Energisch.');
    });

    it('renders a profile-only session when its takes have aged out of the window', () => {
        recordTake(SESSION, takeRecord());
        setStudentProfile(SESSION, {
            tendencies: [], improvements: [], addressed: [], note: 'Ruhiger Spieler.',
            updatedAt: '2026-08-08T10:05:00.000Z',
        });
        const session = readSession(SESSION)!;
        expect(formatSessionHistory({ ...session, takes: [] })).toBe(`${PROFILE_HEADING}\nin short: Ruhiger Spieler.`);
    });
});

describe('student profile side-channel', () => {
    const VALID = {
        tendencies: ['eilt am Phrasenende', 'gleichförmig laut'],
        improvements: ['Dynamikumfang'],
        addressed: ['Puls', 'Arpeggio'],
        note: 'Energischer Spieler mit grobem Dynamikraster.',
    };

    it('accepts a well-formed profile', () => {
        const profile = parseProfileResponse(JSON.stringify(VALID), new Date('2026-08-08T10:05:00.000Z'));
        expect(profile).toMatchObject(VALID);
        expect(profile?.updatedAt).toBe('2026-08-08T10:05:00.000Z');
    });

    it('caps array lengths and item size', () => {
        const profile = parseProfileResponse({
            tendencies: ['a', 'b', 'c', 'd', 'e', 'f'],
            improvements: [],
            addressed: [],
            note: 'x'.repeat(500),
        })!;
        expect(profile.tendencies).toEqual(['a', 'b', 'c', 'd']);
        expect(profile.note).toHaveLength(200);
    });

    it('drops junk entries, duplicates and blank strings', () => {
        const profile = parseProfileResponse({
            tendencies: ['eilt', 'EILT', '  ', 7, null, 'schleppt'],
            improvements: 'not an array',
            addressed: [],
            note: '  zu   laut  ',
        })!;
        expect(profile.tendencies).toEqual(['eilt', 'schleppt']);
        expect(profile.improvements).toEqual([]);
        expect(profile.note).toBe('zu laut');
    });

    it('rejects unusable responses instead of storing an empty profile', () => {
        expect(parseProfileResponse('not json')).toBeNull();
        expect(parseProfileResponse(null)).toBeNull();
        expect(parseProfileResponse({ tendencies: [], improvements: [], addressed: [], note: '' })).toBeNull();
    });

    it('asks for a JSON profile and stores what comes back', async () => {
        recordTake(SESSION, takeRecord());
        const create = vi.spyOn(openai.responses, 'create').mockResolvedValue({
            output_text: JSON.stringify(VALID),
        } as never);

        const profile = await updateStudentProfile(SESSION);

        expect(profile?.tendencies).toEqual(VALID.tendencies);
        expect(readSession(SESSION)?.profile?.note).toBe(VALID.note);

        const request = create.mock.calls[0][0] as Record<string, any>;
        expect(request.text.format).toMatchObject({ type: 'json_schema', name: 'student_profile', strict: true });
        expect(request.text.format.schema.required).toEqual(['tendencies', 'improvements', 'addressed', 'note']);
        expect(request.input).toContain('[take 1]');
    });

    it('does not call the model for a session with no takes', async () => {
        const create = vi.spyOn(openai.responses, 'create');
        expect(await updateStudentProfile(SESSION)).toBeNull();
        expect(create).not.toHaveBeenCalled();
    });

    it('shows the model the notes it is revising', () => {
        recordTake(SESSION, takeRecord());
        expect(buildProfileInput(readSession(SESSION)!)).toContain('(none yet — this is the first update)');

        setStudentProfile(SESSION, { ...VALID, updatedAt: '2026-08-08T10:05:00.000Z' });
        const input = buildProfileInput(readSession(SESSION)!);
        expect(input).toContain('"tendencies":["eilt am Phrasenende","gleichförmig laut"]');
        // The take log must not echo the notes back as if they were evidence.
        expect(input.indexOf('NOTES SO FAR')).toBeLessThan(input.indexOf('TAKE LOG'));
        expect(input).not.toContain(PROFILE_HEADING);
    });

    it('writes nothing into the repo working tree', () => {
        recordTake(SESSION, takeRecord());
        expect(readFileSync(join(dir, `${SESSION}.json`), 'utf8')).toContain('"takes"');
    });
});
