import {
  ChatResponse,
  ParsedNL,
} from '../types';
import { generateMP3 } from '../tools/applyMPM';
import { modifyMPM } from '../tools/modifyMPM';
import { loadMEI } from '../utils/verovioWrapper';
import { chooseReconstruction } from './ChoseReconstructionAgent';
import { extractIDsFromMessage, LabelEntry } from './ExtractIDsAgent';
import path from 'path';
import * as fs from 'fs';
import { modify } from './ModifyAgent';

const loadLabels = (reconstruction: string): LabelEntry[] => {
  const labelPath = path.join(process.cwd(), 'assets', reconstruction, 'labels.json');
  console.log('label path', labelPath)

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
    const audio = await generateMP3({
      reconstruction,
      ids,
      mpmPath
    });

    return {
      reply: this.generatePlayResponse(),
      audio: {
        url: `/renders/${audio.mp3Path.split('/').pop()}`,
      },
      highlight: ids,
      reconstruction
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
