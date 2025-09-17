import React, { useState, useRef, useEffect } from 'react';
import {
    Box,
    TextField,
    IconButton,
    Snackbar
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import StopIcon from '@mui/icons-material/Stop';
import { ChatMessage } from '../types';
import { sendChatMessage } from '../utils/api';
import { Error, Mic } from '@mui/icons-material';
import LoadingOverlay from './LoadingOverlay';
import { Pulsing } from '../Pulse';

interface ChatInterfaceProps {
    messages: ChatMessage[];
    currentReconstruction: string;
    isLoading: boolean;
    error: string | null;
    onMessagesChange: (messages: ChatMessage[]) => void;
    onLoadingChange: (loading: boolean) => void;
    onErrorChange: (error: string | null) => void;
    onHighlightsChange: (xmlIds: string[]) => void;
    onReconstructionChange: (reconId: string) => void;
}

const ChatInterface: React.FC<ChatInterfaceProps> = ({
    messages,
    isLoading,
    error,
    onMessagesChange,
    onLoadingChange,
    onErrorChange,
    onHighlightsChange,
    onReconstructionChange
}) => {
    const [inputText, setInputText] = useState('');
    const [conversationalReply, setConversationalReply] = useState<string>();

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const dcRef = useRef<RTCDataChannel>();

    const handlePlay = async (message: string) => {
        if (!message.trim() || isLoading) return;

        if (conversationalReply) {
            setConversationalReply(undefined)
        }

        const userMessage: ChatMessage = {
            id: Date.now().toString(),
            text: message,
            isUser: true,
            timestamp: new Date()
        };

        console.log('sending to server', userMessage)

        const newMessages = [...messages, userMessage];
        onMessagesChange(newMessages);

        console.log('new messages=', newMessages)

        setInputText('');
        onLoadingChange(true);
        onErrorChange(null);

        try {
            const response = await sendChatMessage({ message });

            const botMessage: ChatMessage = {
                id: (Date.now() + 1).toString(),
                text: response.reply || '[no text]',
                isUser: false,
                timestamp: new Date(),
                audio: response.audio,
                highlight: response.highlight
            };

            console.log('bot message', botMessage)

            onMessagesChange([...newMessages, botMessage]);

            // Update highlights if provided
            if (response.highlight) {
                onHighlightsChange(response.highlight);
            }

            // Update reconstruction display if changed
            console.log('changing to', response.reconstruction)
            if (response.reconstruction) {
                onReconstructionChange(response.reconstruction);
            }

            // Play audio if provided
            if (response.audio) {
                playAudio(response.audio.url);
            }

        } catch (error) {
            console.error('Chat error:', error);
        } finally {
            onLoadingChange(false);
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
                    console.log('msg', msg)

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
                            JSON.parse(msg.text)
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
    }, [dcRef, handlePlay, stopAudio, dampAudio, resumeAudio, onMessagesChange, onReconstructionChange, setConversationalReply])

    const handleSnackbarClose = (_event?: React.SyntheticEvent | Event, reason?: string) => {
        if (reason === 'clickaway') {
            return;
        }
    };

    let messageToServer = messages[messages.length - 1]?.text || ''
    try {
        const result = JSON.parse(messageToServer)
        messageToServer = Object
            .values(result)
            .filter(v => typeof v === 'string')
            .filter(v => v.length > 0)
            .join(' – ')
    }
    catch { }

    return (
        <>
            <Box
                component="form"
                onSubmit={(e) => {
                    e.preventDefault();
                    handlePlay(inputText)
                }}
                sx={{ display: 'flex', gap: 1 }}
            >
                <TextField
                    fullWidth
                    variant="outlined"
                    placeholder="Sprechen Sie mit Alfred Grünfeld..."
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
                        text={messageToServer}
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