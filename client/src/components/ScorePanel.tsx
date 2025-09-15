import React, { useEffect, useRef, useState } from 'react';
import { Box, Typography, Alert } from '@mui/material';
import createVerovioModule from 'verovio/wasm';
import { VerovioToolkit } from 'verovio/esm';
import "./ScorePanel.css"

interface ScorePanelProps {
  highlights: string[];
  reconstruction: string;
}

const ScorePanel: React.FC<ScorePanelProps> = ({ highlights, reconstruction }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [vrvToolkit, setVrvToolkit] = useState<VerovioToolkit | null>(null);

  useEffect(() => {
    createVerovioModule().then(VerovioModule => {
      const verovioToolkit = new VerovioToolkit(VerovioModule);
      setVrvToolkit(verovioToolkit);
    });
  }, [])

  useEffect(() => {
    if (!vrvToolkit) return;
    const loadScore = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // Fetch MEI 
        const response = await fetch(`/api/mei/${reconstruction}`);
        const mei = await response.text();
        vrvToolkit.setOptions({
          footer: 'none',
          adjustPageHeight: true,
          adjustPageWidth: true,
          scale: 60,
          breaks: 'none'
        })
        vrvToolkit.loadData(mei);
        const svg = vrvToolkit.renderToSVG(1);
        if (containerRef.current) {
          containerRef.current.innerHTML = svg;
        }

        setIsLoading(false);
      } catch (err) {
        console.error('Error loading MEI:', err);
        setError('Fehler beim Laden der MEI-Datei');
        setIsLoading(false);
      }
    };

    loadScore();
  }, [reconstruction, vrvToolkit]);

  useEffect(() => {
    // Apply highlights when they change
    if (highlights.length > 0 && !isLoading) {
      const container = containerRef.current;
      if (!container) return;

      // Remove previous highlights
      const prev = container.querySelectorAll('.vrv-highlight');
      prev.forEach(el => el.classList.remove('vrv-highlight'));

      // Apply highlights and collect elements to scroll to
      const matchedElements: SVGElement[] = [];
      highlights.forEach((id, i) => {
        const el = container.querySelector<SVGElement>(`#${id}`)
        if (!el) return

        if (i === 0) {
          el.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'center' });
        }

        el.classList.add('vrv-highlight');
        matchedElements.push(el);
      });
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
    }}>
      {isLoading && (
        <Box sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%'
        }}>
          <Typography>Loading Score ...</Typography>
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