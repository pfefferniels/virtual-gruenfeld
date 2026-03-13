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
    stats: {
        llmMs: number;
        ttsMs: number;
        totalMs: number;
    };
};
