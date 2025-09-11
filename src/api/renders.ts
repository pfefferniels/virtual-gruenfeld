import express from 'express';
import path from 'path';
import fs from 'fs';

export const rendersRouter = express.Router();

/**
 * GET /renders/:filename
 * Serves rendered audio files, MIDI files, etc.
 */
rendersRouter.get('/:filename', (req, res) => {
  const filename = req.params.filename;
  
  // Security check: prevent directory traversal
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  
  const filePath = path.join(process.cwd(), 'renders', filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  // Set appropriate content type based on extension
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.mp3':
      res.contentType('audio/mpeg');
      break;
    case '.wav':
      res.contentType('audio/wav');
      break;
    case '.mid':
    case '.midi':
      res.contentType('audio/midi');
      break;
    case '.mpm':
      res.contentType('application/xml');
      break;
    case '.msm':
      res.contentType('application/xml');
      break;
    case '.log':
      res.contentType('text/plain');
      break;
    default:
      res.contentType('application/octet-stream');
  }
  
  // Add cache headers for audio files
  if (['.mp3', '.wav'].includes(ext)) {
    res.set('Cache-Control', 'public, max-age=3600'); // 1 hour cache
  }
  
  res.sendFile(filePath);
});