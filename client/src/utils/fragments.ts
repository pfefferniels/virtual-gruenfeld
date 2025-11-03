import { AnyInstruction, MPM } from "mpm-ts";
import { MSM } from "mpmify";

export const composeMPM = (active: AnyInstruction[], mpm: MPM): MPM => {
  const newMPM = mpm.clone();

  if (!active.find(i => i.type === 'tempo')) {
    // if no tempo is active, add a default one, based on the 
    // average of the existing tempos (which will be removed)
    // afterwards
    const tempos = mpm.getInstructions().filter(i => i.type === 'tempo');
    let avgBPM = 60
    if (tempos.length !== 0) {
      const sum = tempos.reduce((acc, tempo) => acc + tempo.bpm * tempo.beatLength * 4, 0);
      avgBPM = sum / tempos.length;
    }

    newMPM.insertInstruction({
      type: 'tempo',
      bpm: avgBPM,
      beatLength: 0.25,
      "xml:id": 'defaultTempo',
      date: 0
    }, 'global')
  }

  // deactivate all irrelevant instructions
  for (const instruction of newMPM.getInstructions()) {
    if (!active.includes(instruction)) {
      newMPM.removeInstruction(instruction);
    }
  }

  return newMPM;
}

const composeMSM = (msm: MSM, active_: AnyInstruction[], mpm: MPM) => {
  const active = new Set(active_)
  const newMSM = msm.clone();

  newMSM.allNotes = msm.allNotes.filter(note => {
    const effective = new Set(mpm.instructionsEffectiveAtDate(note.date));
    return effective.intersection(active).size > 0
  })

  return newMSM
}

export const composeFragment = (msm: MSM, mpm: MPM, active: AnyInstruction[]) => {
  const newMSM = composeMSM(msm, active, mpm);
  const newMPM = composeMPM(active, mpm);

  return {
    msm: newMSM,
    mpm: newMPM
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const asMSM = async (mei: string, _voicesAsParts: boolean = false) => {
    const response = await fetch(`http://localhost:8080/convert`, {
        method: 'POST',
        body: JSON.stringify({
            mei
        })
    })
    if (!response.ok) {
        throw new Error(`Failed to convert MEI to MSM: ${response.statusText}`)
    }

    const json = await response.json()

    // console.log('msm=', json.msm)
    const msmDoc = new DOMParser().parseFromString(json.msm, 'application/xml')

    return msmDoc;
}
