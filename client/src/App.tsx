import { useState } from 'react';
import { Container, Box, Typography, AppBar, Toolbar } from '@mui/material';
import ChatInterface from './components/ChatInterface';
import ScorePanel from './components/ScorePanel';
import { AppState } from './types';

const initialState: AppState = {
  messages: [],
  currentReconstruction: 'reconstruction',
  reconstructions: [],
  isLoading: false,
  error: null,
  scoreHighlights: []
};

function App() {
  const [state, setState] = useState<AppState>(initialState);

  // No need to load reconstructions for UI anymore - they are selected automatically

  const updateMessages = (messages: any[]) => {
    setState(prev => ({ ...prev, messages }));
  };

  const setLoading = (isLoading: boolean) => {
    setState(prev => ({ ...prev, isLoading }));
  };

  const setError = (error: string | null) => {
    setState(prev => ({ ...prev, error }));
  };

  const setHighlights = (xmlIds: string[]) => {
    setState(prev => ({ ...prev, scoreHighlights: xmlIds }));
  };

  const setCurrentReconstruction = (reconId: string) => {
    setState(prev => ({ ...prev, currentReconstruction: reconId }));
  };

  return (
    <Box sx={{ flexGrow: 1, height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <AppBar position="static" elevation={1}>
        <Toolbar>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            Virtual Grünfeld
          </Typography>
          <Typography variant="subtitle1" color="inherit">
            Alfred Grünfeld • Schumann Träumerei (1905)
          </Typography>
        </Toolbar>
      </AppBar>

      <Container maxWidth={false} sx={{ 
        flexGrow: 1, 
        display: 'flex', 
        flexDirection: 'column',
        padding: 2,
        height: 'calc(100vh - 64px)' // Subtract AppBar height
      }}>
        {/* Score Panel - Top Half */}
        <Box sx={{ 
          flexGrow: 1, 
          border: '1px solid #ddd', 
          borderRadius: 2,
          marginBottom: 2,
          overflow: 'hidden'
        }}>
          <ScorePanel 
            highlights={state.scoreHighlights}
            reconstruction={state.currentReconstruction}
          />
        </Box>

        {/* Chat Interface - Bottom Half */}
        <Box sx={{ 
          height: '40vh',
          border: '1px solid #ddd',
          borderRadius: 2,
          overflow: 'hidden'
        }}>
          <ChatInterface
            messages={state.messages}
            currentReconstruction={state.currentReconstruction}
            isLoading={state.isLoading}
            error={state.error}
            onMessagesChange={updateMessages}
            onLoadingChange={setLoading}
            onErrorChange={setError}
            onHighlightsChange={setHighlights}
            onReconstructionChange={setCurrentReconstruction}
          />
        </Box>
      </Container>
    </Box>
  );
}

export default App;