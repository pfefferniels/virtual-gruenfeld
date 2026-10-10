import { describe, expect, it, vi } from 'vitest';
import { createRoom, RESUME_AFTER_MS } from './room';

describe('who is at the piano', () => {
    it('starts with him practising', () => {
        expect(createRoom().mode).toBe('practising');
    });

    it('turns him into the teacher on the first note, and only the first', () => {
        const onChange = vi.fn();
        const room = createRoom({ onChange });
        expect(room.studentPlayed(1000)).toBe(true);
        expect(room.studentPlayed(1200)).toBe(false);
        expect(room.mode).toBe('teaching');
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('goes back to practising once the room has been quiet long enough', () => {
        const room = createRoom();
        room.studentPlayed(1000);
        expect(room.tick(1000 + RESUME_AFTER_MS - 1)).toBe(false);
        expect(room.tick(1000 + RESUME_AFTER_MS)).toBe(true);
        expect(room.mode).toBe('practising');
        expect(room.tick(1000 + 2 * RESUME_AFTER_MS)).toBe(false);
    });

    it('counts the quiet from the end of his own demonstration, not from the last note', () => {
        const room = createRoom({ resumeAfterMs: 10_000 });
        room.studentPlayed(0);
        room.teacherPlayed(2000, 6000);
        expect(room.tick(12_000)).toBe(false);
        expect(room.tick(18_000)).toBe(true);
    });

    it('keeps listening while the student keeps playing', () => {
        const room = createRoom({ resumeAfterMs: 10_000 });
        for (let t = 0; t <= 60_000; t += 5000) {
            room.studentPlayed(t);
            expect(room.tick(t + 4000)).toBe(false);
        }
        expect(room.mode).toBe('teaching');
    });

    it('lets a student who comes back in stop him again', () => {
        const room = createRoom({ resumeAfterMs: 10_000 });
        room.studentPlayed(0);
        room.tick(10_000);
        expect(room.studentPlayed(30_000)).toBe(true);
        expect(room.mode).toBe('teaching');
    });
});
