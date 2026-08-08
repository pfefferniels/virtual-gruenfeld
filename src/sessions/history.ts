import type { QaRecord, SessionState, StudentProfile, TakeRecord } from './types';

/** How many earlier takes reach the prompt. Older ones stay on disk only. */
export const HISTORY_MAX_TAKES = 5;
/** The same for spoken exchanges — one line each, so they stay affordable. */
export const HISTORY_MAX_QA = 3;

export const HISTORY_HEADING = '=== PREVIOUS TAKES ===';
export const QA_HEADING = '=== EARLIER QUESTIONS ===';
export const PROFILE_HEADING = '=== STUDENT PROFILE ===';

const round = (value: number): string =>
    Number.isInteger(value) ? String(value) : value.toFixed(1);

const movement = (from: number | undefined, to: number | undefined): string =>
    from === undefined || to === undefined ? '' : ` ${round(from)}->${round(to)}`;

const takeLine = (take: TakeRecord, number: number): string => {
    const head = [`[take ${number}]`];
    if (take.rangeLabel) head.push(take.rangeLabel);

    const { score, verdict } = take.judgement;
    if (score !== undefined || verdict) head.push([score, verdict].filter(Boolean).join(' '));

    const { total, byType, largest } = take.diffDigest;
    const types = byType.map((entry) => `${entry.type}x${entry.count}`).join(' ');
    head.push(`${total} dev${types ? `: ${types}` : ''}`);
    if (largest.length > 0) {
        head.push(`worst ${largest
            .map((event) => `${event.position} ${event.type} ${event.severity}${movement(event.refValue, event.studentValue)}`)
            .join('; ')}`);
    }

    const lines = [head.join(' | ')];

    const { judge, cues } = take.teacherSaid;
    const said = [judge ? `"${judge}"` : '', cues.map((cue) => `${cue.position} "${cue.text}"`).join('; ')]
        .filter(Boolean)
        .join(' -> ');
    if (said) lines.push(`  you said: ${said}`);

    return lines.join('\n');
};

/** One exchange, one line: newlines collapsed, a long answer cut short. */
const oneLine = (text: string, max: number): string => {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

const qaLine = (entry: QaRecord): string =>
    `- asked "${oneLine(entry.question, 120)}" — you answered "${oneLine(entry.answer, 200)}"`;

const profileLines = (profile: StudentProfile): string[] => {
    const lines: string[] = [];
    const add = (label: string, values: string[]) => {
        if (values.length > 0) lines.push(`${label}: ${values.join('; ')}`);
    };
    add('recurring', profile.tendencies);
    add('improving', profile.improvements);
    add('already told them', profile.addressed);
    if (profile.note) lines.push(`in short: ${profile.note}`);
    return lines;
};

/**
 * The volatile tail of the model input: what this student has already played for
 * the teacher today. Empty for a first take, so the input stays byte-identical
 * to the stateless one until there is something real to remember.
 */
export const formatSessionHistory = (session: SessionState | null | undefined): string => {
    if (!session) return '';

    const sections: string[] = [];
    const takes = session.takes.slice(-HISTORY_MAX_TAKES);

    if (takes.length > 0) {
        const firstNumber = session.takes.length - takes.length + 1;
        sections.push([
            HISTORY_HEADING,
            `This student has already played ${session.takes.length === 1 ? 'once' : `${session.takes.length} times`} for you in this session. The take you just heard is take ${session.takes.length + 1}.`,
            ...takes.map((take, index) => takeLine(take, firstNumber + index)),
        ].join('\n'));
    }

    // Sessions stored before questions existed have no list at all.
    const qa = (session.qa ?? []).slice(-HISTORY_MAX_QA);
    if (qa.length > 0) {
        sections.push([
            QA_HEADING,
            'This student also asked you these questions today, and you answered them:',
            ...qa.map(qaLine),
        ].join('\n'));
    }

    if (session.profile) {
        const lines = profileLines(session.profile);
        if (lines.length > 0) sections.push([PROFILE_HEADING, ...lines].join('\n'));
    }

    return sections.join('\n\n');
};
