import { createContext, ReactNode, useEffect, useState } from "react";
import { Piano } from "../../../../react-pianosound/node_modules/@tonejs/piano";
import * as Tone from "../../../../react-pianosound/node_modules/tone";

type PianoStatus = 'loading' | 'done' | 'error' | undefined;

interface PianoContextProps {
    piano?: Piano;
    status: PianoStatus;
}

export const PianoContext = createContext<PianoContextProps | undefined>(undefined);

interface PianoContextProviderProps {
    velocities?: number;
    children: ReactNode;
}

export const PianoContextProvider = ({ velocities, children }: PianoContextProviderProps) => {
    const [piano, setPiano] = useState<Piano>();
    const [status, setStatus] = useState<PianoStatus>();

    useEffect(() => {
        let withDestination: Piano | undefined;

        try {
            const context = new Tone.Context();
            Tone.setContext(context);

            const initializedPiano = new Piano({
                velocities: velocities || 5,
            });

            void (async () => {
                setStatus('loading');
                await initializedPiano.load();
                setStatus('done');
            })();

            withDestination = initializedPiano.toDestination();
            setPiano(withDestination);
        } catch (e) {
            console.error(e);
            setStatus('error');
        }

        return () => {
            withDestination?.disconnect();
        };
    }, [velocities]);

    return (
        <PianoContext.Provider value={{ piano, status }}>
            {children}
        </PianoContext.Provider>
    );
};
