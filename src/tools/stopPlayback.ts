import { StopPlaybackOutput } from '../types';

/**
 * Tool 8: Stop playback (signal to frontend)
 * Signals that current audio playback should be stopped
 */
export function stopPlayback(): StopPlaybackOutput {
  // This tool doesn't need to do anything on the backend
  // The frontend will handle stopping audio playback
  // This just provides a signal that stop was requested
  
  return { ok: true };
}