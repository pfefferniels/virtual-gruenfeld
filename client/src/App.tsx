import { useRef, useState } from 'react';
import { Container, Box, Paper } from '@mui/material';
import ChatInterface from './components/ChatInterface';
import ScorePanel from './components/ScorePanel';
import { ChatResponse } from './utils/api';
import { ObservationPanel } from './components/ObservationPanel';

function App() {
  const [lastResponse, setLastResponse] = useState<ChatResponse>()
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [noteIds, setNoteIds] = useState<string[]>([])

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
            highlights={lastResponse?.highlight || []}
            reconstruction={'reconstruction'}
            onSelect={setNoteIds}
          />
        </Box>

        {lastResponse?.observations && (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', mb: 2 }}>
            <ObservationPanel
              audioRef={audioRef}
              observations={lastResponse?.observations}
            />
            </Box>
        )}

        <ChatInterface
          onResponse={resp => setLastResponse(resp)}
          audioRef={audioRef}
          noteIds={noteIds}
        />
      </Container>
    </Box>
  );
}

export default App;