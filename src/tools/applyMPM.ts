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
  const { reconstruction, ids, mpmPath } = input;

  const paths = getReconstructionPaths(reconstruction);
  const effectiveMpmPath = mpmPath || paths.performance;

  if (!fs.existsSync(paths.score)) {
    throw new Error(`MEI score not found: ${paths.score}`);
  }

  if (!fs.existsSync(effectiveMpmPath)) {
    throw new Error(`MPM file not found: ${effectiveMpmPath}`);
  }

  ensureRendersDirectory();

  // Generate hash for output filenames
  const hash = generateRenderHash({ reconstruction, ids, mpmPath: effectiveMpmPath });
  const midiPath = path.join(process.cwd(), 'renders', `${hash}`); // no extension, meico adds .mid
  const mp3Path = path.join(process.cwd(), 'renders', `${hash}.mp3`);
  const rangesPath = path.join(process.cwd(), 'renders', `${hash}_ranges.json`);
  const soundfont = path.join(process.cwd(), 'soundfont', 'piano.sf2');

  // Check if already exists (caching)
  if (fs.existsSync(mp3Path)) {
    return { mp3Path, rangesPath };
  }

  const meicoBin = process.env.PERFORM_BIN
  const pianoteqBin = process.env.PIANOTEQ_BIN

  if (!meicoBin) {
    throw new Error('meico bin does not exist')
  }

  let command = `${meicoBin} --mei ${paths.score} --mpm ${mpmPath} --out ${midiPath} --soundfont ${soundfont} --ranges ${rangesPath}`;
  if (ids.length > 0) {
    command += ` --ids ${ids.join(',')}`;
  }

  console.log('Running: ', command);
  execSync(command, { stdio: 'inherit' });

  /*
  command = `${pianoteqBin} --midi ${midiPath}.mid --mp3 ${mp3Path} --preset "J.B. Streicher"`;
  console.log('Running: ', command);
  execSync(command, { stdio: 'inherit' });
  */

  return { mp3Path: midiPath, rangesPath };
}
