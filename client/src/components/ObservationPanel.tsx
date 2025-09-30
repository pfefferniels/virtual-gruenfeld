import { useEffect, useState } from "react";
import { BeliefMap } from "../types";
import { Paper } from "@mui/material";

interface ObservationPanelProps {
    observations: BeliefMap;
    audioRef: React.MutableRefObject<HTMLAudioElement | null>;
}

export const ObservationPanel = ({ observations, audioRef }: ObservationPanelProps) => {
    const [currentObservations, setCurrentObservations] = useState<BeliefMap>([]);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;

        const handleTimeUpdate = () => {
            const currentTime = audio.currentTime * 1000
            setCurrentObservations(
                observations
                    .filter(o => o.belief !== undefined)
                    .filter(
                        (o) => currentTime >= o.range[0] && currentTime <= o.range[1]
                    )
            );
        };

        audio.addEventListener("timeupdate", handleTimeUpdate);

        return () => {
            audio.removeEventListener("timeupdate", handleTimeUpdate);
        };
    }, [audioRef, setCurrentObservations, observations]);

    return (
        <div>
            {currentObservations
                .map((o, i) => (
                    <Paper key={i} sx={{ padding: 2 }}>
                        <b>{o.belief.that.assigned}</b><br/>
                        <small color="gray">{o.belief.certainty}</small>
                    </Paper>
                ))}
        </div>
    );
};
