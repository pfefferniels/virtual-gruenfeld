import { ListReconstructionsOutput } from '../types';
import { listAvailableReconstructions } from '../utils/fileSystem';

/**
 * Tool 1: List available reconstructions
 * Returns all available reconstruction IDs and labels
 */
export function listReconstructions(): ListReconstructionsOutput {
  const reconstructions = listAvailableReconstructions();
  
  return {
    reconstructions: reconstructions.map(recon => ({
      id: recon.id,
      label: recon.label
    }))
  };
}