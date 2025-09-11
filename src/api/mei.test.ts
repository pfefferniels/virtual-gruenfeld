import request from 'supertest';
import express from 'express';
import { meiRouter } from '../api/mei';
import fs from 'fs';
import path from 'path';

// Create a test app with just the MEI router
const app = express();
app.use('/api/mei', meiRouter);

describe('MEI API Endpoint', () => {
  describe('GET /api/mei/:reconId', () => {
    test('should serve MEI file for valid reconstruction ID', async () => {
      const response = await request(app)
        .get('/api/mei/reconstruction')
        .expect(200);
      
      expect(response.headers['content-type']).toMatch(/application\/xml/);
      expect(response.headers['cache-control']).toBe('public, max-age=3600');
      expect(response.text).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(response.text).toContain('<mei xmlns="http://www.music-encoding.org/ns/mei"');
    });

    test('should serve MEI file for harmonic_reduction', async () => {
      const response = await request(app)
        .get('/api/mei/harmonic_reduction')
        .expect(200);
      
      expect(response.headers['content-type']).toMatch(/application\/xml/);
      expect(response.text).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(response.text).toContain('<mei xmlns="http://www.music-encoding.org/ns/mei"');
    });

    test('should return 404 for non-existent reconstruction', async () => {
      const response = await request(app)
        .get('/api/mei/nonexistent')
        .expect(404);
      
      expect(response.body).toEqual({
        error: 'MEI file not found',
        reconId: 'nonexistent'
      });
    });

    test('should prevent directory traversal attacks', async () => {
      // Note: Express URL decodes the parameters, so .. in the URL becomes .. in the param
      const response = await request(app)
        .get('/api/mei/..%2F..%2F..%2Fetc%2Fpasswd')
        .expect(400);
      
      expect(response.body).toEqual({
        error: 'Invalid reconstruction ID'
      });
    });

    test('should prevent path traversal with encoded characters', async () => {
      const response = await request(app)
        .get('/api/mei/..%2F..%2F..%2Fetc%2Fpasswd')
        .expect(400);
      
      expect(response.body).toEqual({
        error: 'Invalid reconstruction ID'
      });
    });
  });
});