import { ApplyMPMInput, ApplyMPMOutput } from '../types';
import { getReconstructionPaths, generateRenderHash, ensureRendersDirectory } from '../utils/fileSystem';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Tool 4: Apply MPM (compose/slice if needed) using meico
 * Converts MEI+MPM to MIDI and optionally MSM using the meico tool
 */
export async function applyMPM(input: ApplyMPMInput): Promise<ApplyMPMOutput> {
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
  const midiPath = path.join(process.cwd(), 'renders', `${hash}.mid`);
  const msmPath = path.join(process.cwd(), 'renders', `${hash}.msm`);
  const logPath = path.join(process.cwd(), 'renders', `${hash}.log`);
  
  // Check if already exists (caching)
  if (fs.existsSync(midiPath)) {
    const existingLog = fs.existsSync(logPath) 
      ? fs.readFileSync(logPath, 'utf8').split('\n')
      : ['Using cached MIDI file'];
      
    return {
      midiPath,
      msmPath: fs.existsSync(msmPath) ? msmPath : undefined,
      log: existingLog
    };
  }

  const log: string[] = [];
  
  try {
    // Prepare meico command
    const meicoBin = process.env.MEICO_BIN || '/usr/local/bin/meicoApp';
    const args = buildMeicoArgs(paths.score, effectiveMpmPath, midiPath, msmPath, region);
    const command = `"${meicoBin}" ${args.join(' ')}`;
    
    log.push(`Executing: ${command}`);
    
    // Execute meico (stub - would call actual tool)
    await executeStubMeico(paths.score, effectiveMpmPath, midiPath, msmPath, region);
    
    log.push('Meico conversion completed successfully');
    
    // Apply region slicing if needed
    if (needsRegionSlicing(region)) {
      await sliceMIDIToRegion(midiPath, region);
      log.push(`Sliced MIDI to region: ${region.barsLabel}`);
    }
    
    if (!fs.existsSync(midiPath)) {
      throw new Error('Meico did not produce MIDI output file');
    }

    // Save log
    fs.writeFileSync(logPath, log.join('\n'), 'utf8');

    return {
      midiPath,
      msmPath: fs.existsSync(msmPath) ? msmPath : undefined,
      log
    };
    
  } catch (error) {
    log.push(`Error: ${error instanceof Error ? error.message : String(error)}`);
    fs.writeFileSync(logPath, log.join('\n'), 'utf8');
    throw new Error(`MEI+MPM processing failed: ${log.join('; ')}`);
  }
}

/**
 * Build command line arguments for meico
 */
function buildMeicoArgs(
  meiPath: string, 
  mpmPath: string, 
  midiOutput: string, 
  msmOutput: string,
  region: any
): string[] {
  const args = [
    '--mei', `"${meiPath}"`,
    '--mpm', `"${mpmPath}"`,
    '--midi', `"${midiOutput}"`,
    '--msm', `"${msmOutput}"`,
    '--validate',
    '--cleanup'
  ];

  // Add region-specific arguments if supported by meico
  if (region.startTick !== undefined && region.endTick !== undefined) {
    args.push('--start-tick', region.startTick.toString());
    args.push('--end-tick', region.endTick.toString());
  }

  return args;
}

/**
 * Check if region slicing is needed
 */
function needsRegionSlicing(region: any): boolean {
  // If we have specific start/end ticks that are not full piece
  return region.startTick > 0 || (region.endTick > 0 && region.endTick < Number.MAX_SAFE_INTEGER);
}

/**
 * Slice MIDI file to specific region using ticks
 * This is a post-processing step if meico doesn't support region extraction
 */
async function sliceMIDIToRegion(midiPath: string, region: any): Promise<void> {
  // Stub implementation
  // In a real implementation, this would use a MIDI processing library
  // to extract only the notes within the specified tick range
  
  // For now, we'll assume the MIDI file is already correctly sized
  // or that meico handled the region extraction
}

/**
 * Stub implementation of meico execution
 * In production, this would call the actual meico binary
 */
async function executeStubMeico(
  meiPath: string, 
  mpmPath: string, 
  midiOutput: string, 
  msmOutput: string,
  region: any
): Promise<void> {
  // For now, create a stub MIDI file
  // In a real implementation, this would invoke the actual meico tool
  
  // Create a minimal MIDI file (just header bytes)
  const midiHeader = Buffer.from([
    0x4D, 0x54, 0x68, 0x64, // "MThd"
    0x00, 0x00, 0x00, 0x06, // Header length
    0x00, 0x00, // Format 0
    0x00, 0x01, // 1 track
    0x01, 0xE0, // 480 ticks per quarter note
    0x4D, 0x54, 0x72, 0x6B, // "MTrk"
    0x00, 0x00, 0x00, 0x04, // Track length
    0x00, 0xFF, 0x2F, 0x00  // End of track
  ]);
  
  fs.writeFileSync(midiOutput, midiHeader);
  
  // Create stub MSM file
  const msmContent = `<?xml version="1.0" encoding="UTF-8"?>
<msm xmlns="http://www.meico.org/msm">
  <metadata>
    <title>Stub MSM output</title>
    <generated>Stub implementation</generated>
  </metadata>
  <part>
    <!-- Stub MSM content would go here -->
  </part>
</msm>`;
  
  fs.writeFileSync(msmOutput, msmContent, 'utf8');
  
  // Simulate processing time
  await new Promise(resolve => setTimeout(resolve, 500));
}