import * as fs from 'fs';
import path from 'path';
import { loadVerovio } from '../loadVerovio.mjs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

export const loadMEI = async (reconstruction: string): Promise<string> => {
  const meiPath = path.join(process.cwd(), 'assets', reconstruction, 'score.mei');

  if (!fs.existsSync(meiPath)) {
    throw new Error(`MEI file not found`);
  }

  const meiContent = fs.readFileSync(meiPath, 'utf8');

  const tk = await loadVerovio();
  tk.loadData(meiContent);
  const timemap = tk.renderToTimemap();

  const doc = new DOMParser().parseFromString(meiContent, 'application/xml');
  const allNotes = Array.from(doc.getElementsByTagName('note'));

  for (const entry of timemap) {
    const qstamp = entry.qstamp;
    for (const on of entry.on ?? []) {
      const el = allNotes.find(e => e.getAttribute('xml:id') === on);
      if (el) {
        el.setAttribute('qstamp', qstamp.toString());
      }
    }
  }

  return new XMLSerializer().serializeToString(doc);
}
