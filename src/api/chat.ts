import express from 'express';
import { ChatRequest } from '../types';
import { PianistAgent } from '../agent/PianistAgent';

export const chatRouter = express.Router();

// Simple in-memory conversation contexts (in production, use proper session management)
const conversations = new Map<string, PianistAgent>();

/**
 * POST /api/chat
 * Main chat endpoint for conversing with the virtual pianist
 */
chatRouter.post('/', async (req, res) => {
  try {
    const chatRequest: ChatRequest = req.body;
    const { message } = chatRequest;
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }
    
    // Get or create conversation context
    const sessionId = req.headers['x-session-id'] as string || 'default';
    const context = conversations.get(sessionId) || new PianistAgent({
      reconstruction: 'reconstruction',
    })
        
    // Process the message
    const response = await context.processMessage(message);
    res.json(response);
    
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ 
      error: 'Failed to process message',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});