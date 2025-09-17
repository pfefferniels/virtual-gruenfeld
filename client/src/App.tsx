import { useState } from 'react';
import { Container, Box, Paper } from '@mui/material';
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
      <Paper elevation={5} sx={{
        position: 'absolute',
        right: '3rem',
        top: '3rem',
        maxWidth: 400,
        padding: 3
      }}
      >
        <h3>About</h3>
        <p>
          This prototype lets you interact with Alfred Grünfeld about his interpretation of
          Schumann’s <i>Träumerei</i> (Kinderszenen, Op. 15). You can ask him to play the piece
          or parts of it, adjust his style (rubato, dynamics, agogics, arpeggiation, etc.),
          or illustrate his ideas with a harmonic reduction.
        </p>
      </Paper>

      <Container maxWidth={false} sx={{
        flexGrow: 1,
        display: 'flex',
        flexDirection: 'column',
        padding: 2,
        height: 'calc(100vh - 64px)'
      }}>
        <Box sx={{
          flexGrow: 1,
          marginBottom: 2,
          overflow: 'hidden'
        }}>
          <ScorePanel
            highlights={state.scoreHighlights}
            reconstruction={state.currentReconstruction}
          />
        </Box>

        <Box>
          Footnotes
        </Box>

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
      </Container>
    </Box>
  );
}

export default App;