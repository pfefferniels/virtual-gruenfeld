import {
  ChatResponse,
  ModifierSpec,
  ParsedNL,
} from '../types';
import { generateMP3 } from '../tools/applyMPM';
import { modifyMPM } from '../tools/modifyMPM';
import { loadHumdrum } from '../utils/verovioWrapper';
import { extractIntent } from './IntentAgent';
import { chooseReconstruction } from './ChoseReconstructionAgent';
import { extractIDsFromMessage } from './ExtractIDsAgent';

const extractModifiers = (message: string): ModifierSpec => {
  // Derive a modifier spec from the user message
  // E.g., "etwas langsamer und mit übertreibe dein Rubato"
  // should result in { tempo: { factor: 0.9 }, exeggerate: { rubato: 1.2 } }

  return {};
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
    const intent = await extractIntent(message);
    if (intent === 'stop') {
      return { stop: true }
    }

    const reconstruction = await chooseReconstruction(message) || this.context.reconstruction || 'reconstruction';
    this.context.reconstruction = reconstruction;


    const humdrum = await loadHumdrum(reconstruction)
    console.log('humdrum', humdrum)
    if (humdrum.length === 0 || humdrum === "[empty]") {
      return { reply: `Sorry, I cannot find the reconstruction "${reconstruction}".` }
    }

    const ids: string[] = await extractIDsFromMessage(humdrum, message);

    let mpmPath = this.getDefaultMPMPath();

    // Apply modifiers if present
    const modifiers = extractModifiers(message);
    this.context.modifiers = modifiers;
    if (modifiers && Object.keys(modifiers).length > 0) {
      const modifyResult = await modifyMPM({
        mpmPath,
        modifiers
      });
      mpmPath = modifyResult.mpmPath;
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
