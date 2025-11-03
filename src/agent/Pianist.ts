import {
  ChatResponse,
  Ranges,
} from '../types';
import { generateMP3 } from '../tools/applyMPM';
import { modifyMPM } from '../tools/modifyMPM';
import { loadMEI } from '../utils/verovioWrapper';
import { understandSelection, LabelEntry } from './SelectionAgent';
import path from 'path';
import * as fs from 'fs';
import { BeliefMap, beliefsBasedOn, loadObservations } from '../utils/observations';
import { ModifyParams, understandAspect } from './AspectAgent';
import { summarize } from './SummaryAgent';
import { listAvailableReconstructions } from '../utils/fileSystem';

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

export interface HistoryEntry {
  selection: string
  selectionComprehension: string[]

  aspect: string
  aspectComprehension: ModifyParams

  finalResult: ChatResponse
}

/**
 * The pianist does everything what the user asks for.
 */
export class Pianist {
  // This is basically a fast cache
  private history: HistoryEntry[];

  constructor(history: HistoryEntry[] = []) {
    this.history = [...history];
  }

  /**
   * Process a user message and return appropriate response
   */
  async processMessage(message: string, selectedNotes: string[]): Promise<ChatResponse> {
    const json = JSON.parse(message);
    if (!('aspect' in json) || !('selection' in json)) {
      return { reply: 'Invalid message format.' };
    }
    const { aspect, selection } = json;

    const fullEquivalent = this.history.find(h => h.aspect === aspect && h.selection === selection)
    if (fullEquivalent) {
      return fullEquivalent.finalResult;
    }

    let aspectComprehension: ModifyParams | null

    const lastSameAspect = this.history.find(h => h.aspect === aspect);
    if (lastSameAspect) {
      aspectComprehension = lastSameAspect.aspectComprehension
    }
    else {
      aspectComprehension = await understandAspect(aspect);
    }

    if (!aspectComprehension) {
      return { reply: `Sorry, I cannot understand the aspect "${aspect}".` }
    }

    let { reconstruction, increase, exaggerate } = aspectComprehension
    if (!reconstruction) {
      return { reply: `Sorry, I cannot determine the reconstruction for the aspect "${aspect}".` }
    }

    console.log('reconstruction=', reconstruction)
    const mei = await loadMEI(reconstruction)
    if (mei.length === 0 || mei === "[empty]") {
      return { reply: `Sorry, I cannot find the reconstruction "${reconstruction}".` }
    }

    const labels = loadLabels(reconstruction);
    if (labels.length === 0) return { reply: `Sorry, I cannot find labels for the reconstruction "${reconstruction}".` }

    let ids: string[] = selectedNotes
    if (ids.length === 0) {
      const lastSameSelection = this.history.find(h => h.selection === selection);
      if (lastSameSelection) {
        ids = lastSameSelection.selectionComprehension
      }
      else {
        ids = await understandSelection(mei, selection, labels)
      }
    }

    let mpmPath = this.getMPMPath(reconstruction);

    if (!increase && !exaggerate) {
      // Always apply some slight variation, 
      // if the user asked for it or not.
      exaggerate = {
        dynamics: Math.random() / 2,
        rubato: Math.random() / 2,
        tempo: Math.random() / 2,
        temporalSpread: Math.random() / 2,
        dynamicsGradient: Math.random() / 2,
        relativeVelocity: Math.random() / 2,
        relativeDuration: Math.random() / 2,
      }
    }

    const reply = summarize({
      appliedModifications: {
        increase,
        exaggerate,
      },
      usedVariant: listAvailableReconstructions().find(r => r.id === reconstruction),
      // ids: ids.length
    })

    // Apply modifiers
    mpmPath = await modifyMPM({
      mpmPath,
      modifiers: { increase, exaggerate }
    });

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
    }

    const result: ChatResponse = {
      reply: await reply,
      audio: {
        url: `/renders/${mp3Path.split('/').pop()}`,
      },
      highlight: ids,
      reconstruction,
      observations
    }

    this.history.push({
      selection,
      selectionComprehension: ids,
      aspect,
      aspectComprehension,
      finalResult: result
    })

    return result;
  }

  /**
   * Get default MPM path for current reconstruction
   */
  private getMPMPath(reconstruction: string): string {
    return `assets/${reconstruction}/performance.mpm`;
  }
}
