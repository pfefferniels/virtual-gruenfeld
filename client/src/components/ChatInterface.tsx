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
  const messagesEndRef = useRef<null | HTMLDivElement>(null);
  const [currentAudio, setCurrentAudio] = useState<HTMLAudioElement | null>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim() || isLoading) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      text: inputText,
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
        message: inputText,
        reconId: currentReconstruction,
        locale: 'de'
      });

      const botMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        text: response.reply,
        isUser: false,
        timestamp: new Date(),
        audio: response.audio,
        highlight: response.highlight
      };

      onMessagesChange([...newMessages, botMessage]);

      // Update highlights if provided
      if (response.highlight?.xmlIds) {
        onHighlightsChange(response.highlight.xmlIds);
      }

      // Update reconstruction context if changed
      if (response.context?.reconId && response.context.reconId !== currentReconstruction) {
        onReconstructionChange(response.context.reconId);
      }

      // Auto-play audio
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
      <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', gap: 1 }}>
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