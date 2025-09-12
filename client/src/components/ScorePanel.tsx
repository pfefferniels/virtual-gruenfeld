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
        vrvToolkit.loadData(mei);
        const svg = vrvToolkit.renderToSVG(1);
        if (containerRef.current) {
          containerRef.current.innerHTML = svg;
        }

        setIsLoading(false);
      } catch (err) {
        setError('Fehler beim Laden der Partitur');
        setIsLoading(false);
      }
    };

    loadScore();
  }, [reconstruction, vrvToolkit]);

  useEffect(() => {
    // Apply highlights when they change
    if (highlights.length > 0 && !isLoading) {
      // 1. Find SVG elements with the specified xml:id values
      // 2. Add highlight CSS classes
      // 3. Scroll to the highlighted region if needed

      const container = containerRef.current;
      if (!container) return;

      // Remove previous highlights
      const prev = container.querySelectorAll('.vrv-highlight');
      prev.forEach(el => el.classList.remove('vrv-highlight'));

      // Helper to escape CSS id selectors
      const cssEscape = (id: string) => {
        // Prefer native CSS.escape if available
        // @ts-ignore
        if (typeof (window as any).CSS?.escape === 'function') return (window as any).CSS.escape(id);
        // Fallback simple escape for common cases
        return id.replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1');
      };

      // Apply highlights and collect elements to scroll to
      const matchedElements: Element[] = [];
      highlights.forEach(rawId => {
        if (!rawId) return;
        const id = rawId.trim();

        let el: Element | null = null;
        // Try getting by id (fast)
        try {
          el = container.querySelector(`#${cssEscape(id)}`);
        } catch {
          // Ignore selector errors, fallback to attribute search
        }
        // Fallback: search by xml\\:id or [id=...] attribute if necessary
        if (!el) {
          el = container.querySelector(`[id="${id}"], [xml\\:id="${id}"], [data-id="${id}"]`);
        }
        if (!el) {
          // Try global getElementById within container's SVG
          const svgs = container.querySelectorAll('svg');
          for (const svg of Array.from(svgs)) {
            // @ts-ignore
            const found = (svg as SVGSVGElement).getElementById?.(id);
            if (found) {
              el = found;
              break;
            }
          }
        }

        if (el) {
          el.classList.add('vrv-highlight');
          matchedElements.push(el);
        } else {
          console.warn('Highlight id not found in SVG:', id);
        }
      });

      // If we have matched elements, scroll the first one into view (centered)
      if (matchedElements.length > 0) {
        const target = matchedElements[0];
        // Prefer scrollIntoView with centering; if container is scrollable, compute offsets
        try {
          // Use element.scrollIntoView if available
          (target as HTMLElement).scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'center' });
        } catch {
          // Fallback: compute scroll offsets relative to container
          const elemRect = target.getBoundingClientRect();
          const contRect = container.getBoundingClientRect();
          const left = container.scrollLeft + (elemRect.left - contRect.left) - contRect.width / 2 + elemRect.width / 2;
          const top = container.scrollTop + (elemRect.top - contRect.top) - contRect.height / 2 + elemRect.height / 2;
          container.scrollTo({ left, top, behavior: 'smooth' });
        }
      }

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
      {vrvToolkit && (
        <div>Verovio Toolkit successfully loaded</div>
      )}
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