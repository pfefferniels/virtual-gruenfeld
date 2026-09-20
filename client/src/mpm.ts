// Re-export everything from the mpm/ module directory.
// Consumers can import from './mpm' as before.
export { allDimensions, counterPerformance } from './mpm/index';
export type { InstructionDiff, Range } from './mpm/index';
