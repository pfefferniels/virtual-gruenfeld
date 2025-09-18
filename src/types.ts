// Core types for Virtual Grünfeld application
// Based on specification.md

import { ModifyParams } from "./agent/ModifyAgent";
import { BeliefMap } from "./utils/observations";

export type ReconId = string;

export interface ReconInfo {
  id: ReconId;                        // "full_reconstruction" | "harmonic_reduction" | ...
  label: string;                      // UI label
  description?: string;               // Optional description
}

// Tool function input/output types
export interface ListReconstructionsOutput {
  reconstructions: Array<{ id: ReconId; label: string }>;
}

export interface NLInput {
  text: string;
}

export interface ParsedNL {
  reconstruction?: ReconId;
  notes?: string[];
  modifiers?: ModifyParams;
  intent?: 'play' | 'stop'
}

export interface ApplyMPMInput {
  reconstruction: string;
  ids: string[];
  mpmPath: string;
}

export interface ApplyMPMOutput {
  mp3Path: string;
  rangesPath: string;
}

export type Ranges = { [key: string]: [number, number] };

export interface ModifyMPMInput {
  mpmPath: string;
  modifiers: ModifyParams;
}

export interface ModifyMPMOutput {
  mpmPath: string;
}

// REST API types
export interface ChatRequest {
  message: string;
}

export interface ChatResponse {
  reply?: string;                                 // short text
  stop?: boolean
  audio?: {
    url: string;
  };
  highlight?: string[];              // for Verovio to emphasize
  reconstruction?: string;
  observations?: BeliefMap;          // beliefs with ranges
}
