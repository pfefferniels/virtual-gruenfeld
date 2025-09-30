import { Belief } from "doubtful/inverse"

export type BeliefMap = {
    belief: Belief,
    range: [number, number]
}[]

export interface Reconstruction {
  id: string;
  label: string;
}
