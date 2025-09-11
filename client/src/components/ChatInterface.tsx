import React, { useState, useRef, useEffect } from 'react';
import {
  Box,
  TextField,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Paper,
  Typography,
  Alert,
  CircularProgress,
  FormControl,
  Select,
  MenuItem,
  InputLabel,
  Snackbar
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import StopIcon from '@mui/icons-material/Stop';
import { ChatMessage } from '../types';
import { sendChatMessage } from '../utils/api';

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
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState('');

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

      // Check if response contains audio - if not, it's an error message
      if (!response.audio) {
        // Show error message in Snackbar instead of adding to chat
        setSnackbarMessage(response.reply);
        setSnackbarOpen(true);
        return;
      }

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
      playAudio(response.audio.url);

    } catch (error) {
      console.error('Chat error:', error);
      setSnackbarMessage('Fehler beim Senden der Nachricht');
      setSnackbarOpen(true);
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
    setSnackbarOpen(false);
  };

  return (
    <>
      <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', p: 2 }}>
        {/* Reconstruction Selector */}
        <Box sx={{ mb: 2 }}>
          <FormControl size="small" sx={{ minWidth: 200 }}>
            <InputLabel>Fassung</InputLabel>
            <Select
              value={currentReconstruction}
              label="Fassung"
              onChange={(e) => onReconstructionChange(e.target.value)}
            >
              {reconstructions.map((recon) => (
                <MenuItem key={recon.id} value={recon.id}>
                  {recon.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>

        {/* Messages */}
        <Box sx={{ 
          flexGrow: 1, 
          overflow: 'auto', 
          mb: 2,
          backgroundColor: '#f5f5f5',
          borderRadius: 1,
          p: 1
        }}>
          <List>
            {messages.map((message) => (
              <ListItem key={message.id} sx={{ 
                justifyContent: message.isUser ? 'flex-end' : 'flex-start',
                mb: 1
              }}>
                <Paper
                  sx={{
                    p: 2,
                    maxWidth: '70%',
                    backgroundColor: message.isUser ? 'primary.main' : 'white',
                    color: message.isUser ? 'white' : 'black'
                  }}
                >
                  <ListItemText
                    primary={message.text}
                    secondary={
                      <Box>
                        <Typography variant="caption" sx={{ 
                          color: message.isUser ? 'rgba(255,255,255,0.7)' : 'text.secondary' 
                        }}>
                          {message.timestamp.toLocaleTimeString()}
                        </Typography>
                        {message.audio && (
                          <Box sx={{ mt: 1 }}>
                            <IconButton 
                              size="small" 
                              onClick={() => playAudio(message.audio!.url)}
                              sx={{ color: message.isUser ? 'white' : 'primary.main' }}
                            >
                              ▶️
                            </IconButton>
                            <Typography variant="caption" sx={{ ml: 1 }}>
                              Audio ({message.audio.durationSec}s)
                            </Typography>
                          </Box>
                        )}
                      </Box>
                    }
                  />
                </Paper>
              </ListItem>
            ))}
          </List>
          <div ref={messagesEndRef} />
        </Box>

        {/* Error Alert */}
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* Input */}
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
            {isLoading ? <CircularProgress size={20} /> : <SendIcon />}
          </IconButton>
        </Box>
      </Box>
      
      {/* Snackbar for error messages */}
      <Snackbar
        open={snackbarOpen}
        autoHideDuration={6000}
        onClose={handleSnackbarClose}
        message={snackbarMessage}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      />
    </>
  );
};

export default ChatInterface;