import { Send, Pause } from "@mui/icons-material";
import { Stack, TextField, Button } from "@mui/material";
import { useState } from "react";

interface ChatProps {
    onAsk: (question: string) => void;
    onPause: () => void;
    status: 'idle' | 'thinking' | 'running';
}

export const Chat = ({ onAsk, onPause, status}: ChatProps) => {
    const [question, setQuestion] = useState('');

    return (
        <Stack
            direction='row'
            spacing={1}
            sx={{
                position: 'fixed',
                bottom: 0,
                left: 0,
                right: 0,
                p: 2,
                backgroundColor: 'background.paper',
                borderTop: 1,
                borderColor: 'divider'
            }}
        >
            <TextField
                label="Your question"
                placeholder="Ask Alfred Grünfeld ..."
                variant="outlined"
                fullWidth
                multiline
                maxRows={4}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        onAsk(question);
                    }
                }}
            />
            <Button
                variant='contained'
                onClick={() => onAsk(question)}
                startIcon={<Send />}
                sx={{ minWidth: 'auto' }}
                disabled={status === 'thinking'}
            >
                Ask
            </Button>
            <Button
                variant="outlined"
                onClick={() => onPause()}
                startIcon={<Pause />}
                sx={{ minWidth: 'auto' }}
                disabled={status !== 'running'}
            >
                Pause
            </Button>
        </Stack>
    )
}