import { ApplyMPMInput, ApplyMPMOutput } from '../types';
import { getReconstructionPaths, generateRenderHash, ensureRendersDirectory } from '../utils/fileSystem';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

/**
 * Tool 4: Apply MPM (compose/slice if needed) using meico
 * Converts MEI+MPM to MIDI and optionally MSM using the meico tool
 */
export async function generateMP3(input: ApplyMPMInput): Promise<ApplyMPMOutput> {
  const { reconId, region, mpmPath } = input;

  const paths = getReconstructionPaths(reconId);
  const effectiveMpmPath = mpmPath || paths.performance;

  if (!fs.existsSync(paths.score)) {
    throw new Error(`MEI score not found: ${paths.score}`);
  }

  if (!fs.existsSync(effectiveMpmPath)) {
    throw new Error(`MPM file not found: ${effectiveMpmPath}`);
  }

  ensureRendersDirectory();

  // Generate hash for output filenames
  const hash = generateRenderHash({ reconId, region, mpmPath: effectiveMpmPath });
  const mp3Path = path.join(process.cwd(), 'renders', `${hash}.mp3`);

  // Check if already exists (caching)
  if (fs.existsSync(mp3Path)) {
    return { mp3Path };
  }

  const meicoBin = process.env.MEICO_BIN

  if (!meicoBin) {
    throw new Error('meico bin does not exist')
  }

  // This would be the actual meico command for tick extraction
  // The exact parameters will be defined later as mentioned in the problem statement

  // For now, create a framework that shows the intended structure
  const command = `${meicoBin} --mei ${paths.score} --mpm ${mpmPath} --ids ${region.meiXmlIds.join(',')} --out ${mp3Path}`;
  execSync(command, { stdio: 'inherit' });

  return { mp3Path };
}
