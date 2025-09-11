import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ReconId, ReconInfo } from '../types';

/**
 * Utility function to list available reconstructions
 */
export function listAvailableReconstructions(): ReconInfo[] {
  const assetsPath = path.join(process.cwd(), 'assets');
  
  if (!fs.existsSync(assetsPath)) {
    return [];
  }

  const reconstructions: ReconInfo[] = [];
  const entries = fs.readdirSync(assetsPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const infoJsonPath = path.join(assetsPath, entry.name, 'info.json');
      
      if (fs.existsSync(infoJsonPath)) {
        try {
          const infoData = JSON.parse(fs.readFileSync(infoJsonPath, 'utf8'));
          reconstructions.push({
            id: entry.name,
            label: infoData.label || entry.name
          });
        } catch (error) {
          console.warn(`Failed to parse info.json for ${entry.name}:`, error);
        }
      }
    }
  }

  return reconstructions;
}

/**
 * Get reconstruction info by ID
 */
export function getReconstructionInfo(reconId: ReconId): ReconInfo | null {
  const infoJsonPath = path.join(process.cwd(), 'assets', reconId, 'info.json');
  
  if (!fs.existsSync(infoJsonPath)) {
    return null;
  }

  try {
    const infoData = JSON.parse(fs.readFileSync(infoJsonPath, 'utf8'));
    return {
      id: reconId,
      label: infoData.label || reconId
    };
  } catch (error) {
    console.error(`Failed to read reconstruction info for ${reconId}:`, error);
    return null;
  }
}

/**
 * Get file paths for a reconstruction
 */
export function getReconstructionPaths(reconId: ReconId) {
  const basePath = path.join(process.cwd(), 'assets', reconId);
  
  return {
    score: path.join(basePath, 'score.mei'),
    performance: path.join(basePath, 'performance.mpm'),
    info: path.join(basePath, 'info.json')
  };
}

/**
 * Validate reconstruction exists and has required files
 */
export function validateReconstruction(reconId: ReconId): boolean {
  const paths = getReconstructionPaths(reconId);
  
  return fs.existsSync(paths.score) && 
         fs.existsSync(paths.performance) && 
         fs.existsSync(paths.info);
}

/**
 * Generate hash for caching rendered files
 */
export function generateRenderHash(data: any): string {
  return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
}

/**
 * Ensure renders directory exists
 */
export function ensureRendersDirectory(): void {
  const rendersPath = path.join(process.cwd(), 'renders');
  if (!fs.existsSync(rendersPath)) {
    fs.mkdirSync(rendersPath, { recursive: true });
  }
}