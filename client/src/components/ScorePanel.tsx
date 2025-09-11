import React, { useEffect, useRef, useState } from 'react';
import { Box, Typography, Alert } from '@mui/material';
import { fetchMEI } from '../utils/api';

interface ScorePanelProps {
  highlights: string[];
  reconstruction: string;
}

const ScorePanel: React.FC<ScorePanelProps> = ({ highlights, reconstruction }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [meiContent, setMeiContent] = useState<string | null>(null);

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
        
        // Download the MEI file
        const mei = await fetchMEI(reconstruction);
        setMeiContent(mei);
        
        // Calculate some basic stats about the MEI
        const xmlIdMatches = mei.match(/xml:id="[^"]+"/g) || [];
        const measureMatches = mei.match(/<measure[^>]*>/g) || [];
        const noteMatches = mei.match(/<note[^>]*>/g) || [];
        
        // Display MEI information without rendering it
        if (containerRef.current) {
          containerRef.current.innerHTML = `
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; background: #fafafa; padding: 20px;">
              <h3>MEI-Datei erfolgreich geladen</h3>
              <p><strong>Reconstruction:</strong> ${reconstruction}</p>
              <p><strong>Highlights:</strong> [${highlights.join(', ')}]</p>
              
              <div style="margin-top: 20px; padding: 20px; border: 2px solid #4caf50; border-radius: 8px; background: #e8f5e8; max-width: 600px;">
                <h4 style="color: #2e7d32; margin-top: 0;">📄 MEI-Datei Details</h4>
                <ul style="text-align: left; color: #333;">
                  <li><strong>Dateigröße:</strong> ${(mei.length / 1024).toFixed(1)} KB</li>
                  <li><strong>XML-IDs:</strong> ${xmlIdMatches.length} gefunden</li>
                  <li><strong>Takte:</strong> ${measureMatches.length} gefunden</li>
                  <li><strong>Noten:</strong> ${noteMatches.length} gefunden</li>
                </ul>
                
                <div style="margin-top: 15px; padding: 10px; background: #ffffff; border-radius: 4px; border-left: 4px solid #4caf50;">
                  <p style="margin: 0; font-style: italic; color: #666;">
                    ✅ MEI-Datei wurde erfolgreich vom Server heruntergeladen.<br/>
                    🚧 Verovio-Rendering wird in einem späteren Schritt implementiert.
                  </p>
                </div>
              </div>
              
              <div style="margin-top: 20px; padding: 15px; border: 2px dashed #2196f3; border-radius: 8px; background: #e3f2fd; max-width: 600px;">
                <h4 style="color: #1976d2; margin-top: 0;">🔮 Nächste Schritte</h4>
                <ul style="text-align: left; color: #333;">
                  <li>Verovio wird die MEI-Datei als SVG rendern</li>
                  <li>Highlighting der xml:id Elemente: [${highlights.join(', ')}]</li>
                  <li>Navigation und Interaktion werden ermöglicht</li>
                </ul>
                <div class="highlight-status" style="margin-top: 10px; padding: 10px; background: #ffffff; border-radius: 4px;">
                  <!-- Highlight status will be updated here -->
                </div>
              </div>
            </div>
          `;
        }
        
        setIsLoading(false);
      } catch (err) {
        console.error('Error loading MEI:', err);
        setError('Fehler beim Laden der MEI-Datei');
        setIsLoading(false);
      }
    };

    loadScore();
  }, [reconstruction]);

  useEffect(() => {
    // Apply highlights when they change and MEI is loaded
    if (highlights.length > 0 && !isLoading && meiContent) {
      console.log('Applying highlights to downloaded MEI:', highlights);
      
      // Check if the highlighted xml:ids exist in the MEI
      const foundIds = highlights.filter(id => meiContent.includes(`xml:id="${id}"`));
      const missingIds = highlights.filter(id => !meiContent.includes(`xml:id="${id}"`));
      
      if (foundIds.length > 0) {
        console.log(`Found ${foundIds.length} highlight IDs in MEI:`, foundIds);
      }
      if (missingIds.length > 0) {
        console.log(`Missing ${missingIds.length} highlight IDs in MEI:`, missingIds);
      }
      
      // Update the display to show which highlights were found
      if (containerRef.current) {
        const highlightElement = containerRef.current.querySelector('.highlight-status');
        if (highlightElement) {
          highlightElement.innerHTML = `
            <p><strong>Highlight Status:</strong></p>
            ${foundIds.length > 0 ? `<p style="color: #4caf50;">✅ Gefunden: [${foundIds.join(', ')}]</p>` : ''}
            ${missingIds.length > 0 ? `<p style="color: #f44336;">❌ Nicht gefunden: [${missingIds.join(', ')}]</p>` : ''}
          `;
        }
      }
    }
  }, [highlights, isLoading, meiContent]);

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