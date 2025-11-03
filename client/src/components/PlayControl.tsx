import { ExpandMore, PlayCircle, StopCircle } from "@mui/icons-material";
import { Box, Stack, IconButton, Paper, Slider, Checkbox, FormControl, FormControlLabel, FormGroup, FormLabel, Accordion, AccordionDetails, AccordionSummary, InputLabel } from "@mui/material";
import { read } from "midifile-ts";
import { useState } from "react";
import { usePiano } from "react-pianosound";

interface PlayControlProps {
    anchorEl: Element | null;
    selection: string[];
}

const params = ['rubato', 'tempo', 'dynamics', 'temporalSpread', 'dynamicsGradient', 'relativeVelocity', 'relativeDuration']

export const PlayControl = ({ anchorEl, selection }: PlayControlProps) => {
    const [exaggeration, setExaggeration] = useState(0)
    const [isPlaying, setIsPlaying] = useState(false)
    const [isolation, setIsolation] = useState<string[]>(params)

    const { play, stop } = usePiano()

    const handleStop = () => {
        stop()
        setIsPlaying(false)
    }

    const handlePlay = async () => {
        const mpmFetch = fetch('reconstruction/performance.mpm')
        const meiFetch = fetch('reconstruction/score.mei')
        const [mpmResp, meiResp] = await Promise.all([mpmFetch, meiFetch])
        const mpm = await mpmResp.text()
        const mei = await meiResp.text()

        if (!mpm || !mei) return

        console.log('Modifying')
        const modifyRequest = {
            mpm,
            params: {
                increase: {
                    tempo: 0,
                    dynamics: 0
                },
                exaggerate: {
                    rubato: !isolation.includes('rubato') ? -1 : exaggeration,
                    tempo: !isolation.includes('tempo') ? -1 : exaggeration,
                    dynamics: !isolation.includes('dynamics') ? -1 : exaggeration,
                    temporalSpread: !isolation.includes('temporalSpread') ? -1 : exaggeration,
                    dynamicsGradient: !isolation.includes('dynamicsGradient') ? -1 : exaggeration,
                    relativeVelocity: !isolation.includes('relativeVelocity') ? -1 : exaggeration,
                    relativeDuration: !isolation.includes('relativeDuration') ? -1 : exaggeration
                }
            }
        }

        const modifyResponse = await fetch('http://localhost:8080/modify', {
            method: 'POST',
            body: JSON.stringify(modifyRequest)
        })
        if (!modifyResponse.ok) {
            console.log(`Modify request failed: ${modifyResponse.status} ${modifyResponse.statusText}`);
            return;
        }
        const modifyPayload = await modifyResponse.json();
        const mpmModified = modifyPayload?.mpm;
        if (!mpmModified) {
            console.log('No modified mpm field in response');
            return;
        }
        console.log('Modified MPM:', mpmModified)

        const request = {
            mpm: mpm,
            mei: mei,
            ids: selection,
        }

        console.log(`Converting to MIDI ...`)
        const response = await fetch(`http://localhost:8080/perform`, {
            method: 'POST',
            body: JSON.stringify(request)
        })

        if (!response.ok) {
            console.log(`Playback request failed: ${response.status} ${response.statusText}`);
            return;
        }

        const payload = await response.json();
        const b64 = payload?.midi_b64;
        if (!b64) {
            console.log('No midi_b64 field in response');
            return;
        }

        // decode base64 to ArrayBuffer
        const binary = atob(b64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
        const midiBuffer = bytes.buffer;

        const file = read(midiBuffer)
        // console.log('file', file)
        // file.tracks.forEach(track => track.forEach(event => { if ('channel' in event) event.channel = 0 }))
        play(file as any)

        setIsPlaying(true)
    }

    const position = anchorEl ? {
        top: anchorEl.getBoundingClientRect().top + 10,
        left: anchorEl.getBoundingClientRect().left + 10
    } : { top: 10, left: 10 };

    console.log('anchorEl', anchorEl?.getBoundingClientRect())

    return (
        <Paper sx={{ position: 'absolute', ...position, zIndex: 1000 }}>
            <Stack direction='row' spacing={1} ml={3} p={2} >
                <Stack direction='column'>
                    <Stack direction='row'>
                        <Box sx={{ m: 1 }}>Exaggaration</Box>
                        <Slider
                            id="exaggeration-slider"
                            value={exaggeration}
                            min={-1}
                            max={1}
                            step={0.1}
                            onChange={(_, val) => setExaggeration(val as number)}
                            valueLabelDisplay="auto"
                            aria-labelledby="exaggeration-slider"
                            sx={{ width: 150, mt: 0.5 }}
                        />
                    </Stack>

                    <Accordion sx={{ mt: 2 }}>
                        <AccordionSummary expandIcon={<ExpandMore />}>
                            <Box>Isolate</Box>
                        </AccordionSummary>
                        <AccordionDetails>
                            <FormControl component="fieldset" fullWidth>
                                <FormGroup>
                                    {params.map(p => {
                                        const checked = isolation.includes(p)
                                        const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
                                            if (event.target.checked) {
                                                setIsolation([...isolation, p])
                                            } else {
                                                setIsolation(isolation.filter(i => i !== p))
                                            }
                                        }
                                        return (
                                            <FormControlLabel
                                                key={p}
                                                control={<Checkbox checked={checked} onChange={handleChange} name={p} size="small" />}
                                                label={p.charAt(0).toUpperCase() + p.slice(1)}
                                            />
                                        )
                                    })}
                                </FormGroup>
                            </FormControl>
                        </AccordionDetails>
                    </Accordion>
                </Stack>

                <Box>
                    <IconButton onClick={() => isPlaying ? handleStop() : handlePlay()}>
                        {isPlaying
                            ? <StopCircle />
                            : <PlayCircle />
                        }
                    </IconButton>
                </Box>
            </Stack>
        </Paper>

    )
}