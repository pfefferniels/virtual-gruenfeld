// Re-export everything from the mpm/ module directory.
// Consumers can import from './mpm' as before.
export { mpmify, diff, diffStructured, exaggerate } from './mpm/index';
export type { Range, StructuredDiffEvent } from './mpm/index';
