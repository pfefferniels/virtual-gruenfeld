import { useCallback, useMemo, useRef, useState } from 'react';

import type { CuePrepMode } from './prepMode';
import { decodeAudioBase64 } from './pipeline/chunker';
import { askTeacher } from './services/api';
import { getSessionId } from './session';
import {
    armAutoStop,
    blobToBase64,
    micErrorMessage,
    MIN_RECORDING_BYTES,
    recordingMimeType,
} from './voiceInput';

type TeacherAnswer = {
    /** The question as the server heard it. */
    transcript: string;
    answerText: string;
};

type Options = {
    mode: CuePrepMode;
    audioContext: AudioContext;
    playAudioBuffer: (audioBuffer: AudioBuffer, onStart?: () => void) => Promise<void>;
    log?: (msg: string) => void;
};

/**
 * Push-to-talk against `/teacher-ask`: hold to record, release to send, hear the
 * answer. Nothing touches the microphone until `start` is called, so mounting
 * this behind a feature flag costs a disabled page nothing.
 */
export const useVoiceQuestion = ({ mode, audioContext, playAudioBuffer, log }: Options) => {
    const [recording, setRecording] = useState(false);
    const [thinking, setThinking] = useState(false);
    const [speaking, setSpeaking] = useState(false);
    const [answer, setAnswer] = useState<TeacherAnswer | null>(null);
    const [message, setMessage] = useState('');

    const recorderRef = useRef<MediaRecorder | null>(null);
    /** True while the button is held — the release can beat the permission prompt. */
    const heldRef = useRef(false);
    /** Cancels the max-length cut-off, once a recording has armed one. */
    const autoStopRef = useRef<(() => void) | null>(null);

    const clearAutoStop = useCallback(() => {
        autoStopRef.current?.();
        autoStopRef.current = null;
    }, []);

    const supported = useMemo(
        () => recordingMimeType() !== null
            && typeof navigator !== 'undefined'
            && typeof navigator.mediaDevices?.getUserMedia === 'function',
        [],
    );

    const send = useCallback(async (blob: Blob) => {
        if (blob.size < MIN_RECORDING_BYTES) {
            setMessage('That was too short — hold the button while you speak.');
            return;
        }

        setMessage('');
        setThinking(true);
        let heard: TeacherAnswer | null = null;
        let audioBase64 = '';

        try {
            const response = await askTeacher({
                audio: { data: await blobToBase64(blob), mimeType: blob.type || 'audio/webm' },
                sessionId: getSessionId(),
                mode,
            });
            log?.(`ASK: transcribe ${response.stats.transcribeMs}ms, llm ${response.stats.llmMs}ms, tts ${response.stats.ttsMs}ms`);
            if (response.answerText) {
                heard = { transcript: response.transcript, answerText: response.answerText };
                audioBase64 = response.audioBase64;
            } else {
                setMessage('Nothing was understood — try again.');
            }
        } catch (err) {
            setMessage(`Could not reach the teacher: ${String(err)}`);
        } finally {
            setThinking(false);
        }

        if (!heard) return;
        setAnswer(heard);

        // The text is already on screen; failing to speak it is not failing to answer.
        if (!audioBase64) return;
        try {
            setSpeaking(true);
            await playAudioBuffer(await decodeAudioBase64(audioBase64, audioContext));
        } catch (err) {
            log?.(`ASK: could not play the answer -> ${String(err)}`);
        } finally {
            setSpeaking(false);
        }
    }, [audioContext, log, mode, playAudioBuffer]);

    const start = useCallback(async () => {
        if (recorderRef.current) return;
        heldRef.current = true;

        const mimeType = recordingMimeType();
        if (!mimeType || !supported) {
            setMessage('This browser cannot record audio.');
            return;
        }

        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            setMessage(micErrorMessage(err));
            return;
        }

        const release = () => { for (const track of stream.getTracks()) track.stop(); };

        // Released while the permission prompt was up: never start at all.
        if (!heldRef.current) {
            release();
            return;
        }

        const chunks: Blob[] = [];
        const recorder = new MediaRecorder(stream, { mimeType });
        recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
        recorder.onstop = () => {
            clearAutoStop();
            release();
            recorderRef.current = null;
            setRecording(false);
            void send(new Blob(chunks, { type: mimeType }));
        };

        recorderRef.current = recorder;
        recorder.start();
        setMessage('');
        setRecording(true);

        // The question so far is still sent — a cut-off question beats none.
        autoStopRef.current = armAutoStop(() => {
            if (recorder.state !== 'inactive') recorder.stop();
        });
    }, [clearAutoStop, send, supported]);

    const stop = useCallback(() => {
        heldRef.current = false;
        clearAutoStop();
        const recorder = recorderRef.current;
        if (recorder && recorder.state !== 'inactive') recorder.stop();
    }, [clearAutoStop]);

    return { supported, recording, thinking, speaking, answer, message, start, stop };
};
