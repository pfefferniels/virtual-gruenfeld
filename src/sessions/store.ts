import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { QaRecord, SessionState, StudentProfile, TakeRecord } from './types';

/** A session that has run this long is a different lesson; its file is deleted on load. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Hard cap on stored takes. Only the last few ever reach the prompt anyway. */
export const MAX_TAKES_PER_SESSION = 50;
/** The same for spoken questions — cheap to keep, but not without a bound. */
export const MAX_QA_PER_SESSION = 20;

/** Session ids become filenames, so they must be boring. A UUID passes. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,100}$/;

export const isValidSessionId = (value: unknown): value is string =>
    typeof value === 'string' && SESSION_ID_RE.test(value);

const sessionsDir = (): string => resolve(process.env.SESSIONS_DIR ?? 'data/sessions');

const sessionPath = (id: string): string => join(sessionsDir(), `${id}.json`);

const isoOr = (value: unknown, fallback: string): string =>
    typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback;

const normalizeQa = (raw: unknown, now: string): QaRecord | null => {
    if (typeof raw !== 'object' || raw === null) return null;
    const { question, answer, at } = raw as Record<string, unknown>;
    if (typeof question !== 'string' || typeof answer !== 'string') return null;
    return { kind: 'qa', at: isoOr(at, now), question, answer };
};

/**
 * Files on disk survive code changes, so nothing read back is trusted: anything
 * that does not fit the current shape is dropped rather than propagated. A file
 * written before a field existed simply arrives without it.
 */
const normalizeSession = (raw: unknown): SessionState | null => {
    if (typeof raw !== 'object' || raw === null) return null;
    const record = raw as Record<string, unknown>;
    if (!isValidSessionId(record.id)) return null;

    const now = new Date().toISOString();
    const takes = Array.isArray(record.takes)
        ? (record.takes.filter((take) => typeof take === 'object' && take !== null) as TakeRecord[])
        : [];

    const qa = (Array.isArray(record.qa) ? record.qa : [])
        .map((entry) => normalizeQa(entry, now))
        .filter((entry): entry is QaRecord => entry !== null);

    const profile = typeof record.profile === 'object' && record.profile !== null
        ? (record.profile as StudentProfile)
        : null;

    return {
        id: record.id,
        createdAt: isoOr(record.createdAt, now),
        updatedAt: isoOr(record.updatedAt, now),
        takes: takes.slice(-MAX_TAKES_PER_SESSION),
        qa: qa.slice(-MAX_QA_PER_SESSION),
        profile,
    };
};

let sessions: Map<string, SessionState> | null = null;

/**
 * Read every session file once per process, dropping the ones that have aged
 * out. Persistence exists so a server restart mid-lesson does not erase the
 * student; it is not a database, and a bad file is skipped, never fatal.
 */
const loaded = (): Map<string, SessionState> => {
    if (sessions) return sessions;
    const map = new Map<string, SessionState>();
    sessions = map;

    const dir = sessionsDir();
    if (!existsSync(dir)) return map;

    for (const file of readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        const path = join(dir, file);
        try {
            const state = normalizeSession(JSON.parse(readFileSync(path, 'utf8')));
            if (!state) {
                console.warn('sessions: skipping unreadable session file', { file });
                continue;
            }
            if (Date.now() - Date.parse(state.updatedAt) > SESSION_TTL_MS) {
                rmSync(path, { force: true });
                continue;
            }
            map.set(state.id, state);
        } catch (err) {
            console.warn('sessions: failed to load session file', { file, err: String(err) });
        }
    }

    return map;
};

const persist = (state: SessionState): void => {
    try {
        mkdirSync(sessionsDir(), { recursive: true });
        writeFileSync(sessionPath(state.id), JSON.stringify(state, null, 2));
    } catch (err) {
        // The in-memory session is still usable; only restart-survival is lost.
        console.warn('sessions: failed to persist session', { id: state.id, err: String(err) });
    }
};

/** The stored session, or null when this id has no history yet. */
export const readSession = (id: string): SessionState | null =>
    isValidSessionId(id) ? loaded().get(id) ?? null : null;

const ensureSession = (id: string): SessionState => {
    const map = loaded();
    const existing = map.get(id);
    if (existing) return existing;
    const now = new Date().toISOString();
    const created: SessionState = { id, createdAt: now, updatedAt: now, takes: [], qa: [], profile: null };
    map.set(id, created);
    return created;
};

/** Append a take and write the session through. Returns the take's 1-based number. */
export const recordTake = (id: string, take: TakeRecord): number => {
    if (!isValidSessionId(id)) return 0;
    const state = ensureSession(id);
    state.takes.push(take);
    if (state.takes.length > MAX_TAKES_PER_SESSION) {
        state.takes = state.takes.slice(-MAX_TAKES_PER_SESSION);
    }
    state.updatedAt = take.at;
    persist(state);
    return state.takes.length;
};

/** Append a spoken exchange. Returns how many this session now holds. */
export const recordQa = (id: string, entry: QaRecord): number => {
    if (!isValidSessionId(id)) return 0;
    const state = ensureSession(id);
    state.qa.push(entry);
    if (state.qa.length > MAX_QA_PER_SESSION) {
        state.qa = state.qa.slice(-MAX_QA_PER_SESSION);
    }
    state.updatedAt = entry.at;
    persist(state);
    return state.qa.length;
};

export const setStudentProfile = (id: string, profile: StudentProfile): void => {
    if (!isValidSessionId(id)) return;
    const state = ensureSession(id);
    state.profile = profile;
    state.updatedAt = profile.updatedAt;
    persist(state);
};

/** Test seam: forget the in-memory map so the next read comes off disk again. */
export const __resetSessionStore = (): void => {
    sessions = null;
};
