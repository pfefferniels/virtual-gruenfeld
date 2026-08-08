// Re-export everything from the mpm/ module directory.
// Consumers can import from './mpm' as before.
export { mpmify, diff, diffStructured, exaggerate, allDimensions, DEFAULT_EXAGGERATION_STRENGTH } from './mpm/index';
export type { Range, StructuredDiffEvent, ExaggerationDimension } from './mpm/index';
