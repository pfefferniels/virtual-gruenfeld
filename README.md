# Virtual Grünfeld

You play Schumann's *Träumerei*, and Alfred Grünfeld's 1905 Welte-Mignon recording talks back — explaining what you did differently and demonstrating its own interpretation with exaggerated contrast.

## How it works

1. The app loads the score (MEI) and a reference performance reconstructed from piano rolls
2. You play on a MIDI keyboard
3. Your playing is matched against the score using a subsequence alignment algorithm
4. The system compares your performance parameters (tempo, dynamics, articulation, rubato, ornamentation) against the reference
5. An LLM generates a short spoken critique in German, calibrated to the severity of deviations
6. The reference performance is exaggerated *away* from your playing and rendered as MIDI — so you hear the contrast

The whole loop runs in the browser — the MEI→MSM conversion and the MIDI rendering included, via [espressivo](https://github.com/pfefferniels/espressivo), a TypeScript port of meico — except for the LLM + TTS call (Node server).

## What the teacher knows

The teacher is not given a summary of your playing to react to. It is given the evidence.

- **The scholarly corpus.** `client/public/info.json` holds 136 CIDOC-CRM argumentations — the
  editorial record of *why* the reconstruction reads the roll the way it does, with each claim's
  position, transformer, certainty and motivation. `src/corpus/` distils this into a byte-stable
  digest that sits in the system prompt, plus the full editorial detail for the bars you just
  played. So the teacher says "zum B-Dur hin lösen" where it used to say "more expressive".
- **Every measured deviation**, untruncated — the structured diff, not the top-3 summary table.
- **What happened earlier in the lesson.** `src/sessions/` records each take and each question,
  so the teacher can say "noch immer zu rasch" and mean it. Sessions live on disk, one JSON file
  per lesson; a page reload starts a new one.
- **How Grünfeld talked.** `src/prompts/gruenfeldVoice.ts` distils a philological style study of
  Grünfeld's own language — his maxims, praise scale, Viennese idiom, sentence shapes and imagery,
  drawn from letters, feuilletons and his critics' vocabulary. The teacher *is* Grünfeld: it speaks
  in the first person as the man who cut the roll (dosed — the word limits always win).

Two capabilities sit behind flags, off by default (see `client/src/featureFlags.ts`, and the
*Prototype features* toggles in the debug sidebar):

- **Agentic lesson plans** (`VITE_TEACHER_AGENTIC`) — the teacher decides *what* to demonstrate:
  exaggerate, play the reference straight, or just talk; over which bars; exaggerating which
  dimensions and how hard. `src/plan/` validates and clamps the answer, so a model asking for
  something unmusical gets corrected rather than obeyed.
- **Push-to-talk** (`VITE_TEACHER_VOICE`) — hold a button, ask a question out loud, hear the
  answer. Transcription, the same grounded teacher, and TTS.

## Models

| Tier | Model | Latency | Corpus depth |
|---|---|---|---|
| Realtime | `gpt-5.4-mini` | ~1.3 s | Compact digest — this one speaks over live playback |
| Balanced | `gpt-5.6-terra` | ~2–3.7 s | Full digest |
| Studio | `gpt-5.6-terra` | ~2–3.7 s | Full digest, richest cues |

Voice is ElevenLabs: `eleven_v3` for takes, because cue scheduling needs its character-level
timestamps to place words against the music, and `eleven_turbo_v2_5` for spoken answers, where
there is nothing to align and v3's 10 s would be most of the wait. All of it is env-overridable
(`src/config.ts`, `DEPLOYMENT.md`).

## Project structure

```
src/
  server.ts                Express: the teacher service
  config.ts                Tier → model, corpus depth
  cors.ts                  Which browser origins may call the teacher
  corpus/                  info.json + MPM.md → the grounded prompt context
  prompts/                 System prompt (persona, Grünfeld voice, primer, digest, output contract)
  plan/                    Agentic lesson plans: schema, validation, clamping
  sessions/                Take history, Q&A, student profile
  routes/                  /teacher-stream (takes), /teacher-ask (questions)
  tts/, audio/             ElevenLabs synthesis, transcription
client/src/
  Dialog.tsx               Main UI — the teaching loop
  matcher.ts               Subsequence matcher (Smith-Waterman + Hungarian)
  mpm/                     Diff and exaggerate, severity formatting
  pipeline/                Turn choreography: cues, playback, strategies
  teacherCues.ts           Scheduling spoken cues against the music
  useVoiceQuestion.ts      Push-to-talk
  asMSM.ts                 MEI → MSM, enriched with the roll's timings
  services/mpmRenderer.ts  MEI → MSM and MPM → MIDI, in-process via espressivo
client/public/
  score.mei                Schumann Träumerei Op. 15 No. 7
  info.json                CIDOC-CRM metadata with mpmify transformer chain
generate_test.ts           End-to-end test: renders student → explanation → teacher MP3s
scripts/smoke-teacher.ts   Live smoke tests against the real APIs
```

## Dependencies

- [mpm-ts](https://github.com/pfefferniels/mpm-ts) and [mpmify](https://github.com/pfefferniels/mpmify) — local packages for Music Performance Markup
- [espressivo](https://github.com/pfefferniels/espressivo) — MEI converter and MPM renderer, a TypeScript port of [meico](https://github.com/cemfi/meico); local package at `../meico-ts`
- OpenAI for the teacher, transcription and the student profile
- ElevenLabs for German TTS
- For the test script: fluidsynth + a soundfont, ffmpeg

## Setup

```bash
npm install
cd client && npm install
cp .env.example .env   # add OPENAI_API_KEY, ELEVENLABS_API_KEY
```

The three local packages are linked from sibling checkouts (`../mpm-ts`, `../mpmify`, and
`../meico-ts` for espressivo) and need to be built first. Then:

```bash
npm run dev
```

## Tests

One vitest run covers both halves of the project — the client tests and the server tests under
`src/`, which live next to their source:

```bash
npm test          # or: cd client && npx vitest run
```

Type-checking and dead-code analysis:

```bash
npm run type-check              # server
cd client && npx tsc --noEmit   # client
npm run knip                    # unused files, exports and dependencies
```

End-to-end pipeline test (generates MP3s with student → spoken explanation → teacher):

```bash
SF2_PATH=/path/to/soundfont.sf2 npx tsx generate_test.ts
```

Live smoke tests against the real OpenAI and ElevenLabs APIs (needs keys in `.env`):

```bash
npx tsx scripts/smoke-teacher.ts
```

## Further reading

- **[DEPLOYMENT.md](DEPLOYMENT.md)** — how to put the AI teacher online. The public app runs
  without it until you do.
- **[MODERNIZATION.md](MODERNIZATION.md)** — the 2026 rebuild of the AI layer, phase by phase,
  with the measurements each decision rests on.
- **[FUTURE.md](FUTURE.md)** — what was deliberately left undone, and what it would take.
- **[MPM.md](MPM.md)** — the Music Performance Markup concepts the whole pipeline speaks in.

## License

MIT
