import express from 'express';
import { ChatRequest } from '../types';
import { Pianist } from '../agent/Pianist';

export const chatRouter = express.Router();

// Conversation contexts per session
const conversations = new Map<string, Pianist>();

/**
 * POST /api/chat
 * Main chat endpoint for conversing with the virtual pianist
 */
chatRouter.post('/', async (req, res) => {
  try {
    const chatRequest: ChatRequest = req.body;
    const { message, selection } = chatRequest;
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }
    
    // Get or create conversation context
    const sessionId = req.headers['x-session-id'] as string || 'default';
    const context = conversations.get(sessionId) || new Pianist([])
        
    // Process the message
    const response = await context.processMessage(message, selection);
    res.json(response);
    
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ 
      error: 'Failed to process message',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});