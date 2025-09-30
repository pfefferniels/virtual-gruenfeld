import { useEffect, useRef, useState } from 'react';
import { Box, Typography, Alert } from '@mui/material';
import createVerovioModule from 'verovio/wasm';
import { VerovioToolkit } from 'verovio/esm';
import { FreehandSVGDrawer } from './FreehandCircle'

interface ScorePanelProps {
  highlights: string[];
  reconstruction: string;
  onSelect: (noteIds: string[]) => void
}

const ScorePanel = ({ highlights, reconstruction, onSelect }: ScorePanelProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const verovioSvgRef = useRef<SVGSVGElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [vrvToolkit, setVrvToolkit] = useState<VerovioToolkit | null>(null);
  const [hasSvg, setHasSvg] = useState(false);

  useEffect(() => {
    createVerovioModule().then(VerovioModule => {
      const verovioToolkit = new VerovioToolkit(VerovioModule);
      setVrvToolkit(verovioToolkit);
    });
  }, []);

  useEffect(() => {
    if (!vrvToolkit) return;

    const loadScore = async () => {
      try {
        setIsLoading(true);
        setError(null);
        setHasSvg(false);

        const response = await fetch(`/api/mei/${reconstruction}`);
        const mei = await response.text();

        vrvToolkit.setOptions({
          footer: 'none',
          adjustPageHeight: true,
          adjustPageWidth: true,
          scale: 60,
          breaks: 'none',
        });

        vrvToolkit.loadData(mei);
        const svg = vrvToolkit.renderToSVG(1);

        if (containerRef.current) {
          containerRef.current.innerHTML = svg;

          // Grab the newly rendered SVG element and assign it to our ref
          const svgEl = containerRef.current.querySelector('svg') as SVGSVGElement | null;
          if (svgEl) {
            verovioSvgRef.current = svgEl;
            svgEl.style.touchAction = 'none'; // prevent page panning while drawing on touch
            setHasSvg(true);
          }
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
    if (highlights.length > 0 && !isLoading) {
      const container = containerRef.current;
      if (!container) return;

      const prev = container.querySelectorAll('.vrv-highlight');
      prev.forEach(el => el.classList.remove('vrv-highlight'));

      highlights.forEach((id, i) => {
        const el = container.querySelector<SVGElement>(`#${id}`);
        if (!el) return;
        if (i === 0) el.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'center' });
        el.classList.add('vrv-highlight');
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
    <Box sx={{ height: '100%', overflow: 'auto' }}>
      {isLoading && (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
          <Typography>Loading Score ...</Typography>
        </Box>
      )}

      <div ref={containerRef} style={{ height: '100%', minHeight: '400px' }} />

      {/* Mount once the Verovio SVG is present */}
      {hasSvg && (
        <>
          <FreehandSVGDrawer
            svgRef={verovioSvgRef}
            smoothIterations={2}
            minPointDistance={2}
            roughOptions={{ stroke: '#1f2937', strokeWidth: 2.5, roughness: 1.4, bowing: 1.1, fillStyle: 'hachure' }}
            previewClassName="stroke-gray-700"
            onNoteSelected={onSelect}
          />


        </>
      )}
    </Box>
  );
};

export default ScorePanel;
