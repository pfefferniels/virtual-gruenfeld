# Future work

Things the 2026 modernization deliberately did not do, with enough detail to pick them up later.

## 1. Realtime speech-to-speech instead of push-to-talk

Phase 4 gives the student a button to hold, a transcription call, a text answer and an
ElevenLabs render of it. That is a turn-based channel wearing a conversation's clothes.
The realtime APIs that exist as of 2026 — OpenAI's `gpt-realtime-2.1` and
`gpt-realtime-2.1-mini`, Google's Gemini Live — take a bidirectional audio stream and
answer in 300–500 ms, with the model itself handling voice activity detection and
interruption.

### What that would actually buy

- **Barge-in.** The student can cut the teacher off mid-sentence ("ja, aber warum
  *dort*?"). Today they wait out the answer, because the answer is a finished MP3.
- **No transcription hop.** The model hears the audio. Phase 4 measured 0.9–1.9 s just to
  turn 4 seconds of speech into text before the LLM has read a word.
- **No TTS hop.** This is the big one. Measured end to end, the answer LLM takes 1.4–2.9 s
  and ElevenLabs v3 takes **8–10 s** for a ~300-character answer. The speech is four times
  the cost of the thinking. Realtime speech-to-speech removes that leg entirely.
- **Prosody as information.** A hesitant question sounds different from a confident one,
  and a spoken answer can be sung, slowed, or hummed. Both directions are currently
  flattened into text.

### What would change architecturally

| Today | Realtime |
|---|---|
| `POST /teacher-ask`, one request per question | A session: WebRTC or WebSocket, open for the lesson |
| System prompt rebuilt per request | Prompt becomes the session's initial config, sent once |
| Session history assembled into the input | History is the conversation itself; `src/sessions/` keeps its role only for the *take* path |
| ElevenLabs renders the answer | Model emits audio directly |
| Keys on the Node server | Ephemeral client tokens minted server-side (the browser holds the socket) |

**What must not change**: the cue path. Cues over live playback need character-level
timestamps to schedule words against the music (`synthesizeWithTimestamps` →
`teacherCues.ts` → `chunker.ts`). A realtime model gives you audio, not an alignment array.
So the end state is two voices in the same app — realtime for conversation, timestamp-sliced
ElevenLabs for cues-over-music — and they should use the same ElevenLabs voice id so the
student hears one teacher.

**Open questions before starting**: whether the realtime model can hold the ~3k-token
scholarly digest in its session config without drifting; whether corpus lookups should
become tool calls it makes mid-conversation (`getRangeDetail(range)` is already the right
shape); how a realtime session survives a page reload; and cost per minute of an open
socket versus per question asked.

**The cheap intermediate step has since been taken** (Phase 5): the answer path now defaults
to `eleven_turbo_v2_5`, which generates the same 314-character German answer in ~0.8 s instead
of v3's ~9.7 s (interleaved A/B, timed to response headers), with no loss of intelligibility
and a brisker delivery. That removes the
single worst leg but not the turn-taking — the student still waits out a finished MP3 and
still cannot interrupt. What remains unexplored is **streaming** the answer's audio as it is
generated, which would hide most of the remaining latency without any of the rearchitecting
above.

## 2. RUMAA as a check on the matcher

`client/src/matcher.ts` (Smith-Waterman with affine gaps, then Hungarian refinement per
chord) is the deterministic core the whole pipeline rests on, and it is ours. RUMAA —
repeat-aware score-performance alignment — solves the same problem from the literature,
and Träumerei is exactly its hard case: `||: A :|| ||: B A' :||` means a matcher can be
confidently, silently wrong about *which* pass of a repeat it just heard.

Worth doing as a **comparison, not a replacement**: run both over the recorded student
takes, measure disagreement rate and where it clusters (repeat boundaries, arpeggiated
chords, dropped notes). If they agree everywhere, that is a published-baseline validation
of 63 tests' worth of hand-built logic. If they disagree at repeat boundaries, that is a
bug report against our matcher, with a reference implementation to read. Either outcome is
worth more than the porting effort.

## 3. Pianist Transformer vs. mpmify's `ml/` tree

`../mpmify/ml/` is an abandoned attempt at the same idea current expressive-rendering
transformers (Pianist Transformer and relatives) pursue: learn to produce a performance
model rather than hand-fit one. It did not fail on the idea. Reading `ml/LOG.md`, it failed
on an 8 GB M1 — MPS training hangs outright in torch 2.11, and the v0 recipe swap-thrashed
at ~100× slowdown. The synthetic-data generator, the lossless tempo DSL, and the exact port
of meico's tempo math (validated to 0.000000000 ms) all survive and are the expensive parts.

Two questions to answer before restarting it:

1. **Rented hardware changes the verdict.** The blocker was local silicon, not method. A
   day on a rented GPU would settle whether the v1 recipe learns anything, using the data
   pipeline that already exists.
2. **Is generation even the goal here?** Virtual Grünfeld does not need a model that
   *invents* an expressive performance — it has one specific historical performance, hand-
   reconstructed and documented argument by argument. A learned renderer is more plausible
   as a *counter-performance generator* (Phase 3's `exaggerate()` currently does this with
   tuned constants) or as a plausibility check on student takes, than as a replacement for
   the reconstruction. Frame the experiment that way and it has a use even if the model is
   mediocre.

Related and unexplored: MIDI-LLaMA and symbolic-music LLMs generally, as an alternative to
feeding score MEI to a general model as text.

## 4. Smaller items carried forward

- **Serialized render in agentic mode** (Phase 3): the render waits for the lesson plan,
  where the legacy path overlapped them. Now that it runs in-process via espressivo
  (~50–300 ms for a passage) there is little left to win; a speculative render would close
  the rest.
- **`normalizeCueText` / `normalizeV3Tag`** are tested but not wired into the live vocal
  path (Phase 1 caveat). Wire them in or delete them.
- **Session pruning runs once per process start** — fine for a long-lived Node server,
  wrong for a Worker that starts cold per request.
- **Page reload starts a new lesson** (`client/src/session.ts`). Deliberate;
  `sessionStorage` would change it in one line if the prototype ever wants continuity.
- **No component-level tests** (Phases 4–5). The client has no jsdom environment, so
  "the voice UI renders nothing when the flag is off" is asserted through the flag logic
  and the single `showVoice` gate rather than by rendering `Dialog`. Adding jsdom is not
  the 30-minute job it sounds like: `Dialog` pulls in `usePiano` → Tone.js → WebAudio and
  WebMIDI, all of which would need mocking before the first assertion. Worth doing the day
  the UI grows a second branch worth testing; not before.
- **The session store is a directory of JSON files.** Bounded per session (50 takes, 20
  questions) and swept at process start, which is enough for a prototype on one host. A
  second instance behind a load balancer would need shared storage — see DEPLOYMENT.md §5.
