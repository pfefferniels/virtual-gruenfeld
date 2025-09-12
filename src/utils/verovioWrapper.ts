import * as fs from 'fs';
import path from 'path';
import { loadVerovio } from '../loadVerovio.mjs';

export const loadHumdrum = async (reconstruction: string): Promise<string> => {
  const meiPath = path.join(process.cwd(), 'assets', reconstruction, 'score.mei');

  console.log('reading mei from', meiPath)

  if (!fs.existsSync(meiPath)) {
    throw new Error(`MEI file not found`);
  }

  const meiContent = fs.readFileSync(meiPath, 'utf8');
  return meiContent
}
