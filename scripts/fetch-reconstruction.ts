/**
 * Mirrors the reconstruction into `client/public/` for tests and the developer scripts.
 *
 * The app fetches these from welte225.org at runtime. Nothing here is committed: the mirror is
 * gitignored and exists so the test suite and `generate_test.ts` can read from disk without a
 * network round trip per file. Other projects depend on the canonical documents, so this
 * repository keeps no version of its own.
 *
 *   npx tsx scripts/fetch-reconstruction.ts           fetch what is missing
 *   npx tsx scripts/fetch-reconstruction.ts --force   re-fetch everything
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const RECONSTRUCTION_BASE = 'https://welte225.org/mpm';

/** Canonical name → the name this repository's tests and scripts already read. */
const MIRROR: Readonly<Record<string, string>> = {
    'transcription.mei': 'score.mei',
    'performance.mpm': 'performance.mpm',
    'score.msm': 'score.msm',
};

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'public');

const fetchOne = async (canonical: string, local: string, force: boolean): Promise<string> => {
    const target = join(publicDir, local);
    if (!force && existsSync(target)) return `${local} present`;

    const response = await fetch(`${RECONSTRUCTION_BASE}/${canonical}`);
    if (!response.ok) throw new Error(`${canonical}: ${response.status} ${response.statusText}`);
    const body = await response.text();
    writeFileSync(target, body, 'utf8');
    return `${local} ← ${canonical} (${body.length} bytes)`;
};

const main = async () => {
    const force = process.argv.includes('--force');
    mkdirSync(publicDir, { recursive: true });

    const results = await Promise.all(
        Object.entries(MIRROR).map(([canonical, local]) => fetchOne(canonical, local, force)),
    );
    results.forEach((line) => console.log(`  ${line}`));
};

main().catch((error) => {
    console.error(`fetch-reconstruction: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
});
