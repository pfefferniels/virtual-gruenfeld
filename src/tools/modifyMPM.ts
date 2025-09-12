import { ModifyMPMInput, ModifyMPMOutput } from '../types';
import { generateRenderHash, ensureRendersDirectory } from '../utils/fileSystem';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Tool 5: Modify MPM (exaggerate/hide/tempo) via MPM-modifier
 * Uses external MPM-modifier tool to apply performance modifications
 */
export async function modifyMPM(input: ModifyMPMInput): Promise<ModifyMPMOutput> {
  const { mpmPath, modifiers } = input;
  
  if (!fs.existsSync(mpmPath)) {
    throw new Error(`MPM file not found: ${mpmPath}`);
  }

  ensureRendersDirectory();
  
  // Generate hash for output filename
  const hash = generateRenderHash({ mpmPath, modifiers });
  const outputPath = path.join(process.cwd(), 'renders', `${hash}.mpm`);
  
  // Check if already exists (caching)
  if (fs.existsSync(outputPath)) {
    return {
      mpmPath: outputPath,
      log: ['Using cached modified MPM file']
    };
  }

  const log: string[] = [];
  
  try {
    // Prepare MPM-modifier command
    const mpmModifierBin = process.env.MPM_MOD_BIN || '/usr/local/bin/mpm-modifier';
    const args = buildMPMModifierArgs(mpmPath, outputPath, modifiers);
    const command = `"${mpmModifierBin}" ${args.join(' ')}`;
    
    log.push(`Executing: ${command}`);
    
    // Execute MPM-modifier (stub - would call actual tool)
    await executeStubMPMModifier(mpmPath, outputPath, modifiers);
    
    log.push('MPM modification completed successfully');
    
    if (!fs.existsSync(outputPath)) {
      throw new Error('MPM-modifier did not produce output file');
    }

    return {
      mpmPath: outputPath,
      log
    };
    
  } catch (error) {
    log.push(`Error: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error(`MPM modification failed: ${log.join('; ')}`);
  }
}

/**
 * Build command line arguments for MPM-modifier
 */
function buildMPMModifierArgs(inputPath: string, outputPath: string, modifiers: any): string[] {
  const args = [
    '--input', `"${inputPath}"`,
    '--output', `"${outputPath}"`
  ];

  // Dynamics exaggeration
  if (modifiers.exaggerate?.dynamics) {
    args.push('--exaggerate-dynamics', modifiers.exaggerate.dynamics.toString());
  }

  // Rubato exaggeration
  if (modifiers.exaggerate?.rubato) {
    args.push('--exaggerate-rubato', modifiers.exaggerate.rubato.toString());
  }

  // Articulation exaggeration
  if (modifiers.exaggerate?.articulation) {
    args.push('--exaggerate-articulation', modifiers.exaggerate.articulation.toString());
  }

  // Tempo scaling
  if (modifiers.tempo?.factor) {
    args.push('--tempo-factor', modifiers.tempo.factor.toString());
  }

  // Hide parameters
  if (modifiers.hide?.dynamics) {
    args.push('--hide-dynamics');
  }
  if (modifiers.hide?.rubato) {
    args.push('--hide-rubato');
  }
  if (modifiers.hide?.articulation) {
    args.push('--hide-articulation');
  }

  return args;
}

/**
 * Stub implementation of MPM-modifier execution
 * In production, this would call the actual MPM-modifier binary
 */
async function executeStubMPMModifier(inputPath: string, outputPath: string, modifiers: any): Promise<void> {
  // For now, just copy the input file to output with some modifications
  // In a real implementation, this would invoke the actual MPM-modifier tool
  
  const inputContent = fs.readFileSync(inputPath, 'utf8');
  
  // Simple stub: just copy the file for now
  // Real implementation would parse and modify the MPM XML
  let modifiedContent = inputContent;
  
  // Add a comment to indicate modification
  const modificationNote = `<!-- Modified with: ${JSON.stringify(modifiers)} -->`;
  modifiedContent = modifiedContent.replace('<?xml version="1.0"', `<?xml version="1.0"\n${modificationNote}`);
  
  fs.writeFileSync(outputPath, modifiedContent, 'utf8');
  
  // Simulate processing time
  await new Promise(resolve => setTimeout(resolve, 100));
}