import axios from 'axios';
import { BeliefMap } from '../types';

const API_BASE = '/api';

export interface ChatRequest {
  message: string;
  selection: string[]
}

export interface ChatResponse {
  reply?: string;
  stop?: boolean
  audio?: {
    url: string;
  };
  highlight?: string[];
  reconstruction?: string;
  observations?: BeliefMap;
}

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