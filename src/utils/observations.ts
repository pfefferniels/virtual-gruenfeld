import { Belief, importWork, Transformer } from "mpmify";
import path from "path";
import * as fs from "fs";

export type BeliefMap = {
    belief: Belief,
    range: [number, number]
}[]


type Observation = Transformer

export const loadObservations = (reconstruction: string): Observation[] | undefined => {
    const obsPath = path.join(process.cwd(), 'assets', reconstruction, 'info.json');

    if (!fs.existsSync(obsPath)) {
        return
    }

    const content = fs.readFileSync(obsPath, 'utf8');
    return importWork(content)
}

export const beliefsBasedOn = (mpmId: string, observations: Observation[]): Set<Belief> => {
    return new Set(
        observations
            .filter(obs => obs.created.includes(mpmId))
            .map(obs => obs.argumentation.conclusion)
    )
}
