import {
  ChatResponse,
  ModifierSpec,
  ParsedNL,
} from '../types';
import { generateMP3 } from '../tools/applyMPM';
import { modifyMPM } from '../tools/modifyMPM';
import { loadHumdrum } from '../utils/verovioWrapper';
import { listAvailableReconstructions } from '../utils/fileSystem';

const extractIntent = (message: string): 'play' | 'stop' => {
  // TODO: use AI to understand if the message 
  // is a play or stop command. If nothing
  // is specified, it's always "play"
  return "play"
}

const extractReconstruction = (message: string): string | null => {
  // TODO: use AI to find out which reconstruction
  // the user means, i.e., find the best fit from
  // the list available reconstructions
  const list = listAvailableReconstructions()

  return list[0].id
}

const extractIDs = (message: string, chosenReconstruction: string): string[] => {
  const humdrum = loadHumdrum(chosenReconstruction);

  // TODO: use AI to understand from the user's message
  // which specific notes they mean. E.g., from b. 1 to
  // b. 4 should include all notes in measures 1 to 4,
  // "the upbeat to the high f in bar 3" should include
  // just these notes. AI should introspect the humdrum
  // encoding of the whole piece. Possibly needs a separate
  // tool to only select relevant from the encoding or
  // to incrementally inspect it, since it is a larger file.

  return ['n18uj2a', 'ni1o2nd', 'naji81h']
}

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
    const intent = extractIntent(message);
    if (intent === 'stop') {
      return { stop: true }
    }

    const reconstruction = extractReconstruction(message) || this.context.reconstruction || 'reconstruction';
    this.context.reconstruction = reconstruction;

    const ids: string[] = extractIDs(message, reconstruction);

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
