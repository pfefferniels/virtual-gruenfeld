import { DEMO_MODES, INSTRUCTION_TYPES, STRENGTH_MAX, STRENGTH_MIN } from './types';

/**
 * OpenAI structured-output schema for the agentic turn. Strict mode requires
 * every property to be listed in `required`, so the fields the model may leave
 * out are nullable instead of optional.
 *
 * The descriptions are load-bearing: they are the only place the model is told
 * what a range or a strength means at the point where it fills one in.
 */
export const LESSON_PLAN_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['monologue', 'demo'],
    properties: {
        monologue: {
            type: 'string',
            description:
                'The spoken monologue, in the «MARKER» format from the output contract: one «JUDGE» '
                + 'marker followed by 1-4 positional cue markers. Exactly the text you would otherwise '
                + 'have answered with — no JSON, no escaping beyond what the field needs.',
        },
        demo: {
            type: 'object',
            additionalProperties: false,
            required: ['mode', 'range', 'dimensions'],
            description: 'What the student hears after you speak.',
            properties: {
                mode: {
                    type: 'string',
                    enum: [...DEMO_MODES],
                    description:
                        'exaggerated = the reference pushed away from the student so the divergence '
                        + 'is audible by contrast; reference = the reference untouched; none = no '
                        + 'playback, you only speak.',
                },
                range: {
                    type: ['object', 'null'],
                    additionalProperties: false,
                    required: ['from', 'to'],
                    description:
                        'The smallest passage that carries the point, as measure.beat positions. '
                        + 'Must lie inside the take range. Null means the whole take.',
                    properties: {
                        from: { type: 'string', description: 'Start position, e.g. "m3.2".' },
                        to: { type: 'string', description: 'End position, e.g. "m5.1".' },
                    },
                },
                dimensions: {
                    type: ['array', 'null'],
                    description:
                        'Only the deviation types that serve the one thing you are teaching. Empty '
                        + 'or null shapes every dimension at the default strength. Ignored unless '
                        + 'mode is "exaggerated".',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['type', 'strength'],
                        properties: {
                            type: { type: 'string', enum: [...INSTRUCTION_TYPES] },
                            strength: {
                                type: 'number',
                                description:
                                    `How far to push, ${STRENGTH_MIN}–${STRENGTH_MAX}: 0.1 a subtle `
                                    + 'nudge, 0.2 clearly audible, 0.4 a strong caricature.',
                            },
                        },
                    },
                },
            },
        },
    },
} as const;

export const LESSON_PLAN_FORMAT = {
    format: {
        type: 'json_schema' as const,
        name: 'lesson_plan',
        strict: true,
        schema: LESSON_PLAN_SCHEMA as unknown as Record<string, unknown>,
    },
};
