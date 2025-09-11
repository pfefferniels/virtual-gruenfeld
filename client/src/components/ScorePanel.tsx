import React, { useEffect, useRef, useState } from 'react';
import { Box, Typography, Alert } from '@mui/material';

interface ScorePanelProps {
  highlights: string[];
  reconstruction: string;
}

const ScorePanel: React.FC<ScorePanelProps> = ({ highlights, reconstruction }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // In a full implementation, this would:
    // 1. Load the MEI file for the current reconstruction
    // 2. Use Verovio to render it as SVG
    // 3. Display the score in the container
    // 4. Apply highlights to the specified xmlIds

    const loadScore = async () => {
      try {
        setIsLoading(true);
        setError(null);
        
        // For now, show a placeholder
        if (containerRef.current) {
          containerRef.current.innerHTML = `
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; background: #fafafa;">
              <h3>Musik-Notenbild</h3>
              <p>Reconstruction: ${reconstruction}</p>
              <p>Highlights: [${highlights.join(', ')}]</p>
              <div style="margin-top: 20px; padding: 20px; border: 2px dashed #ccc; border-radius: 8px;">
                <p><strong>Verovio Score wird hier angezeigt</strong></p>
                <p>In der vollständigen Implementierung würde hier:</p>
                <ul style="text-align: left;">
                  <li>MEI-Datei geladen werden</li>
                  <li>Verovio die Partitur als SVG rendern</li>
                  <li>Highlighting der angegebenen xml:id Elemente erfolgen</li>
                  <li>Navigation und Interaktion ermöglicht werden</li>
                </ul>
              </div>
            </div>
          `;
        }
        
        setIsLoading(false);
      } catch (err) {
        setError('Fehler beim Laden der Partitur');
        setIsLoading(false);
      }
    };

    loadScore();
  }, [reconstruction]);

  useEffect(() => {
    // Apply highlights when they change
    if (highlights.length > 0 && !isLoading) {
      // In a real implementation, this would:
      // 1. Find SVG elements with the specified xml:id values
      // 2. Add highlight CSS classes
      // 3. Scroll to the highlighted region if needed
      
      console.log('Applying highlights:', highlights);
      
      // Simulate highlighting by updating the display
      if (containerRef.current) {
        const highlightInfo = containerRef.current.querySelector('.highlight-info');
        if (highlightInfo) {
          highlightInfo.textContent = `Highlights: [${highlights.join(', ')}]`;
        }
      }
    }
  }, [highlights, isLoading]);

  if (error) {
    return (
      <Box sx={{ p: 2, height: '100%' }}>
        <Alert severity="error">{error}</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ 
      height: '100%', 
      overflow: 'auto',
      backgroundColor: '#fafafa'
    }}>
      {isLoading && (
        <Box sx={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center', 
          height: '100%' 
        }}>
          <Typography>Lade Partitur...</Typography>
        </Box>
      )}
      <div 
        ref={containerRef} 
        style={{ 
          height: '100%', 
          minHeight: '400px'
        }}
      />
    </Box>
  );
};

export default ScorePanel;