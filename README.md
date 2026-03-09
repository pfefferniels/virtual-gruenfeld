# Virtual Grünfeld

A dialogic piano teaching app. You play Schumann's *Träumerei*, and Alfred Grünfeld's 1905 Welte-Mignon recording talks back — explaining what you did differently and demonstrating its own interpretation with exaggerated contrast.

## How it works

1. The app loads the score (MEI) and a reference performance reconstructed from piano rolls
2. You play on a MIDI keyboard
3. Your playing is matched against the score using a subsequence alignment algorithm
4. The system compares your performance parameters (tempo, dynamics, articulation, rubato, ornamentation) against the reference
5. An LLM generates a short spoken critique in German, calibrated to the severity of deviations
6. The reference performance is exaggerated *away* from your playing and rendered as MIDI — so you hear the contrast

The whole loop runs in the browser, except for MEI↔MSM conversion and MIDI rendering (Java, port 8080) and the LLM + TTS call (Node server).

## Project structure

```
src/server.ts              Express server: OpenAI streaming + ElevenLabs TTS
client/src/
  Dialog.tsx               Main UI — the teaching loop
  matcher.ts               Subsequence matcher (Smith-Waterman + Hungarian)
  mpm.ts                   Diff and exaggerate functions, severity formatting
  midi.ts                  WebMIDI input handling
  api.ts                   Calls to /perform, /explain-and-speak, local implant
  asMSM.ts                 MEI → MSM via meico
  smf.ts                   Standard MIDI File parser
client/public/
  score.mei                Schumann Träumerei Op. 15 No. 7
  info.json                CIDOC-CRM metadata with mpmify transformer chain
generate_test.ts           End-to-end test: renders student → explanation → teacher MP3s
```

## Dependencies

- [mpm-ts](https://github.com/pfefferniels/mpm-ts) and [mpmify](https://github.com/pfefferniels/mpmify) — local packages for Music Performance Markup
- [meico](https://github.com/cemfi/meico) — MEI converter/renderer, runs as a Java server on port 8080
- OpenAI API (gpt-5.2) for generating explanations
- ElevenLabs for German TTS
- For the test script: fluidsynth + a soundfont, ffmpeg

## Setup

```bash
npm install
cd client && npm install
cp .env.example .env   # add OPENAI_API_KEY, ELEVENLABS_API_KEY
```

Start the meico server on port 8080, then:

```bash
npm run dev
```

## Tests

Matcher tests (63 cases):

```bash
cd client && npx vitest run
```

End-to-end pipeline test (generates MP3s with student → spoken explanation → teacher):

```bash
SF2_PATH=/path/to/soundfont.sf2 npx tsx generate_test.ts
```

## License

MIT
