import express from 'express';
import path from 'path';
import fs from 'fs';

export const meiRouter = express.Router();

/**
 * GET /api/mei/:reconId
 * Serves MEI score files for the specified reconstruction
 */
meiRouter.get('/:reconId', (req, res) => {
  const reconId = req.params.reconId;
  
  // Security check: prevent directory traversal and normalize path
  const normalizedReconId = path.normalize(reconId);
  if (normalizedReconId.includes('..') || normalizedReconId.includes('/') || normalizedReconId.includes('\\') || normalizedReconId !== reconId) {
    return res.status(400).json({ error: 'Invalid reconstruction ID' });
  }
  
  // Construct path to MEI file
  const meiPath = path.join(process.cwd(), 'assets', reconId, 'score.mei');
  
  // Check if file exists
  if (!fs.existsSync(meiPath)) {
    return res.status(404).json({ 
      error: 'MEI file not found',
      reconId: reconId
    });
  }
  
  try {
    // Read and serve the MEI file
    const meiContent = fs.readFileSync(meiPath, 'utf8');
    
    // Set appropriate content type for MEI/XML
    res.contentType('application/xml');
    
    // Add cache headers for score files
    res.set('Cache-Control', 'public, max-age=3600'); // 1 hour cache
    
    // Send the MEI content
    res.send(meiContent);
    
  } catch (error) {
    console.error('Error reading MEI file:', error);
    res.status(500).json({ 
      error: 'Failed to read MEI file',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});