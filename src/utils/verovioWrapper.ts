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
  const timemap = tk.renderToTimemap({ includeMeasures: true });

  const doc = new DOMParser().parseFromString(meiContent, 'application/xml');
  const allNotes = Array.from(doc.getElementsByTagName('note'));

  const measureStarts = timemap
    .filter((e: any) => 'measureOn' in e)
    .map(e => e.qstamp)
    .sort((a, b) => a - b);

  for (const entry of timemap) {
    const qstamp = entry.qstamp;
    const lastMeasureStart = measureStarts.slice().reverse().find(ms => ms <= qstamp);
    const tstamp = lastMeasureStart !== undefined ? (qstamp - lastMeasureStart + 1) : qstamp;

    for (const on of entry.on ?? []) {
      const el = allNotes.find(e => e.getAttribute('xml:id') === on);
      if (el) {
        el.setAttribute('tstamp', tstamp.toString());
      }
    }
  }

  return new XMLSerializer().serializeToString(doc);
}
