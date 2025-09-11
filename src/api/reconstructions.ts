import express from 'express';
import { listReconstructions } from '../tools/listReconstructions';

export const reconstructionsRouter = express.Router();

/**
 * GET /api/reconstructions
 * Returns list of available reconstructions
 */
reconstructionsRouter.get('/', (req, res) => {
  try {
    const result = listReconstructions();
    res.json(result);
  } catch (error) {
    console.error('Error listing reconstructions:', error);
    res.status(500).json({ 
      error: 'Failed to list reconstructions',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});