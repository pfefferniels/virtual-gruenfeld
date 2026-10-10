/**
 * Who is at the piano.
 *
 * Nobody has come in: Grünfeld practises. Somebody plays a note: he stops at once, mid-phrase,
 * and becomes the teacher — the live lesson listens and he answers when he has something to show.
 * When the room has been quiet for {@link RESUME_AFTER_MS}, neither the student playing nor he
 * demonstrating, he goes back to his own practice where he left it.
 */

/**
 * Long enough to think between attempts, or to take in what he just played, without him turning
 * back to his own work; short enough that a student who has left is not waited for. Chosen, not
 * measured.
 */
export const RESUME_AFTER_MS = 20_000;

export type RoomMode = 'practising' | 'teaching';

type Room = {
    readonly mode: RoomMode;
    /** A note struck by the student. True when it is the one that brings them into the room. */
    studentPlayed(atMs: number): boolean;
    /** He takes the keyboard as the teacher, for this long. */
    teacherPlayed(atMs: number, durationMs: number): void;
    /** True when the quiet has lasted long enough that he went back to practising, on this call. */
    tick(nowMs: number): boolean;
};

export const createRoom = (
    { resumeAfterMs = RESUME_AFTER_MS, onChange }: { resumeAfterMs?: number; onChange?: (mode: RoomMode) => void } = {},
): Room => {
    let mode: RoomMode = 'practising';
    let busyUntil = Number.NEGATIVE_INFINITY;

    const become = (next: RoomMode) => {
        mode = next;
        onChange?.(next);
    };

    return {
        get mode() { return mode; },

        studentPlayed(atMs) {
            busyUntil = Math.max(busyUntil, atMs);
            if (mode === 'teaching') return false;
            become('teaching');
            return true;
        },

        teacherPlayed(atMs, durationMs) {
            busyUntil = Math.max(busyUntil, atMs + durationMs);
        },

        tick(nowMs) {
            if (mode !== 'teaching' || nowMs - busyUntil < resumeAfterMs) return false;
            become('practising');
            return true;
        },
    };
};
