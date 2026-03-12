export type DiffSeverity = 'slight' | 'mod' | 'large';

export const severityWeight = (severity: DiffSeverity): number =>
    severity === 'large' ? 3 : severity === 'mod' ? 2 : 1;

export const severityRank = (severity: DiffSeverity): number =>
    severity === 'large' ? 3 : severity === 'mod' ? 2 : 1;
