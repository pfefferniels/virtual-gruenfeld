import React, { useState, useRef, useEffect } from 'react';
import {
    Box,
    TextField,
    IconButton,
    Snackbar
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import StopIcon from '@mui/icons-material/Stop';
import { ChatResponse, sendChatMessage } from '../utils/api';
import { Error, Mic } from '@mui/icons-material';
import LoadingOverlay from './LoadingOverlay';
import { Pulsing } from '../Pulse';

interface ChatInterfaceProps {
    onResponse: (reply: ChatResponse) => void;
    audioRef: React.MutableRefObject<HTMLAudioElement | null>;
}

const ChatInterface: React.FC<ChatInterfaceProps> = ({
    audioRef,
    onResponse
}) => {
    const [inputText, setInputText] = useState('');
    const [messageToServer, setMessageToServer] = useState<any>();
    const [conversationalReply, setConversationalReply] = useState<string>();
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);

    const dcRef = useRef<RTCDataChannel>();

    const handlePlay = async (message: string) => {
        if (!message.trim() || isLoading) return;

        if (conversationalReply) {
            setConversationalReply(undefined)
        }

        // Do not play while thinking
        audioRef.current?.pause();

        setInputText('');
        setIsLoading(true);
        setError(null);

        try {
            const response = await sendChatMessage({ message });
            onResponse(response)

            // Play audio if provided
            if (response.audio) {
                playAudio(response.audio.url);
            }

        } catch (error) {
            console.error('Chat error:', error);
        } finally {
            setIsLoading(false);
        }
    };

    const playAudio = (url: string) => {
        // Stop current audio if playing
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
        }

        const audio = new Audio(url);
        audio.play().catch(console.error);
        audioRef.current = audio;
    };

    const dampAudio = () => {
        if (audioRef.current) {
            audioRef.current.volume = 0.2;
        }
    }

    const resumeAudio = () => {
        if (audioRef.current) {
            audioRef.current.volume = 1.0;
        }
    }

    const stopAudio = () => {
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
            audioRef.current = null;
        }
    };

    useEffect(() => {
        const attachToMicrophone = async () => {
            try {
                const tokenResponse = await fetch("/token")
                const data = await tokenResponse.json()
                const EPHEMERAL_KEY = data.value

                const pc = new RTCPeerConnection();
                const dc = pc.createDataChannel("oai-events");

                // Get mic and add to rtc connection
                const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
                mic.getTracks().forEach(t => pc.addTrack(t, mic));

                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);

                const baseUrl = "https://api.openai.com/v1/realtime/calls";
                const model = "gpt-realtime";
                const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
                    method: "POST",
                    body: offer.sdp,
                    headers: {
                        Authorization: `Bearer ${EPHEMERAL_KEY}`,
                        "Content-Type": "application/sdp",
                    },
                });

                const answer: RTCSessionDescriptionInit = {
                    type: "answer",
                    sdp: await sdpResponse.text(),
                };
                await pc.setRemoteDescription(answer);

                // Immediately send a session.update over the data channel:
                dc.onopen = () => {
                    dc.send(JSON.stringify(
                        {
                            type: "session.update",
                            session: {
                                type: "realtime",
                                model: "gpt-realtime",
                                tracing: 'auto',
                                instructions: `When the user says 'Stop', or 'warte', 'halt mal', 'wait' etc., call the "stopPlayback" tool.
Otherwise, summarize the user's request STRICTLY in the following format:
    {"Stelle": "<Welche Stelle möchte der Nutzer hören?>",
      "Modifikation": "<Möchte er, dass die Stelle dynamisch, agogisch, artikulatorisch modifiziert wird?>",
      "Rekonstruktion": "<Welche Rekonstruktion soll verwendet werden?>"}
If certain inormation are not given by the user, leave the field empty! Do never answer anything
else then that JSON, except for when you are *very* sure that it is absolutely impossible to interpret the user's
request as the given JSON format.`,
                                output_modalities: ["text"],
                                tools: [
                                    {
                                        name: "stopPlayback",
                                        type: "function",
                                        description: "Stops any ongoing audio playback.",
                                        parameters: {
                                            type: "object",
                                            properties: {},
                                            required: [],
                                        },
                                    },
                                ],
                            },
                        }
                    ));
                };

                dc.onmessage = async (ev) => {
                    const msg = JSON.parse(ev.data);
                    // console.log('msg', msg)

                    if (msg.type === 'input_audio_buffer.speech_started') {
                        console.log('damping audio')
                        dampAudio()
                    }
                    else if (msg.type === 'input_audio_buffer.speech_stopped') {
                        console.log('resuming audio')
                        resumeAudio()
                    }
                    else if (msg.type === 'response.output_text.done') {
                        try {
                            setMessageToServer(JSON.parse(msg.text))
                            handlePlay(msg.text)
                        }
                        catch (e) {
                            setConversationalReply(msg.text)
                        }
                    }
                    else if (msg.type === "response.function_call.delta") {
                        console.log('response.function_call_arguments.delta', msg.delta.name, msg)
                        console.log('stop playback')
                        stopAudio()
                    }
                    else {
                        console.log("Unhandled message:", msg.type)
                    }
                };

                dcRef.current = dc;
            } catch (error) {
                console.log("Error setting up realtime session:", error)
            }
        }

        if (!dcRef.current) {
            attachToMicrophone()
        }
    }, [dcRef, handlePlay, stopAudio, dampAudio, resumeAudio, onResponse, setConversationalReply, setMessageToServer])

    const handleSnackbarClose = (_event?: React.SyntheticEvent | Event, reason?: string) => {
        if (reason === 'clickaway') {
            return;
        }
    };

    let messageToServerStr
    if (messageToServer) {
        try {
            messageToServerStr = Object
                .values(messageToServer)
                .filter(v => typeof v === 'string')
                .filter(v => v.length > 0)
                .join(' – ')
        }
        catch { }
    }

    return (
        <>
            <Box
                component="form"
                width="80%"
                style={{
                    marginLeft: 'auto',
                    marginRight: 'auto',
                }}
                onSubmit={(e) => {
                    e.preventDefault();
                    setMessageToServer(inputText)
                    handlePlay(inputText)
                }}
                sx={{ display: 'flex', gap: 1 }}
            >
                <TextField
                    fullWidth
                    variant="outlined"
                    placeholder="Sprechen Sie mit Alfred Grünfeld ..."
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    disabled={isLoading}
                    size="small"
                />

                <Pulsing>
                    <Mic />
                </Pulsing>


                {audioRef.current && (
                    <IconButton
                        onClick={stopAudio}
                        color="secondary"
                        size="small"
                    >
                        <StopIcon />
                    </IconButton>
                )}
                <IconButton
                    type="submit"
                    color="primary"
                    disabled={!inputText.trim() || isLoading}
                    size="small"
                >
                    {error && <Error />}
                    {<LoadingOverlay
                        open={isLoading}
                        text={messageToServerStr}
                    />}
                    {!isLoading && !error && (
                        <SendIcon />
                    )}
                </IconButton>
            </Box>

            <Snackbar
                open={conversationalReply !== undefined}
                autoHideDuration={1000}
                onClose={handleSnackbarClose}
                message={conversationalReply}
                anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
            />
        </>
    );
};

export default ChatInterface;