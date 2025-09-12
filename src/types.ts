// Core types for Virtual Grünfeld application
// Based on specification.md

export type ReconId = string;

export interface OMA {
  from: { measure: number; beat?: number; beatOffset?: number };
  to?: { measure: number; beat?: number; beatOffset?: number };
}

export interface RegionResult {
  oma: OMA;                              // normalized OMA
  meiXmlIds: string[];                   // notes/rests in selection (for highlight)
  startTick: number;                     // score-time ticks (MPM PPQ)
  endTick: number;                       // score-time ticks (MPM PPQ; exclusive)
  barsLabel: string;                     // e.g., "Anfang–T.3/1" or "Auftakt→T.2/1"
}

export interface ModifierSpec {
  exaggerate?: { 
    dynamics?: number; 
    rubato?: number; 
    articulation?: number 
  }; // 0..2
  tempo?: { factor: number }; // e.g., 0.9 slower, 1.1 faster
  hide?: { 
    dynamics?: boolean; 
    rubato?: boolean; 
    articulation?: boolean 
  };
  // If user says "an dieser Stelle", resolver will scope to last RegionResult
}

export interface ReconInfo {
  id: ReconId;                        // "full_reconstruction" | "harmonic_reduction" | ...
  label: string;                      // UI label
  // possibly more metadata to come at a later stage
}

// Tool function input/output types
export interface ListReconstructionsOutput {
  reconstructions: Array<{ id: ReconId; label: string }>;
}

export interface ParseNLToOMAInput {
  text: string;
}

export interface ParseNLToOMAOutput {
  oma?: OMA;
  intent: "play" | "modify" | "stop" | "swap";
  modifiers?: ModifierSpec;
  targetReconId?: ReconId;
}

export interface OMAToRegionInput {
  reconId: ReconId;
  oma: OMA;
}

export interface ApplyMPMInput {
  reconId: ReconId;
  region: RegionResult;
  mpmPath: string;
}

export interface ApplyMPMOutput {
  mp3Path: string;
}

export interface ModifyMPMInput {
  mpmPath: string;
  modifiers: ModifierSpec;
}

export interface ModifyMPMOutput {
  mpmPath: string;
  log: string[];
}

export interface SwapReconstructionInput {
  reconId: ReconId;
}

export interface SwapReconstructionOutput {
  ok: true;
}

export interface StopPlaybackOutput {
  ok: true;
}

// REST API types
export interface ChatRequest {
  message: string;
  reconId?: ReconId;
  locale?: "de" | "en";
}

export interface ChatResponse {
  reply: string;                                 // short text
  audio?: { 
    url: string; 
  };
  highlight?: { xmlIds: string[] };              // for Verovio to emphasize
  context?: { 
    reconId: ReconId; 
    oma?: OMA; 
  };      // for subsequent "an dieser Stelle"
}

// Internal context for maintaining conversation state
export interface ConversationContext {
  lastRegion?: RegionResult;
  currentReconId: ReconId;
}