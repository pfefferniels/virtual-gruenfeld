export type BeliefMap = {
    belief: {
        about: {
            note: string
        };
        cert: string
    },
    range: [number, number]
}[]

export interface Reconstruction {
  id: string;
  label: string;
}
