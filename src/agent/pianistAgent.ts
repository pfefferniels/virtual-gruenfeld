import { 
  ChatResponse, 
  ConversationContext, 
  OMA, 
  RegionResult 
} from '../types';
import { parseNLToOMA } from '../tools/parseNLToOMA';
import { omaToRegion } from '../tools/omaToRegion';
import { applyMPM } from '../tools/applyMPM';
import { modifyMPM } from '../tools/modifyMPM';
import { renderAudio } from '../tools/renderAudio';
import { swapReconstruction } from '../tools/swapReconstruction';
import { stopPlayback } from '../tools/stopPlayback';

/**
 * PianistAgent - Main agent for processing user requests
 * Role: "Alfred Grünfeld" who can play whole piece or specific places, 
 * exaggerate for demonstration, and play harmonic reductions.
 * Style: brief, precise; return audio ASAP, a one-liner only when something went wrong.
 */
export class PianistAgent {
  private context: ConversationContext;

  constructor(context: ConversationContext) {
    this.context = { ...context };
  }

  /**
   * Process a user message and return appropriate response
   */
  async processMessage(message: string, locale: string = 'de'): Promise<ChatResponse> {
    try {
      // Parse natural language to understand intent
      const nlResult = parseNLToOMA({ text: message });
      
      switch (nlResult.intent) {
        case 'stop':
          return this.handleStop();
          
        case 'swap':
          return await this.handleSwap(nlResult.targetReconId!);
          
        case 'play':
          return await this.handlePlay(nlResult.oma!, nlResult.modifiers);
          
        case 'modify':
          return await this.handleModify(nlResult.modifiers!);
          
        default:
          return {
            reply: "Entschuldigung, ich habe Sie nicht verstanden. Können Sie Ihre Anfrage präzisieren?"
          };
      }
      
    } catch (error) {
      console.error('PianistAgent error:', error);
      return {
        reply: "Es tut mir leid, bei der Verarbeitung Ihrer Anfrage ist ein Fehler aufgetreten."
      };
    }
  }

  /**
   * Handle stop playback request
   */
  private handleStop(): ChatResponse {
    stopPlayback();
    return {
      reply: "Verstanden."
    };
  }

  /**
   * Handle reconstruction swap
   */
  private async handleSwap(targetReconId: string): Promise<ChatResponse> {
    try {
      swapReconstruction({ reconId: targetReconId });
      this.context.currentReconId = targetReconId;
      
      const isReduction = targetReconId.includes('reduction');
      return {
        reply: isReduction 
          ? "Ich wechsele zur harmonischen Reduktion."
          : "Ich kehre zur vollständigen Fassung zurück.",
        context: {
          reconId: targetReconId
        }
      };
    } catch (error) {
      return {
        reply: "Diese Fassung ist leider nicht verfügbar."
      };
    }
  }

  /**
   * Handle play request for specific musical location
   */
  private async handlePlay(oma: OMA, modifiers?: any): Promise<ChatResponse> {
    try {
      // Convert OMA to region
      const region = omaToRegion({
        reconId: this.context.currentReconId,
        oma
      });
      
      // Store region for potential future "an dieser Stelle" references
      this.context.lastRegion = region;
      
      let mpmPath: string | undefined;
      
      // Apply modifiers if present
      if (modifiers && Object.keys(modifiers).length > 0) {
        const modifyResult = await modifyMPM({
          mpmPath: this.getDefaultMPMPath(),
          modifiers
        });
        mpmPath = modifyResult.mpmPath;
      }
      
      // Generate MIDI
      const midiResult = await applyMPM({
        reconId: this.context.currentReconId,
        region,
        mpmPath
      });
      
      // Render audio
      const audioResult = await renderAudio({
        midiPath: midiResult.midiPath,
        format: (process.env.RENDER_AUDIO_FORMAT as 'mp3' | 'wav') || 'mp3'
      });
      
      return {
        reply: this.generatePlayResponse(region),
        audio: {
          url: `/renders/${audioResult.audioPath.split('/').pop()}`,
          format: audioResult.audioPath.endsWith('.mp3') ? 'mp3' : 'wav',
          durationSec: audioResult.durationSec
        },
        highlight: {
          xmlIds: region.meiXmlIds
        },
        context: {
          reconId: this.context.currentReconId,
          oma: region.oma
        }
      };
      
    } catch (error) {
      return {
        reply: "Diese Stelle konnte ich leider nicht finden oder abspielen."
      };
    }
  }

  /**
   * Handle modification of the last played region
   */
  private async handleModify(modifiers: any): Promise<ChatResponse> {
    if (!this.context.lastRegion) {
      return {
        reply: "Ich weiß nicht, auf welche Stelle Sie sich beziehen. Können Sie eine konkrete Stelle angeben?"
      };
    }
    
    try {
      // Apply modifiers to the last region
      const modifyResult = await modifyMPM({
        mpmPath: this.getDefaultMPMPath(),
        modifiers
      });
      
      // Generate MIDI with modified MPM
      const midiResult = await applyMPM({
        reconId: this.context.currentReconId,
        region: this.context.lastRegion,
        mpmPath: modifyResult.mpmPath
      });
      
      // Render audio
      const audioResult = await renderAudio({
        midiPath: midiResult.midiPath,
        format: (process.env.RENDER_AUDIO_FORMAT as 'mp3' | 'wav') || 'mp3'
      });
      
      return {
        reply: this.generateModifyResponse(modifiers),
        audio: {
          url: `/renders/${audioResult.audioPath.split('/').pop()}`,
          format: audioResult.audioPath.endsWith('.mp3') ? 'mp3' : 'wav',
          durationSec: audioResult.durationSec
        },
        highlight: {
          xmlIds: this.context.lastRegion.meiXmlIds
        },
        context: {
          reconId: this.context.currentReconId,
          oma: this.context.lastRegion.oma
        }
      };
      
    } catch (error) {
      return {
        reply: "Die Modifikation konnte leider nicht angewendet werden."
      };
    }
  }

  /**
   * Generate response text for play actions
   */
  private generatePlayResponse(region: RegionResult): string {
    return `Hier ist ${region.barsLabel}.`;
  }

  /**
   * Generate response text for modify actions
   */
  private generateModifyResponse(modifiers: any): string {
    const modifications: string[] = [];
    
    if (modifiers.exaggerate?.dynamics) {
      modifications.push("übertriebene Dynamik");
    }
    if (modifiers.exaggerate?.rubato) {
      modifications.push("verstärktes Rubato");
    }
    if (modifiers.tempo?.factor) {
      if (modifiers.tempo.factor < 1) {
        modifications.push("langsameres Tempo");
      } else if (modifiers.tempo.factor > 1) {
        modifications.push("schnelleres Tempo");
      }
    }
    
    if (modifications.length === 0) {
      return "Hier ist die modifizierte Version.";
    }
    
    return `Hier mit ${modifications.join(' und ')}.`;
  }

  /**
   * Get default MPM path for current reconstruction
   */
  private getDefaultMPMPath(): string {
    return `assets/${this.context.currentReconId}/performance.mpm`;
  }

  /**
   * Get current conversation context
   */
  getContext(): ConversationContext {
    return { ...this.context };
  }
}