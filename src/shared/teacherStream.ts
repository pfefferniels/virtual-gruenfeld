import type { LessonPlan } from '../plan/types';

export type StreamAnchor = {
    marker: string;
    charOffset: number;
    text: string;
};

export type TeacherStreamAlignment = {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
};

export type TeacherStreamResponse = {
    rawText: string;
    anchors: StreamAnchor[];
    cleanedText: string;
    audioBase64: string;
    alignment: TeacherStreamAlignment;
    model: string;
    /**
     * The validated lesson plan. Present only for agentic requests — a request
     * without `agentic` gets exactly the payload it got before Phase 3.
     */
    plan?: LessonPlan;
    stats: {
        llmMs: number;
        ttsMs: number;
        totalMs: number;
    };
};
