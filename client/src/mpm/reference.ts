/**
 * Grünfeld's performance, as the document it already is.
 *
 * `performance.mpm` is the mpm-desk snapshot of the Welte roll reconstruction — the same
 * file the server's corpus reads out of `assets/all/`, copied verbatim into `client/public/`
 * so the browser can fetch it (the copy's byte-identity is asserted by `reference.test.ts`;
 * the server keeps reading the `assets/` original).
 *
 * It replaces the boot-time rebuild from `info.json`: instead of replaying 494 transformer
 * calls to *manufacture* instruction ids, the client reads the ids the document prints —
 * `<tempo xml:id="tempo_720" date="720" endDate="2160" bpm="76.15" …>`. Those deterministic
 * `${type}_${date}` ids are the scaffold the student's performance is later written into,
 * which is why the reference is never rebaked: a rebake would lose `@corresp` (the corpus
 * argumentation links) and `@endDate`.
 *
 * The document crosses every module boundary as XML **text**; `parseReferenceMpm` is for
 * the one caller that needs the object model, and hands back a fresh `Mpm` every time so
 * no one can mutate a shared reference.
 */
import { Mpm } from 'espressivo';
import { PPQ } from '../shared/constants';

/** Where the browser fetches it from — `client/public/performance.mpm`, served at the app root. */
export const REFERENCE_MPM_URL = 'performance.mpm';

let pending: Promise<string> | null = null;

const fetchReferenceMpm = async (): Promise<string> => {
    const response = await fetch(REFERENCE_MPM_URL);
    if (!response.ok) {
        throw new Error(`FETCH ${REFERENCE_MPM_URL}: HTTP ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    if (text.trim().length === 0) throw new Error(`FETCH ${REFERENCE_MPM_URL}: empty document`);
    return text;
};

/**
 * The reference performance as MPM text, fetched once per session.
 *
 * Memoized like `mpmRenderer`'s MEI→MSM conversion: 150 kB that never changes. A failed
 * fetch is *not* memoized, so a boot that lost the network can simply ask again.
 */
export const loadReferenceMpm = (): Promise<string> => {
    pending ??= fetchReferenceMpm().catch((error: unknown) => {
        pending = null;
        throw error;
    });
    return pending;
};

/** Drop the memoized document. For tests, and for a re-boot that must re-fetch. */
export const forgetReferenceMpm = (): void => {
    pending = null;
};

/**
 * Text → `Mpm`, with the three checks every consumer would otherwise repeat: the document
 * parses, it carries a performance, and its tick grid is the 720 ppq that `tickToPos`, the
 * corpus spans and the matcher all assume. Malformed source throws out of `new Mpm` itself.
 */
export const parseReferenceMpm = (text: string): Mpm => {
    const mpm = new Mpm(text);
    if (mpm.isEmpty()) throw new Error('MPM: not a well-formed document');

    const performance = mpm.getPerformance(0);
    if (!performance) throw new Error('MPM: no performance in the reference document');

    const ppq = performance.getPulsesPerQuarter();
    if (ppq !== PPQ) throw new Error(`MPM: reference is on ${ppq} ppq, this project speaks ${PPQ}`);

    return mpm;
};
