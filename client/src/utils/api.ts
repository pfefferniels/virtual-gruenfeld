import axios from 'axios';
import { BeliefMap, Reconstruction } from '../types';

const API_BASE = '/api';

export interface ChatRequest {
  message: string;
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

export const fetchMEI = async (reconId: string): Promise<string> => {
  const response = await axios.get(`${API_BASE}/mei/${reconId}`, {
    headers: {
      'Accept': 'application/xml'
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