/**
 * What the teacher remembers between takes. Everything here is derived from data
 * the route already has — nothing is stored that the model could not have seen.
 */

export type TakeJudgement = {
    score?: number;
    verdict?: string;
    topIssues: Array<{ type: string; severity: string; position: string }>;
};

export type DiffDigest = {
    /** Number of measured deviations in the take. */
    total: number;
    /** Deviation count per type, largest group first. */
    byType: Array<{ type: string; count: number }>;
    /** The three deviations that dominated the take. */
    largest: Array<{
        position: string;
        type: string;
        severity: string;
        refValue?: number;
        studentValue?: number;
    }>;
};

export type TeacherSaid = {
    /** The «JUDGE» reaction, without the marker. */
    judge: string;
    /** The positional cues, in the order they were spoken. */
    cues: Array<{ position: string; text: string }>;
};

export type TakeRecord = {
    at: string;
    range?: { from: number; to: number };
    /** `m1.2–m5.4` — the range as the teacher would name it. */
    rangeLabel?: string;
    judgement: TakeJudgement;
    diffDigest: DiffDigest;
    teacherSaid: TeacherSaid;
};

/** The slowly-moving picture of the player, refreshed by the side-channel call. */
export type StudentProfile = {
    /** Problems that keep coming back across takes. */
    tendencies: string[];
    /** What has measurably got better. */
    improvements: string[];
    /** What the teacher has already said out loud, so it is not repeated forever. */
    addressed: string[];
    /** One sentence describing the player. */
    note: string;
    updatedAt: string;
};

export type SessionState = {
    id: string;
    createdAt: string;
    updatedAt: string;
    takes: TakeRecord[];
    profile: StudentProfile | null;
};
