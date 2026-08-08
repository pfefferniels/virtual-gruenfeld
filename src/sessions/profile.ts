import { openai, OUTPUT_LANGUAGE, PROFILE_MODEL } from '../config';
import { formatSessionHistory } from './history';
import { readSession, setStudentProfile } from './store';
import type { SessionState, StudentProfile } from './types';

/** Caps applied to whatever the model returns — the profile rides in every later prompt. */
const CAPS = { tendencies: 4, improvements: 3, addressed: 6 } as const;
const MAX_ITEM_CHARS = 120;
const MAX_NOTE_CHARS = 200;

const PROFILE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['tendencies', 'improvements', 'addressed', 'note'],
    properties: {
        tendencies: {
            type: 'array',
            description: `Up to ${CAPS.tendencies} recurring problems, each a short phrase.`,
            items: { type: 'string' },
        },
        improvements: {
            type: 'array',
            description: `Up to ${CAPS.improvements} things that have measurably got better.`,
            items: { type: 'string' },
        },
        addressed: {
            type: 'array',
            description: `Up to ${CAPS.addressed} points the teacher has already said out loud.`,
            items: { type: 'string' },
        },
        note: { type: 'string', description: 'One sentence describing this player.' },
    },
} as const;

const INSTRUCTIONS = `You maintain a piano teacher's private notes on one student across a lesson.
You are given the notes so far and a log of the student's takes: what was measured, and what the teacher said.
Return the UPDATED notes.

- Carry forward what still holds, drop what the takes contradict, add what is new.
- "tendencies" are problems seen in MORE THAN ONE take — not a one-off slip.
- "improvements" require evidence of a deviation shrinking or disappearing between takes.
- "addressed" is what the teacher already told them, so it is not repeated forever.
- Keep every entry a short phrase (a few words). Keep "note" to one sentence.
- Never invent anything the log does not show. Empty arrays are a valid answer.
- Write the notes in ${OUTPUT_LANGUAGE}.`;

const cleanItems = (value: unknown, cap: number): string[] => {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const items: string[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string') continue;
        const text = entry.replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_CHARS);
        if (!text || seen.has(text.toLowerCase())) continue;
        seen.add(text.toLowerCase());
        items.push(text);
        if (items.length >= cap) break;
    }
    return items;
};

/**
 * Turn whatever came back into a profile, or null when there is nothing usable.
 * Structured outputs make the shape likely, not certain, and a malformed profile
 * would poison every later prompt in the session.
 */
export const parseProfileResponse = (raw: unknown, at: Date = new Date()): StudentProfile | null => {
    let payload = raw;
    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch {
            return null;
        }
    }
    if (typeof payload !== 'object' || payload === null) return null;

    const record = payload as Record<string, unknown>;
    const profile: StudentProfile = {
        tendencies: cleanItems(record.tendencies, CAPS.tendencies),
        improvements: cleanItems(record.improvements, CAPS.improvements),
        addressed: cleanItems(record.addressed, CAPS.addressed),
        note: typeof record.note === 'string'
            ? record.note.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS)
            : '',
        updatedAt: at.toISOString(),
    };

    const empty = profile.tendencies.length === 0 && profile.improvements.length === 0
        && profile.addressed.length === 0 && !profile.note;
    return empty ? null : profile;
};

export const buildProfileInput = (session: SessionState): string => {
    const parts: string[] = [];
    parts.push('=== NOTES SO FAR ===');
    parts.push(session.profile
        ? JSON.stringify({
            tendencies: session.profile.tendencies,
            improvements: session.profile.improvements,
            addressed: session.profile.addressed,
            note: session.profile.note,
        })
        : '(none yet — this is the first update)');
    parts.push('');
    parts.push('=== TAKE LOG ===');
    parts.push(formatSessionHistory({ ...session, profile: null }) || '(no takes recorded)');
    return parts.join('\n');
};

/**
 * Refresh the student profile from the takes recorded so far. Runs after the
 * teacher has already answered, never in front of it.
 */
export const updateStudentProfile = async (sessionId: string): Promise<StudentProfile | null> => {
    const session = readSession(sessionId);
    if (!session || session.takes.length === 0) return null;

    const response = await openai.responses.create({
        model: PROFILE_MODEL,
        instructions: INSTRUCTIONS,
        input: buildProfileInput(session),
        text: {
            format: {
                type: 'json_schema',
                name: 'student_profile',
                strict: true,
                schema: PROFILE_SCHEMA as unknown as Record<string, unknown>,
            },
        },
    });

    const profile = parseProfileResponse(response.output_text ?? '');
    if (profile) setStudentProfile(sessionId, profile);
    return profile;
};

const pending = new Set<Promise<unknown>>();

/**
 * Fire the profile update without making anyone wait for it. A failure here
 * costs the session some memory quality and nothing else, so it is logged and
 * dropped rather than surfaced.
 */
export const scheduleProfileUpdate = (sessionId: string): void => {
    if (!process.env.OPENAI_API_KEY) return;

    const task = updateStudentProfile(sessionId)
        .then((profile) => {
            if (profile) {
                console.log('sessions: student profile updated', {
                    session: sessionId,
                    tendencies: profile.tendencies.length,
                    improvements: profile.improvements.length,
                });
            }
        })
        .catch((err) => {
            console.warn('sessions: student profile update failed', { session: sessionId, err: String(err) });
        })
        .finally(() => {
            pending.delete(task);
        });

    pending.add(task);
};

/** Test/smoke seam: wait for the fire-and-forget updates to settle. */
export const flushProfileUpdates = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
};
