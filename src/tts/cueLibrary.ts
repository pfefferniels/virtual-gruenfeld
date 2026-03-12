import fs from 'fs';
import path from 'path';

const CUE_LIBRARY_PATH = path.resolve(process.cwd(), 'server/cue-library.json');
let cueLibraryCache = new Map<string, string>();
let cueLibraryMtimeMs = -1;

export const readCueLibrary = (): Map<string, string> => {
    try {
        const stat = fs.statSync(CUE_LIBRARY_PATH);
        if (stat.mtimeMs === cueLibraryMtimeMs) return cueLibraryCache;

        const parsed = JSON.parse(fs.readFileSync(CUE_LIBRARY_PATH, 'utf8'));
        const next = new Map<string, string>();
        const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
        for (const entry of entries) {
            if (typeof entry?.text === 'string' && typeof entry?.audio_b64 === 'string') {
                next.set(entry.text, entry.audio_b64);
            }
        }
        cueLibraryCache = next;
        cueLibraryMtimeMs = stat.mtimeMs;
        return cueLibraryCache;
    } catch {
        cueLibraryCache = new Map();
        cueLibraryMtimeMs = -1;
        return cueLibraryCache;
    }
};
