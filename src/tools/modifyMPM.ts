import { ModifyMPMInput } from '../types';
import { generateRenderHash, ensureRendersDirectory } from '../utils/fileSystem';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

/**
 * Modify MPM (exaggerate/increase) via external Modify program.
 * @returns Modified MPM file path
 */
export async function modifyMPM({ mpmPath, modifiers }: ModifyMPMInput): Promise<string> {
  if (!fs.existsSync(mpmPath)) {
    throw new Error(`MPM file not found: ${mpmPath}`);
  }

  ensureRendersDirectory();

  // Generate hash for output filename
  const hash = generateRenderHash({ mpmPath, modifiers });
  const outputPath = path.join(process.cwd(), 'renders', `${hash}.mpm`);

  // Check if already exists (caching)
  if (fs.existsSync(outputPath)) {
    return outputPath
  }

  try {
    // Prepare MPM-modifier command
    const mpmModifierBin = process.env.MODIFY_BIN;
    if (!mpmModifierBin) {
      throw new Error('MPM-modifier binary path not set in MODIFY_BIN environment variable');
    }

    const modifiersFilePath = path.join(process.cwd(), 'renders', `${hash}.modifiers.json`);
    try {
      fs.writeFileSync(modifiersFilePath, JSON.stringify(modifiers, null, 2), 'utf8');
      console.log(`Saved modifiers JSON to ${modifiersFilePath}`);
    } catch (err) {
      throw new Error(`Failed to write modifiers JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    const command = `${mpmModifierBin} --in ${mpmPath} --params ${modifiersFilePath} --out ${outputPath}`;

    console.log(`Executing: ${command}`);
    execSync(command, { stdio: 'inherit' });

    console.log('MPM modification completed successfully');

    if (!fs.existsSync(outputPath)) {
      throw new Error('MPM-modifier did not produce output file');
    }

    return outputPath
  } catch (error) {
    console.log(`Error: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error(`MPM modification failed`);
  }
}
