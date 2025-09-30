import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Box, IconButton, Snackbar } from '@mui/material';
import { ChatResponse, sendChatMessage } from '../utils/api';
import { Error, Mic, Stop } from '@mui/icons-material';
import LoadingOverlay from './LoadingOverlay';
import { Pulsing } from '../Pulse';

interface ChatInterfaceProps {
  onResponse: (reply: ChatResponse) => void;
  audioRef: React.MutableRefObject<HTMLAudioElement | null>;
  noteIds: string[];
}

const ChatInterface = ({ audioRef, onResponse, noteIds }: ChatInterfaceProps) => {
  const [inputText, setInputText] = useState('');
  const [messageToServer, setMessageToServer] = useState<any>();
  const [conversationalReply, setConversationalReply] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const dcRef = useRef<RTCDataChannel>();

  // --- REF FIXES FOR STALE CLOSURES ---
  // Always keep the latest noteIds available to event handlers
  const noteIdsRef = useRef<string[]>(noteIds);
  useEffect(() => {
    noteIdsRef.current = noteIds;
  }, [noteIds]);

  // We'll store the latest handlePlay implementation in a ref so the RTC onmessage uses fresh state
  const handlePlayRef = useRef<(message: string) => void>();

  const playAudio = useCallback((url: string) => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    const audio = new Audio(url);
    audio.play().catch(console.error);
    audioRef.current = audio;
  }, [audioRef]);

  const dampAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.volume = 0.2;
    }
  }, [audioRef]);

  const resumeAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.volume = 1.0;
    }
  }, [audioRef]);

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
  }, [audioRef]);

  // Keep the latest version of the play handler in a ref
  useEffect(() => {
    handlePlayRef.current = async (message: string) => {
      const latestNoteIds = noteIdsRef.current;
      if (!message.trim() || isLoading) return;

      if (conversationalReply) {
        setConversationalReply(undefined);
      }

      // Do not play while thinking
      audioRef.current?.pause();

      setInputText('');
      setIsLoading(true);
      setError(null);

      try {
        const response = await sendChatMessage({ message, selection: latestNoteIds });
        onResponse(response);

        if (response.audio) {
          playAudio(response.audio.url);
        }

        if (response.reply) {
          setConversationalReply(response.reply);
        }
      } catch (e) {
        console.error('Chat error:', e);
        setError('Something went wrong.');
      } finally {
        setIsLoading(false);
      }
    };
  }, [audioRef, conversationalReply, isLoading, onResponse, playAudio]);

  // Attach to microphone and set up RTC only once; use refs inside handlers
  useEffect(() => {
    const attachToMicrophone = async () => {
      try {
        const tokenResponse = await fetch('/token');
        const data = await tokenResponse.json();
        const EPHEMERAL_KEY = data.value;

        const pc = new RTCPeerConnection();
        const dc = pc.createDataChannel('oai-events');

        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        mic.getTracks().forEach((t) => pc.addTrack(t, mic));

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const baseUrl = 'https://api.openai.com/v1/realtime/calls';
        const model = 'gpt-realtime';
        const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
          method: 'POST',
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${EPHEMERAL_KEY}`,
            'Content-Type': 'application/sdp',
          },
        });

        const answer: RTCSessionDescriptionInit = {
          type: 'answer',
          sdp: await sdpResponse.text(),
        };
        await pc.setRemoteDescription(answer);

        // Immediately send a session.update over the data channel:
        dc.onopen = () => {
          dc.send(
            JSON.stringify({
              type: 'session.update',
              session: {
                type: 'realtime',
                model: 'gpt-realtime',
                tracing: 'auto',
                instructions: `
When the user says 'stop', 'wait', 'hold on' etc., call the "stopPlayback" tool and reply "Stopping".
Otherwise, you must respond ONLY with valid JSON in the following format:
    {"selection": "<Which places in the music does the user want to hear? E.g. b. 1-4, first phrase, only left hand, etc.>",
     "aspect": "<Which aspect is the user interested in? E.g. exaggerated dynamics, phrasing, inegalité, melodic shaping, etc.>",
If you can guess at least one field, return JSON with empty string for the other.
If no field can be reasonably extracted, return "I do not understand".`,
                output_modalities: ['text'],
                tools: [
                  {
                    name: 'stopPlayback',
                    type: 'function',
                    description: 'Stops any ongoing audio playback.',
                    parameters: {
                      type: 'object',
                      properties: {},
                      required: [],
                    },
                  },
                ],
              },
            })
          );
        };

        dc.onmessage = async (ev) => {
          const msg = JSON.parse(ev.data);

          if (msg.type === 'input_audio_buffer.speech_started') {
            dampAudio();
          } else if (msg.type === 'input_audio_buffer.speech_stopped') {
            resumeAudio();
          } else if (msg.type === 'response.output_text.done') {
            try {
              setMessageToServer(JSON.parse(msg.text));
              handlePlayRef.current?.(msg.text);
            } catch (e) {
              setConversationalReply(msg.text);
            }
          } else if (msg.type === 'response.function_call.delta') {
            // stop playback function called by the model
            stopAudio();
          } else {
            console.log('Unhandled message:', msg.type);
          }
        };

        dcRef.current = dc;
      } catch (err) {
        console.log('Error setting up realtime session:', err);
      }
    };

    if (!dcRef.current) {
      attachToMicrophone();
    }
    // Intentionally NOT depending on noteIds or handlePlay here.
  }, [dampAudio, resumeAudio, stopAudio]);

  const handleSnackbarClose = (_event?: React.SyntheticEvent | Event, reason?: string) => {
    if (reason === 'clickaway') {
      return;
    }
  };

  let messageToServerStr: string | undefined;
  if (messageToServer) {
    try {
      messageToServerStr = Object.values(messageToServer)
        .filter((v) => typeof v === 'string')
        .filter((v) => v.length > 0)
        .join(' – ');
    } catch {}
  }

  return (
    <>
      <Box
        component="form"
        width="80%"
        style={{ marginLeft: 'auto', marginRight: 'auto' }}
        onSubmit={(e) => {
          e.preventDefault();
          setMessageToServer(inputText);
          handlePlayRef.current?.(inputText); // use ref to ensure latest noteIds
        }}
        sx={{ display: 'flex', gap: 1 }}
      >
        <Pulsing>
          <Mic />
        </Pulsing>

        {audioRef.current && (
          <IconButton onClick={stopAudio} color="secondary" size="small">
            <Stop />
          </IconButton>
        )}

        {error && <Error />}

        {
          <LoadingOverlay
            open={isLoading}
            text={messageToServerStr}
          />
        }
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
