import { useEffect, useState } from "react";
import { BeliefMap } from "../types";
import { Paper } from "@mui/material";
import { usePianoEvents } from "react-pianosound";

interface ObservationPanelProps {
    observations: BeliefMap;
}

export const ObservationPanel = ({ observations }: ObservationPanelProps) => {
    const [currentObservations, setCurrentObservations] = useState<BeliefMap>([])

    usePianoEvents((e) => {
        const currentTime = e.transportSeconds * 1000

        setCurrentObservations(
            observations
                .filter(o => o.belief !== undefined)
                .filter(
                    (o) => currentTime >= o.range[0] && currentTime <= o.range[1]
                )
            )
    })


    return (
        <div>
            {currentObservations
                .map((o, i) => (
                    <Paper key={i} sx={{ padding: 2 }}>
                        <b>{o.belief.that.assigned}</b><br />
                        <small color="gray">{o.belief.certainty}</small>
                    </Paper>
                ))}
        </div>
    );
};
