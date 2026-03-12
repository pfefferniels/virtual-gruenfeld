import type { DiffSeverity } from '../shared/severity';

export type Range = { from: number; to: number };

export type { DiffSeverity };

export type StructuredDiffEvent = {
    id: string;
    date: number;
    position: string;
    type: string;
    severity: DiffSeverity;
    primaryAttr: string;
    magnitude: number;
    cueText: string;
    direction: 'more' | 'less';
    refValue: number;
    studentValue: number;
};

export type InstructionDiff = {
    date: number;
    type: string;
    nameRef?: string;
    diffs: Record<string, { ref: number; student: number; delta: number }>;
    magnitude: number;
};
