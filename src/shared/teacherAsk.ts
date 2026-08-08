/** What `/teacher-ask` answers with. Mirrored client-side in `services/api.ts`. */
export type TeacherAskResponse = {
    /** What the student asked — echoed back so the UI can show what was heard. */
    transcript: string;
    /** The spoken answer as text. Empty when nothing was understood. */
    answerText: string;
    /** MP3, base64. Empty when TTS is unavailable or failed; the text still stands. */
    audioBase64: string;
    model: string;
    stats: {
        /** 0 when the question arrived as text. */
        transcribeMs: number;
        llmMs: number;
        ttsMs: number;
        totalMs: number;
    };
};
