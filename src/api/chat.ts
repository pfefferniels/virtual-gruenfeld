import express from 'express';
import { ChatRequest, ChatResponse, ConversationContext } from '../types';
import { PianistAgent } from '../agent/pianistAgent';

export const chatRouter = express.Router();

// Simple in-memory conversation contexts (in production, use proper session management)
const conversations = new Map<string, ConversationContext>();

/**
 * POST /api/chat
 * Main chat endpoint for conversing with the virtual pianist
 */
chatRouter.post('/', async (req, res) => {
  try {
    const chatRequest: ChatRequest = req.body;
    const { message, reconId = 'reconstruction', locale = 'de' } = chatRequest;
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required' });
    }
    
    // Get or create conversation context
    const sessionId = req.headers['x-session-id'] as string || 'default';
    const context = conversations.get(sessionId) || {
      currentReconId: reconId,
      lastRegion: undefined
    };
    
    // Initialize the pianist agent
    const agent = new PianistAgent(context);
    
    // Process the message
    const response = await agent.processMessage(message, locale);
    
    // Update conversation context
    conversations.set(sessionId, agent.getContext());
    
    res.json(response);
    
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ 
      error: 'Failed to process message',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});