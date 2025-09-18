import {
  ChatResponse,
  ParsedNL,
  Ranges,
} from '../types';
import { generateMP3 } from '../tools/applyMPM';
import { modifyMPM } from '../tools/modifyMPM';
import { loadMEI } from '../utils/verovioWrapper';
import { chooseReconstruction } from './ChoseReconstructionAgent';
import { extractIDsFromMessage, LabelEntry } from './ExtractIDsAgent';
import path from 'path';
import * as fs from 'fs';
import { modify } from './ModifyAgent';
import { BeliefMap, beliefsBasedOn, loadObservations } from '../utils/observations';

function overlap(a: [number, number], b: [number, number]): boolean {
  const [start1, end1] = a;
  const [start2, end2] = b;

  return start1 <= end2 && start2 <= end1;
}

const loadLabels = (reconstruction: string): LabelEntry[] => {
  const labelPath = path.join(process.cwd(), 'assets', reconstruction, 'labels.json');

  if (!fs.existsSync(labelPath)) return []

  const fileContent = fs.readFileSync(labelPath, 'utf8');
  const labels: LabelEntry[] = JSON.parse(fileContent);
  return labels;
}

/**
 * PianistAgent - Main agent for processing user requests
 * Role: "Alfred Grünfeld" who can play whole piece or specific places, 
 * exaggerate for demonstration, and play harmonic reductions.
 * Style: brief, precise; return audio ASAP, a one-liner only when something went wrong.
 */
export class PianistAgent {
  private context: ParsedNL;

  constructor(context: ParsedNL) {
    this.context = { ...context };
  }

  /**
   * Process a user message and return appropriate response
   */
  async processMessage(message: string): Promise<ChatResponse> {
    const reconstruction = await chooseReconstruction(message) || this.context.reconstruction || 'reconstruction';
    this.context.reconstruction = reconstruction;

    const mei = await loadMEI(reconstruction)
    if (mei.length === 0 || mei === "[empty]") {
      return { reply: `Sorry, I cannot find the reconstruction "${reconstruction}".` }
    }

    const labels = loadLabels(reconstruction);
    if (labels.length === 0) return { reply: `Sorry, I cannot find labels for the reconstruction "${reconstruction}".` }
    const ids: string[] = await extractIDsFromMessage(mei, message, labels);

    let mpmPath = this.getDefaultMPMPath();

    // Apply modifiers if present
    const modifiers = await modify(message)
    if (modifiers && Object.keys(modifiers).length > 0) {
      this.context.modifiers = modifiers;

      mpmPath = await modifyMPM({
        mpmPath,
        modifiers
      });
    }

    // Generate MP3
    const { mp3Path, rangesPath } = await generateMP3({
      reconstruction,
      ids,
      mpmPath
    });

    const observations: BeliefMap = []
    if (fs.existsSync(rangesPath)) {
      const allObservations = loadObservations(reconstruction);
      const rangesContent = fs.readFileSync(rangesPath, 'utf8');

      try {
        const ranges = JSON.parse(rangesContent) as Ranges;
        for (const [mpmId, range] of Object.entries(ranges)) {
          const beliefs = beliefsBasedOn(mpmId, allObservations || [])
          for (const belief of beliefs) {
            const sameBelief = observations.find(o => o.belief === belief)
            if (sameBelief && overlap(sameBelief.range, range)) {
              // extend range
              sameBelief.range[0] = Math.min(sameBelief.range[0], range[0]);
              sameBelief.range[1] = Math.max(sameBelief.range[1], range[1]);
            }
            else {
              observations.push({ belief, range });
            }
          }
        }
      } catch (error) {
        console.error('Error parsing ranges JSON:', error);
      }

      console.log('generated observations', observations, 'from', allObservations)
    }

    return {
      reply: this.generatePlayResponse(),
      audio: {
        url: `/renders/${mp3Path.split('/').pop()}`,
      },
      highlight: ids,
      reconstruction,
      observations
    };
  }

  /**
   * Get default MPM path for current reconstruction
   */
  private getDefaultMPMPath(): string {
    return `assets/${this.context.reconstruction}/performance.mpm`;
  }

  /**
   * Generate a brief play response
   */
  private generatePlayResponse(): string {
    // TODO: use AI to generate a natural response
    // of what we are playing based on context
    return 'Playing now.';
  }
}
