/**
 * What Grünfeld is asked about a window of playing.
 *
 * Jev evaluates the map in parallel and each question sees only the state, never its siblings,
 * so asking five costs what asking one costs (measured: 366 ms against 361 ms) and no answer can
 * condition another. Conditioning happens in `decide.ts`, over the probabilities that come back.
 */
export const QUESTIONS = {
    interrupt: {
        type: 'noul',
        instructions:
            'Should Grünfeld break in now, take the keyboard, and play this passage himself? '
            + 'He does not make the same point twice in one lesson.',
        criteria: {
            true: 'Something departs audibly from his reading and is better heard than described.',
            false: 'The playing is within his idea, the departure is inaudible, or he has just made this point.',
        },
    },
    dimension: {
        type: 'choice',
        instructions: 'What is the demonstration about?',
        criteria: {
            tempo: 'The pace of the passage.',
            dynamics: 'Weight, and the balance between melody and inner voices.',
            none: 'Nothing here is worth demonstrating.',
        },
    },
    severity: {
        type: 'score',
        instructions: 'How far is this playing from Grünfeld’s idea of the passage?',
        criteria: [
            'Indistinguishable from his own reading.',
            'Within what he would let pass without comment.',
            'Audibly different, worth a remark but not a demonstration.',
            'Clearly against his reading; he would stop and play it.',
            'Contrary to the whole sense of the passage.',
        ],
    },
    exaggeration: {
        type: 'score',
        instructions:
            'How far should he push the demonstration away from the student, so the contrast is '
            + 'heard without becoming a caricature?',
        criteria: [
            'Play it straight, no exaggeration.',
            'Slightly beyond his own reading.',
            'Clearly beyond it, so the difference cannot be missed.',
            'As far as taste allows.',
        ],
    },
    mode: {
        type: 'choice',
        instructions: 'What kind of demonstration serves the point best?',
        criteria: {
            exaggerated: 'His own reading, pushed away from the student so the difference is audible by contrast.',
            path: 'The student’s own playing given back to them with the costliest departures corrected.',
            reference: 'His reading played straight, with nothing altered.',
            none: 'Play nothing.',
        },
    },
} as const;

/** Levels in the `exaggeration` question, for mapping its score onto a strength. */
export const EXAGGERATION_LEVELS = QUESTIONS.exaggeration.criteria.length;
