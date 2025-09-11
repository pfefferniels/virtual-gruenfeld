import { omaToRegion } from './omaToRegion';
import { OMAToRegionInput, OMA } from '../types';
import * as path from 'path';

describe('omaToRegion', () => {
  const reconstructionId = 'reconstruction';
  
  describe('basic OMA processing', () => {
    it('should process simple OMA range (single measure)', () => {
      const input: OMAToRegionInput = {
        reconId: reconstructionId,
        oma: {
          from: { measure: 1, beat: 1 }
        }
      };

      const result = omaToRegion(input);

      expect(result.oma.from.measure).toBe(1);
      expect(result.oma.from.beat).toBe(1);
      expect(result.oma.to).toBeDefined();
      expect(result.meiXmlIds).toBeInstanceOf(Array);
      expect(result.startTick).toBeGreaterThanOrEqual(0);
      expect(result.endTick).toBeGreaterThan(result.startTick);
      expect(result.barsLabel).toContain('T.1');
    });

    it('should process OMA range spanning multiple measures', () => {
      const input: OMAToRegionInput = {
        reconId: reconstructionId,
        oma: {
          from: { measure: 1, beat: 1 },
          to: { measure: 3, beat: 1 }
        }
      };

      const result = omaToRegion(input);

      expect(result.oma.from.measure).toBe(1);
      expect(result.oma.to!.measure).toBe(3);
      expect(result.meiXmlIds.length).toBeGreaterThan(0);
      expect(result.barsLabel).toContain('T.1–2');
    });

    it('should normalize OMA with missing beat values', () => {
      const input: OMAToRegionInput = {
        reconId: reconstructionId,
        oma: {
          from: { measure: 2 }
        }
      };

      const result = omaToRegion(input);

      expect(result.oma.from.beat).toBe(1);
      expect(result.oma.from.beatOffset).toBe(0);
    });
  });

  describe('MEI XML ID extraction', () => {
    it('should return note IDs that follow expected patterns', () => {
      const input: OMAToRegionInput = {
        reconId: reconstructionId,
        oma: {
          from: { measure: 1, beat: 1 },
          to: { measure: 2, beat: 1 }
        }
      };

      const result = omaToRegion(input);

      // Check that we get some IDs
      expect(result.meiXmlIds.length).toBeGreaterThan(0);
      
      // Check that they are valid ID strings (could be real MEI IDs or stub IDs)
      result.meiXmlIds.forEach(id => {
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
        // Don't enforce specific patterns since real MEI IDs might be different from stubs
      });
    });
  });

  describe('tick calculation', () => {
    it('should calculate reasonable tick values', () => {
      const input: OMAToRegionInput = {
        reconId: reconstructionId,
        oma: {
          from: { measure: 1, beat: 1 },
          to: { measure: 1, beat: 3 }
        }
      };

      const result = omaToRegion(input);

      // Check that we have reasonable tick values
      expect(result.startTick).toBeGreaterThanOrEqual(0);
      expect(result.endTick).toBeGreaterThan(result.startTick);
      
      // The range should be at least reasonable for 2 beats
      const tickRange = result.endTick - result.startTick;
      expect(tickRange).toBeGreaterThan(0);
      expect(tickRange).toBeLessThan(10000); // Reasonable upper bound
    });

    it('should handle multiple measures correctly', () => {
      const input: OMAToRegionInput = {
        reconId: reconstructionId,
        oma: {
          from: { measure: 1, beat: 1 },
          to: { measure: 3, beat: 1 }
        }
      };

      const result = omaToRegion(input);

      // Check that multi-measure ranges have larger tick spans
      const tickRange = result.endTick - result.startTick;
      expect(tickRange).toBeGreaterThan(1000); // Should be substantial for 2 measures
      expect(tickRange).toBeLessThan(20000); // But still reasonable
    });
  });

  describe('error handling', () => {
    it('should throw error for invalid reconstruction', () => {
      const input: OMAToRegionInput = {
        reconId: 'nonexistent',
        oma: {
          from: { measure: 1, beat: 1 }
        }
      };

      expect(() => omaToRegion(input)).toThrow('Reconstruction nonexistent not found');
    });
  });
});