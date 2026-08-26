// Re-export everything from the mpm/ module directory.
// Consumers can import from './mpm' as before.
export { allDimensions, counterPerformanceBase, exaggerate, studentInstructionsFrom } from './mpm/index';
export type { Range, StructuredDiffEvent, ExaggerationDimension, InstructionSource } from './mpm/index';
