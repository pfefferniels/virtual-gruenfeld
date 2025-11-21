import { JSDOM } from 'jsdom'
import { Location } from '../api/lesson';

const DOMParser = new JSDOM().window.DOMParser;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const asMSM = async (mei: string, _voicesAsParts: boolean = false) => {
    const response = await fetch(`http://localhost:8080/convert`, {
        method: 'POST',
        body: JSON.stringify({
            mei
        })
    })
    if (!response.ok) {
        throw new Error(`Failed to convert MEI to MSM: ${response.statusText}`)
    }

    const json = await response.json()

    // console.log('msm=', json.msm)
    const msmDoc = new DOMParser().parseFromString(json.msm, 'application/xml')

    return msmDoc;
}

export interface ExtractedInfo {
  ppq: number;
  timeSignatures: { date: number; numerator: number; denominator: number }[];
  sections: { start: number; end: number; isRepeat: boolean }[];
}

/**
 * Extract and preprocess relevant MSM info once.
 */
export function extractInfo(doc: Document): ExtractedInfo {
  // ---- pulsesPerQuarter ----
  const msmEl = doc.querySelector("msm");
  if (!msmEl) throw new Error("Invalid MSM XML: missing <msm>.");
  const ppq = parseFloat(msmEl.getAttribute("pulsesPerQuarter") || "0");
  if (!(ppq > 0)) throw new Error("Invalid pulsesPerQuarter.");

  // ---- time signatures ----
  const timeSignatures = Array.from(doc.querySelectorAll("timeSignatureMap > timeSignature"))
    .map((el) => ({
      date: parseFloat(el.getAttribute("date") || "0"),
      numerator: parseFloat(el.getAttribute("numerator") || "4"),
      denominator: parseFloat(el.getAttribute("denominator") || "4"),
    }))
    .sort((a, b) => a.date - b.date);

  // ---- sections ----
  const sections = Array.from(doc.querySelectorAll("sectionMap > section")).map((el) => {
    const start = parseFloat(el.getAttribute("date") || "0");
    const end = parseFloat(el.getAttribute("date.end") || "Infinity");
    const id = el.getAttribute("xml:id") || "";
    return { start, end, isRepeat: id.endsWith("-rend2") };
  });

  return { ppq, timeSignatures, sections };
}

/**
 * Compute measure + beat for a given date and return
 * { measure, beat, inRepeat } where:
 *  - measure: 1-based global measure index
 *  - beat: 1-based beat index within the bar (1..numerator)
 *  - inRepeat: true if inside a repeat section
 */
export function getMeasureForDate(
  info: ExtractedInfo,
  date: number
): Location {
  const { ppq, timeSignatures, sections } = info;
  if (!Number.isFinite(date)) throw new Error("date must be a number. Received " + date);

  if (!timeSignatures.length) {
    throw new Error("timeSignatures must contain at least one entry.");
  }

  // ---- find active time signature ----
  let ts = timeSignatures[0];
  for (let i = 1; i < timeSignatures.length; i++) {
    if (timeSignatures[i].date <= date) ts = timeSignatures[i];
    else break;
  }

  // ---- compute beat & measure duration ----
  const beatDur = ppq * (4 / ts.denominator);         // duration of one beat
  const measureDur = ts.numerator * beatDur;          // duration of one measure

  // ---- sum measures before current TS segment ----
  let measuresBefore = 0;
  for (let i = 0; i < timeSignatures.length; i++) {
    const t = timeSignatures[i];
    const next = timeSignatures[i + 1];
    if (next && next.date <= date) {
      const segDur = next.date - t.date;
      const segBeatDur = ppq * (4 / t.denominator);
      const segMeasureDur = t.numerator * segBeatDur;
      measuresBefore += Math.floor(segDur / segMeasureDur);
    } else {
      break;
    }
  }

  // ---- measure index in current TS ----
  const offset = date - ts.date;
  const measureInSegment = Math.floor(offset / measureDur); // 0-based within segment
  const measureNumber = measuresBefore + measureInSegment + 1; // 1-based global

  // ---- beat index within current measure ----
  const offsetWithinMeasure = offset - measureInSegment * measureDur; // same as offset % measureDur
  const beatInMeasure = Math.floor(offsetWithinMeasure / beatDur);    // 0-based
  const beat = beatInMeasure + 1;                                     // 1-based: 1..ts.numerator

  // ---- repetition check ----
  const inRepeat = sections.some(
    (s) => s.isRepeat && date >= s.start && date < s.end
  );

  return { measure: measureNumber - 1, beat, inRepeat };
}
