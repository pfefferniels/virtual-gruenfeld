import React, { useState, useRef, useEffect } from 'react';
import {
    Box,
    TextField,
    IconButton,
    CircularProgress,
    Snackbar
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import StopIcon from '@mui/icons-material/Stop';
import { ChatMessage } from '../types';
import { sendChatMessage } from '../utils/api';
import { Error } from '@mui/icons-material';

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
    currentReconstruction,
    isLoading,
    error,
    onMessagesChange,
    onLoadingChange,
    onErrorChange,
    onHighlightsChange,
    onReconstructionChange
}) => {
    const [inputText, setInputText] = useState('');
    const [currentAudio, setCurrentAudio] = useState<HTMLAudioElement | null>(null);
    const dcRef = useRef<RTCDataChannel>();

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
                                instructions: `
When the user says 'Stop', or 'warte', 'halt mal', 'wait' etc., call the "stopPlayback" tool.
Otherwise, summarize the user's request STRICTLY in the following format:

    'Stelle: "[Welche Stelle möchte der Nutzer hören?]",
    Modifikation: "[Möchte er, dass die Stelle irgendwie modifiziert wird?]",
    Verwendete Rekonstruktion: "[Welche Rekonstruktion soll verwendet werden?]",'
                                    
Do not add any additional information or replies, only and strictly follow the format.
If certain inormation are not given by the user, leave the field empty!`,
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

                    if (msg.type === 'input_audio_buffer.speech_started') {
                        console.log('damping audio')
                        dampAudio()
                    }
                    else if (msg.type === 'input_audio_buffer.speech_stopped') {
                        console.log('resuming audio')
                        resumeAudio()
                    }
                    else if (msg.type === 'response.output_text.done') {
                        console.log('playing:', msg.text)
                        handlePlay(msg.text)
                    }
                    else if (msg.type === "response.function_call.delta" && msg.delta?.name === "stopPlayback") {
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
    }, [dcRef])

    const handlePlay = async (message: string) => {
        //e.preventDefault();
        if (!inputText.trim() || isLoading) return;

        const userMessage: ChatMessage = {
            id: Date.now().toString(),
            text: message,
            isUser: true,
            timestamp: new Date()
        };

        const newMessages = [...messages, userMessage];
        onMessagesChange(newMessages);
        setInputText('');
        onLoadingChange(true);
        onErrorChange(null);

        try {
            const response = await sendChatMessage({
                message: inputText
            });

            if (response.stop) {
                stopAudio();
                return;
            }

            const botMessage: ChatMessage = {
                id: (Date.now() + 1).toString(),
                text: response.reply || '[no text]',
                isUser: false,
                timestamp: new Date(),
                audio: response.audio,
                highlight: response.highlight
            };

            onMessagesChange([...newMessages, botMessage]);

            // Update highlights if provided
            if (response.highlight) {
                onHighlightsChange(response.highlight);
            }

            // Update reconstruction display if changed
            if (response.reconstruction && response.reconstruction !== currentReconstruction) {
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
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
        }

        const audio = new Audio(url);
        audio.play().catch(console.error);
        setCurrentAudio(audio);
    };

    const dampAudio = () => {
        if (currentAudio) {
            currentAudio.volume = 0.2;
        }
    }

    const resumeAudio = () => {
        if (currentAudio) {
            currentAudio.volume = 1.0;
        }
    }

    const stopAudio = () => {
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
            setCurrentAudio(null);
        }
    };

    const handleSnackbarClose = (_event?: React.SyntheticEvent | Event, reason?: string) => {
        if (reason === 'clickaway') {
            return;
        }
    };

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
                {currentAudio && (
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
                    {isLoading ? <CircularProgress size={20} /> : <SendIcon />}
                </IconButton>
            </Box>

            {messages.length > 0 && (
                <Snackbar
                    open={true}
                    autoHideDuration={1000}
                    onClose={handleSnackbarClose}
                    message={messages[messages.length - 1].text}
                    anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
                />
            )}
        </>
    );
};

export default ChatInterface;