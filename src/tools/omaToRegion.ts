import { OMAToRegionInput, RegionResult, OMA } from '../types';
import { getReconstructionPaths, validateReconstruction } from '../utils/fileSystem';
import * as fs from 'fs';

/**
 * Tool 3: Convert OMA to region with MEI+MPM info
 * Resolves OMA coordinates to score-time ticks and MEI XML IDs
 */
export function omaToRegion(input: OMAToRegionInput): RegionResult {
  const { reconId, oma } = input;

  // Validate reconstruction exists
  if (!validateReconstruction(reconId)) {
    throw new Error(`Reconstruction ${reconId} not found or incomplete`);
  }

  const paths = getReconstructionPaths(reconId);

  // For now, we'll create a stub implementation
  // In a full implementation, this would:
  // 1. Parse MEI file to understand the score structure
  // 2. Read MPM file to get PPQ and timing information
  // 3. Calculate score-time ticks for the OMA region
  // 4. Find MEI xml:id elements that fall within the region
  // 5. Generate human-readable labels

  const { startTick, endTick } = calculateTicks(oma, paths.performance);
  const meiXmlIds = findMEIElements(oma, paths.score);
  const barsLabel = generateBarsLabel(oma);

  return {
    oma: normalizeOMA(oma),
    meiXmlIds,
    startTick,
    endTick,
    barsLabel
  };
}

/**
 * Normalize OMA to ensure consistent format
 */
function normalizeOMA(oma: OMA): OMA {
  const normalized: OMA = {
    from: {
      measure: oma.from.measure,
      beat: oma.from.beat || 1,
      beatOffset: oma.from.beatOffset || 0
    }
  };

  if (oma.to) {
    normalized.to = {
      measure: oma.to.measure,
      beat: oma.to.beat || 1,
      beatOffset: oma.to.beatOffset || 0
    };
  } else {
    // Default span: one measure
    normalized.to = {
      measure: oma.from.measure + 1,
      beat: 1,
      beatOffset: 0
    };
  }

  return normalized;
}

/**
 * Calculate score-time ticks for OMA region
 * This is a stub implementation - would need actual MEI/MPM parsing
 */
function calculateTicks(oma: OMA, mpmPath: string): { startTick: number; endTick: number } {
  // Stub implementation with default PPQ
  const PPQ = 720; // Common PPQ value, should be read from MPM
  const beatsPerMeasure = 4; // Should be read from MEI meter information

  const startTick = ((oma.from.measure - 1) * beatsPerMeasure + (oma.from.beat || 1) - 1) * PPQ;
  
  let endTick: number;
  if (oma.to) {
    endTick = ((oma.to.measure - 1) * beatsPerMeasure + (oma.to.beat || 1) - 1) * PPQ;
  } else {
    // Default to one measure length
    endTick = startTick + (beatsPerMeasure * PPQ);
  }

  return { startTick, endTick };
}

/**
 * Find MEI elements (xml:id) within the OMA region
 * This is a stub implementation - would need actual MEI parsing
 */
function findMEIElements(oma: OMA, meiPath: string): string[] {
  // Stub implementation
  // In a real implementation, this would:
  // 1. Parse MEI XML
  // 2. Find all notes/rests with onset times in the score-time range
  // 3. Return their xml:id attributes

  const stubIds: string[] = [];
  const startMeasure = oma.from.measure;
  const endMeasure = oma.to?.measure || startMeasure + 1;

  // Generate some stub IDs based on measure range
  for (let m = startMeasure; m < endMeasure; m++) {
    for (let note = 1; note <= 8; note++) { // Assume up to 8 notes per measure
      stubIds.push(`note-m${m}-n${note}`);
    }
  }

  return stubIds;
}

/**
 * Generate human-readable label for the bars
 */
function generateBarsLabel(oma: OMA): string {
  const startMeasure = oma.from.measure;
  const endMeasure = oma.to?.measure;

  if (!endMeasure || endMeasure === startMeasure + 1) {
    return `T.${startMeasure}`;
  }

  if (endMeasure === startMeasure) {
    const beat = oma.from.beat || 1;
    return `T.${startMeasure}/${beat}`;
  }

  return `T.${startMeasure}–${endMeasure - 1}`;
}