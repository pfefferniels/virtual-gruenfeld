import { ParseNLToOMAInput, ParseNLToOMAOutput, OMA, ModifierSpec } from '../types';

/**
 * Tool 2: Parse natural language locator (DE/EN) to OMA
 * Converts German/English descriptions to canonical OMA format
 */
export function parseNLToOMA(input: ParseNLToOMAInput): ParseNLToOMAOutput {
  const { text } = input;
  const lowerText = text.toLowerCase();

  // Intent detection
  if (lowerText.includes('danke') || lowerText.includes('stop') || lowerText.includes('halt')) {
    return { intent: "stop" };
  }

  if (lowerText.includes('reduktion') || lowerText.includes('harmonisch')) {
    return { 
      intent: "swap",
      targetReconId: "harmonic_reduction"
    };
  }

  if (lowerText.includes('vollständig') || lowerText.includes('original')) {
    return { 
      intent: "swap",
      targetReconId: "reconstruction"
    };
  }

  // Modifier detection
  const modifiers: ModifierSpec = {};
  
  if (lowerText.includes('übertreiben') || lowerText.includes('exaggerate')) {
    modifiers.exaggerate = {};
    
    if (lowerText.includes('dynamik')) {
      modifiers.exaggerate.dynamics = 1.5;
    }
    if (lowerText.includes('rubato')) {
      modifiers.exaggerate.rubato = 1.5;
    }
    if (!modifiers.exaggerate.dynamics && !modifiers.exaggerate.rubato) {
      // Default to dynamics if no specific aspect mentioned
      modifiers.exaggerate.dynamics = 1.5;
    }
  }

  if (lowerText.includes('langsamer') || lowerText.includes('slower')) {
    modifiers.tempo = { factor: 0.8 };
  } else if (lowerText.includes('schneller') || lowerText.includes('faster')) {
    modifiers.tempo = { factor: 1.2 };
  }

  // If we have modifiers and phrases like "an dieser stelle", it's a modify intent
  if (Object.keys(modifiers).length > 0 && 
      (lowerText.includes('an dieser stelle') || lowerText.includes('diese stelle'))) {
    return {
      intent: "modify",
      modifiers
    };
  }

  // Location parsing
  const oma = parseLocation(text);
  
  if (oma) {
    return {
      oma,
      intent: Object.keys(modifiers).length > 0 ? "modify" : "play",
      modifiers: Object.keys(modifiers).length > 0 ? modifiers : undefined
    };
  }

  // Default to beginning if no specific location found
  return {
    oma: { from: { measure: 1, beat: 1 } },
    intent: "play"
  };
}

/**
 * Parse location-specific phrases to OMA
 */
function parseLocation(text: string): OMA | null {
  const lowerText = text.toLowerCase();

  // "Anfang" / "beginning"
  if (lowerText.includes('anfang') || lowerText.includes('beginning') || lowerText.includes('start')) {
    if (lowerText.includes('bis')) {
      // "Anfang bis Takt X"
      const measureMatch = text.match(/bis\s+(?:takt|t\.?)\s*(\d+)/i);
      if (measureMatch) {
        const toMeasure = parseInt(measureMatch[1]);
        return {
          from: { measure: 1, beat: 1 },
          to: { measure: toMeasure, beat: 1 }
        };
      }
    }
    return { from: { measure: 1, beat: 1 } };
  }

  // "Auftakt zu Takt X"
  const auftaktMatch = text.match(/auftakt\s+(?:zu\s+)?(?:takt|t\.?)\s*(\d+)/i);
  if (auftaktMatch) {
    const measure = parseInt(auftaktMatch[1]);
    return {
      from: { measure: Math.max(1, measure - 1), beat: 4 }, // Approximate anacrusis
      to: { measure, beat: 1 }
    };
  }

  // "Takt X" or "T. X"
  const measureMatch = text.match(/(?:takt|t\.?)\s*(\d+)(?:\s*(?:bis|–|-)\s*(?:takt|t\.?)\s*(\d+))?/i);
  if (measureMatch) {
    const fromMeasure = parseInt(measureMatch[1]);
    const toMeasure = measureMatch[2] ? parseInt(measureMatch[2]) : fromMeasure;
    
    return {
      from: { measure: fromMeasure, beat: 1 },
      to: { measure: toMeasure + 1, beat: 1 } // Next measure
    };
  }

  // "Schlag X"
  const beatMatch = text.match(/schlag\s*(\d+)/i);
  if (beatMatch) {
    const beat = parseInt(beatMatch[1]);
    // Need to combine with measure info if available
    const measureInContext = text.match(/(?:takt|t\.?)\s*(\d+)/i);
    if (measureInContext) {
      const measure = parseInt(measureInContext[1]);
      return {
        from: { measure, beat },
        to: { measure, beat: beat + 1 }
      };
    }
  }

  return null;
}