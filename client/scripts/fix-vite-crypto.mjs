import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const viteChunk = path.resolve(__dirname, '../node_modules/vite/dist/node/chunks/dep-D_zLpgQd.js');

const needle = 'crypto$2.getRandomValues(new Uint8Array(9))';
const replacement = '(typeof crypto$2.getRandomValues === "function" ? crypto$2.getRandomValues(new Uint8Array(9)) : crypto$2.webcrypto.getRandomValues(new Uint8Array(9)))';

if (!fs.existsSync(viteChunk)) {
    console.error(`Vite chunk not found: ${viteChunk}`);
    process.exit(1);
}

const source = fs.readFileSync(viteChunk, 'utf8');
if (source.includes(replacement)) {
    process.exit(0);
}

if (!source.includes(needle)) {
    console.error('Expected Vite RNG call not found; aborting patch.');
    process.exit(1);
}

fs.writeFileSync(viteChunk, source.replace(needle, replacement));
console.log('Patched Vite crypto.getRandomValues fallback.');
