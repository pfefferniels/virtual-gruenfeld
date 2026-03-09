import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import path from 'path';
import OpenAI from 'openai';

const MODEL = process.env.OPENAI_MODEL || 'gpt-5.2';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `Du bist ein ermutigender Klavierlehrer und sprichst direkt zum Schüler. Antworte in EINEM gesprochenen deutschen Satz, maximal 20 Wörter. Keine Listen, keine Nummerierungen, keine Aufzählungen. Verwende musikalische Begriffe (leiser, mehr Legato, weniger Rubato), keine Zahlen. Fasse die wichtigste Abweichung zusammen.

Sei proportional in deiner Kritik! Jede Abweichung ist mit einer Schwere markiert:
~ = leichte Abweichung → „etwas", „ein wenig" (ermutigend, fast richtig)
! = deutliche Abweichung → „mehr", „weniger" (sachlich, konstruktiv)
!! = große Abweichung → „viel mehr", „deutlich" (klar benennen, aber nicht harsch)
Verwende NIE „viel zu" oder „komplett falsch" — du bist ein geduldiger Lehrer.

Beispiele:
- Nur ~: "Das klingt schon gut, versuch die Melodie noch etwas weicher zu verbinden."
- Mix ~/!: "Spiel die Melodie etwas leiser und verbinde die Töne mehr, das klingt sonst zu abgehackt."
- Viele !!: "Nimm deutlich mehr Tempo raus und spiel insgesamt leiser, dann kommt die Phrasierung besser zur Geltung."

Du erhältst Abweichungen zwischen deiner Referenzinterpretation und dem Schüler, gruppiert nach Typ:

MPM-Referenz:
- tempo: bpm = Schläge pro Minute; accel/rit = Accelerando/Ritardando
- dynamics: volume = Lautstärke (pp/p/mp/mf/f/ff); cresc/decresc = Crescendo/Decrescendo
- articulation: relativeDuration = Tondauer (1.0=Legato, 0.5=Staccato); relativeVelocity = Betonung (>1=Akzent)
- rubato: intensity = Stärke der Agogik; frameLength = Zykluslänge
- ornament: Arpeggierung von Akkorden. scale = Dynamikgefälle; intensity = zeitliche Spreizung
- accentuationPattern: scale = Stärke der metrischen Betonung
- asynchrony: milliseconds.offset = zeitlicher Versatz einer Stimme`;

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('client/build'));

app.post('/explain-and-speak', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const send = (event: string, data: any) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    };

    try {
        // 1. Stream explanation from OpenAI
        let fullText = '';
        const stream = await openai.responses.create({
            model: MODEL,
            stream: true,
            instructions: SYSTEM_PROMPT,
            input: req.body.diff,
        });

        for await (const event of stream as any) {
            if (event.type === 'response.output_text.delta') {
                const delta: string = event.delta ?? '';
                if (!delta) continue;
                fullText += delta;
                send('delta', delta);
            } else if (event.type === 'response.failed' || event.type === 'response.incomplete') {
                send('error', { type: event.type });
                res.end();
                return;
            }
        }

        // 2. Stream TTS audio from ElevenLabs (no client roundtrip)
        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey || !fullText || fullText === "No significant differences found.") {
            res.end();
            return;
        }

        const voiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
        const modelId = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';

        const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                text: fullText,
                model_id: modelId,
                optimize_streaming_latency: 3,
            }),
        });

        if (!ttsRes.ok) {
            const err = await ttsRes.text();
            console.error('ElevenLabs streaming error:', err);
            send('error', { message: `TTS error: ${err}` });
            res.end();
            return;
        }

        // Pipe audio chunks as base64 SSE events
        const reader = (ttsRes.body as ReadableStream<Uint8Array>)?.getReader();
        if (reader) {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                send('audio', Buffer.from(value).toString('base64'));
            }
        }
    } catch (e) {
        console.error('explain-and-speak error', e);
        send('error', { message: String(e) });
    } finally {
        res.end();
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Virtual Grünfeld server running on port ${PORT}`);
});
