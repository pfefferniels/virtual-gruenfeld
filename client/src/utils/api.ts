import axios from 'axios';
import { Reconstruction } from '../types';

const API_BASE = '/api';

export interface ChatRequest {
  message: string;
  reconId?: string;
  locale?: 'de' | 'en';
}

export interface ChatResponse {
  reply: string;
  audio?: {
    url: string;
    format: 'mp3' | 'wav';
    durationSec: number;
  };
  highlight?: {
    xmlIds: string[];
  };
  context?: {
    reconId: string;
    oma?: any;
  };
}

export const fetchReconstructions = async (): Promise<Reconstruction[]> => {
  const response = await axios.get(`${API_BASE}/reconstructions`);
  return response.data.reconstructions;
};

export const sendChatMessage = async (request: ChatRequest): Promise<ChatResponse> => {
  const response = await axios.post(`${API_BASE}/chat`, request, {
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': generateSessionId()
    }
  });
  return response.data;
};

// Simple session ID generation for conversation context
let sessionId: string | null = null;

const generateSessionId = (): string => {
  if (!sessionId) {
    sessionId = Math.random().toString(36).substring(2) + Date.now().toString(36);
  }
  return sessionId;
};