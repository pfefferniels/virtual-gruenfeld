import { useEffect, useRef, useState } from 'react';
import { Box, Typography, Alert } from '@mui/material';
import createVerovioModule from 'verovio/wasm';
import { VerovioToolkit } from 'verovio/esm';
import { FreehandSVGDrawer } from './FreehandCircle'
import { SelectionCircle } from './SelectionCircle';
import { PlayControl } from './PlayControl';

interface ScorePanelProps {
  highlights: string[];
  onSelect: (noteIds: string[]) => void
}

const ScorePanel = ({ highlights, onSelect }: ScorePanelProps) => {
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [vrvToolkit, setVrvToolkit] = useState<VerovioToolkit | null>(null);
  const [hasSvg, setHasSvg] = useState(false);
  const [anchorEl, setAnchorEl] = useState<Element | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const verovioSvgRef = useRef<SVGSVGElement | null>(null);


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

        const response = await fetch(`/api/mei/reconstruction`);
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
  }, [vrvToolkit]);

  useEffect(() => {
    if (highlights.length === 0) return
    setAnchorEl(document.querySelector<SVGGraphicsElement>(`#${highlights[highlights.length - 1]}`))
  }, [highlights]);

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

      {highlights.length > 0 && (
        <PlayControl anchorEl={anchorEl} selection={highlights} />
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

          {highlights && (
            <>
              <SelectionCircle
                elements={
                  Array
                    .from(
                      highlights
                        .map(id => document.querySelector<SVGGraphicsElement>(`#${id}`))
                    )
                    .filter(el => !!el)}
                onClick={(e) => {
                  // e.stopPropagation();
                  // setAnchorEl(e.currentTarget);
                }}
              />
            </>
          )}
        </>
      )}
    </Box>
  );
};

export default ScorePanel;
