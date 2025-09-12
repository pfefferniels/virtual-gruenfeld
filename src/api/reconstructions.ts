import express from 'express';
import { listAvailableReconstructions } from '../utils/fileSystem';

export const reconstructionsRouter = express.Router();

/**
 * GET /api/reconstructions
 * Returns list of available reconstructions
 */
reconstructionsRouter.get('/', (req, res) => {
  try {
    const result = listAvailableReconstructions();
    res.json(result);
  } catch (error) {
    console.error('Error listing reconstructions:', error);
    res.status(500).json({ 
      error: 'Failed to list reconstructions',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});