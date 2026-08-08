// Re-export everything from the mpm/ module directory.
// Consumers can import from './mpm' as before.
export { mpmify, diff, diffStructured, exaggerate, allDimensions } from './mpm/index';
export type { Range, StructuredDiffEvent, ExaggerationDimension } from './mpm/index';
