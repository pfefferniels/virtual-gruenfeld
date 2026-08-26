import { MSM, MsmNote, MsmPedal } from "mpmify";
import { v4 } from "uuid";
import { convert } from "./services/mpmRenderer";

/** Convert MEI to MSM using only score data (no performance enrichment). */
export const asMSMBasic = (mei: string): MSM => {
    const msmDoc = new DOMParser().parseFromString(convert(mei), 'application/xml');

    const seen = new Map<string, Element>();
    for (const note of msmDoc.querySelectorAll('note')) {
        const key = `${note.getAttribute('date')}:${note.getAttribute('midi.pitch')}`;
        const existing = seen.get(key);
        if (!existing || +(note.getAttribute('duration') || 0) > +(existing.getAttribute('duration') || 0)) {
            seen.set(key, note);
        }
    }

    const notes: MsmNote[] = Array.from(seen.values()).map(note => ({
        part: Number(note.closest('part')?.getAttribute('number')),
        'xml:id': note.getAttribute('xml:id') || v4(),
        'date': Number(note.getAttribute('date')),
        'duration': Number(note.getAttribute('duration')),
        'pitchname': note.getAttribute('pitchname') || '',
        'octave': Number(note.getAttribute('octave')),
        'accidentals': Number(note.getAttribute('accidentals')),
        'midi.pitch': Number(note.getAttribute('midi.pitch')),
        'midi.onset': 0,
        'midi.duration': 0,
        'midi.velocity': 64,
    }));

    const timeSignature = msmDoc.querySelector('timeSignature');
    return new MSM(notes, {
        numerator: Number(timeSignature?.getAttribute('numerator') || 4),
        denominator: Number(timeSignature?.getAttribute('denominator') || 4),
    });
};

export const asMSM = (mei: string) => {
    const msmDoc = new DOMParser().parseFromString(convert(mei), 'application/xml')

    // Enrich the official MSM with performance information
    const meiDoc = new DOMParser().parseFromString(mei, 'application/xml')

    const originalNotes = Array
        .from(msmDoc.querySelectorAll('note'))
        .reduce((acc, curr) => {
            const candidate = acc.find(n => n.getAttribute('date') === curr.getAttribute('date') &&
                n.getAttribute('midi.pitch') === curr.getAttribute('midi.pitch'))

            if (candidate) {
                if (+(curr.getAttribute('duration') || 0) > +(candidate.getAttribute('duration') || 0)) {
                    acc[acc.indexOf(candidate)] = curr
                }
            }
            else {
                acc.push(curr)
            }
            return acc;
        }, [] as Element[])


    // Filter notes with duplicate onsets
    const msmNotes: MsmNote[] = []
    for (const note of originalNotes) {
        const noteId = note.getAttribute('xml:id')
        // console.log('trying selector', `when[data~="#${noteId}"]`)
        const whens = meiDoc.querySelectorAll(`when[data~="#${noteId}"]`)
        if (!whens) continue

        for (const when of whens) {
            const source = when.closest('recording')?.getAttribute('source') || undefined

            const absolute = when.getAttribute('absolute')?.replace('ms', '')
            const duration = when.querySelector('extData[type="duration"]')?.textContent?.replace('ms', '')
            const velocity = when.querySelector('extData[type="velocity"]')?.textContent

            if (!absolute || !duration || !velocity) continue

            msmNotes.push({
                part: Number(note.closest('part')?.getAttribute('number')),
                'xml:id': note.getAttribute('xml:id') || v4(),
                'date': Number(note.getAttribute('date')),
                'duration': Number(note.getAttribute('duration')),
                'pitchname': note.getAttribute('pitchname') || '',
                'octave': Number(note.getAttribute('octave')),
                'accidentals': Number(note.getAttribute('accidentals')),
                'midi.pitch': Number(note.getAttribute('midi.pitch')),

                // performance stuff
                'midi.onset': +absolute / 1000,
                'midi.duration': +duration / 1000,
                'midi.velocity': +velocity,
                source
            })
        }
    }

    const msmPedals = Array
        .from(meiDoc.querySelectorAll('when[type="sustain"], when[type="soft"]')).map((when, index) => {
            const absolute = when.getAttribute('absolute')?.replace('ms', '')
            const duration = when.querySelector('extData[type="duration"]')?.textContent?.replace('ms', '')
            if (!absolute || !duration) return null

            const type = when.getAttribute('type') === 'sustain' ? 'sustain' : 'soft'
            const source = when.closest('recording')?.getAttribute('source') || undefined

            // find the closest following MSM note by midi.onset (>= pedalOnset)
            const pedalOnset = +absolute / 1000
            const followingNotes = msmNotes.filter(n => typeof n['midi.onset'] === 'number' && n['midi.onset'] >= pedalOnset)
            const closest = followingNotes.sort((a, b) => (a['midi.onset']! - b['midi.onset']!))[0]
            const xmlId = closest ? `${type}-${closest.date}` : `pedal-${index}`

            const msmPedal: MsmPedal = {
                'xml:id': xmlId,
                'midi.onset': pedalOnset,
                'midi.duration': +duration / 1000,
                'type': type,
                source
            }
            return msmPedal
        })
        .filter((pedal) => pedal !== null) as MsmPedal[]

    const timeSignature = msmDoc.querySelector('timeSignature')
    const newMSM = new MSM(msmNotes, {
        numerator: Number(timeSignature?.getAttribute('numerator') || 4),
        denominator: Number(timeSignature?.getAttribute('denominator') || 4)
    })
    newMSM.pedals = msmPedals

    console.log('newmsm', newMSM)
    return newMSM
}