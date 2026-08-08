# AI Modernization — Autonomous Run Ledger

**This file is the single source of truth for the autonomous modernization run.**
Any fresh context (orchestrator or subagent) resumes by reading this file top to bottom.
Update the Progress Log after every completed unit of work. Never let work exist only in a chat context.

## Mission

Modernize Virtual Grünfeld's AI layer from its 2023-era design (one LLM call fed ~800 bytes of
pre-digested conclusions) to a 2026 architecture: a teacher grounded in the full scholarly corpus,
with conversation memory, agentic pedagogy decisions, and a deployable AI endpoint.
Full analysis: `~/.claude/projects/-Users-nielspfeffer-Projects-virtual-gruenfeld/memory/ai-modernization-2026.md`.

## Hard rules (every iteration, no exceptions)

1. **Branch discipline**: all work on `ai-modernization`. NEVER commit to or push `main`
   (push-to-main triggers a production Cloudflare deploy). NEVER run `wrangler deploy` or any
   production deployment. Restore point: branch `pre-ai-modernization`.
2. **Green before commit**: `npm run type-check` (root) and `cd client && npx vitest run`
   must pass before every commit. New behavior needs new tests.
3. **Commit + push after every logical unit**; one-liner messages ending with
   `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
4. **No secrets in git**. Live-API smoke tests only if local `.env` keys exist; skip gracefully otherwise.
5. **Behavior-compatible by default**: the «MARKER» output contract, ElevenLabs timestamp slicing,
   and client choreography keep working at every commit. New capabilities behind flags where risky.
6. **Don't touch**: `arbeitsverlauf.docx` (personal, uncommitted), `client/src/matcher.ts` internals
   (deterministic moat, 63 tests), the Java renderer contract (`/convert`, `/perform` on api.welte225.org).

## Context-management protocol

- Orchestrator (main session) stays thin: briefs subagents, reviews diffs, runs checks, commits,
  updates this ledger. Heavy reading/implementation happens in **subagents with fresh contexts**.
- Every subagent brief must include: this file's path, the phase spec below, and the key-file map.
  Subagents report back concise structured summaries, not file dumps.
- If the orchestrator context is compacted or lost: re-read this file, `git log --oneline -15`,
  and `git status` — that is the complete state.

## Key-file map (verified 2026-08-08)

| Concern | File |
|---|---|
| The only LLM call | `src/routes/teacherStream.ts` (OpenAI Responses API, non-streaming) |
| Prompt | `src/prompts/teacherStream.ts` (monologue, «JUDGE»/«m2.3» markers, German) |
| Model config | `src/config.ts` (3-tier: gpt-4.1-mini / gpt-5-mini / gpt-5.2) |
| TTS | `src/tts/synthesizeWithTimestamps.ts` (ElevenLabs v3, char timestamps) |
| Diff + reduction | `client/src/mpm/diff.ts` (`PER_TYPE_TOP_N=3` truncation, ASCII table) |
| Counter-performance | `client/src/mpm/exaggerate.ts` (`EXAGGERATION_TUNING`, aggressiveness 0.2) |
| Turn choreography | `client/src/pipeline/strategies/exaggerated.ts`, `takeRunner.ts`, `useTake.ts` |
| Cue scheduling | `client/src/teacherCues.ts`, `client/src/pipeline/teacherVocalStream.ts` |
| Corpus (unused by LLM today) | `assets/all/score.mei` (~31k tok), `assets/all/performance.mpm` (~28k), `client/public/info.json` (158 argumentations, ~52k), `MPM.md` spec |
| Dead code | `server/cue-library.json` + `src/cueLibraryManifest.ts`/`renderCueLibrary.ts` path, `REALTIME_PLAYBACK_DEADLINE_MS` plumbing |

## Phases

### Phase 0 — Baseline & housekeeping  [status: DONE 2026-08-08, commit 118a997]
Findings (measured, not guessed):
- Env keys present in root `.env`: OPENAI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID,
  PERFORM_BIN, MODIFY_BIN, PIANOTEQ_BIN, RENDER_AUDIO_FORMAT, RENDER_MAX_SECONDS, PORT, NODE_ENV.
  Absent (defaults live): OPENAI_CUE_MODEL_*, OUTPUT_LANGUAGE, ELEVENLABS_MODEL_ID.
- Model inventory (126 served): pinned gpt-4.1-mini / gpt-5-mini / gpt-5.2 all still exist but the
  tiering is latency-INVERTED — gpt-5-mini ("balanced") is the slowest tested (3.2s median, burns
  128-256 hidden reasoning tokens); gpt-4.1-mini ("realtime") is 2x slower than gpt-5.4-mini.
  Latency medians (3x, realistic prompt): gpt-5.4-mini 1009ms · gpt-5.6-luna 1304ms · gpt-5.2 1887ms
  · gpt-5.6-terra 1979ms · gpt-4.1-mini 2095ms · gpt-5.5 2110ms · gpt-5.4-nano 2164ms (NOT faster
  than mini) · gpt-5.6-sol 2473ms · gpt-5-mini 3230ms.
- **Phase 1 tier mapping**: realtime → `gpt-5.4-mini`, balanced → `gpt-5.6-luna`,
  studio → `gpt-5.6-terra`. (luna/terra capability ranking inferred, confirm in Phase 1 smoke test.
  No mini/nano variants exist for 5.5/5.6.) Voice for Phase 4: `gpt-transcribe` /
  `gpt-live-transcribe` (2026-07-27); realtime family: `gpt-realtime-2.1(-mini)`.
- Dead code removed: server/cue-library.json + cueLibraryManifest.ts + renderCueLibrary.ts +
  npm script; REALTIME_PLAYBACK_DEADLINE_MS plumbing end-to-end. `client/src/cueLibrary.ts` kept
  (one line: `CuePrepMode` type, imported by 5 modules — rename/fold is Phase 5 cleanup).
- Deferred to Phase 5 (knip): unused deps `uuid`, `midifile-ts`; unused exports
  TeacherStreamResponsePayload, TeacherCue, TeacherCueDraft, CuePrepMode (server twin);
  knip.json ignoreDependencies cleanup.
- Note for Phase 3: `playAudioBuffer` is threaded into StrategyControls but unused by the only
  strategy — structurally dead today, but "demo = pure reference" may want it. Left in place.

### Phase 1 — Grounded teacher  [status: DONE 2026-08-08, commits 136524f..a833f7d]
Results:
- `src/corpus/`: 158 argumentations distilled (digest 2,937 tok full / 2,443 compact; primer 697 tok;
  range detail ~2.5k tok per 5-bar take). Deterministic + byte-stable (tested). Position conventions
  handled: absolute from/to, rubato date/length, pedal anchor-relative. 5 note-ID argumentations
  remain unplaced (listed at digest tail), 2 piece-wide.
- Prompt: persona + MPM primer + digest + output contract, memoized/byte-stable (prefix-cacheable);
  DIFF GLOSSARY deleted (primer replaces it). Route accepts `structuredDiff` + `range` with legacy
  `diff`-string fallback; handler factored into `runTeacherStream()` (in-process testable).
- Client sends FULL structured diff + range (top-3 truncation no longer limits what the model sees).
- Latency (grounded prompt, medians): realtime gpt-5.4-mini ~1.3s · terra ~2.0-3.7s · luna 4.7-6.0s
  and more generic → **balanced remapped to gpt-5.6-terra** (both non-realtime tiers on terra,
  differing in corpus depth; Dialog.tsx hints updated). Legacy gpt-5-mini measured 15-21s on this
  prompt shape — Phase 0's 3.2s was prompt-dependent.
- Grounding verified in 36/36 contract-clean smoke runs: cues trace to specific argumentations
  ("Zum c hinflüstern", "Von oben lösen", "zum B-Dur hin") vs legacy generic adjectives.
- Sanitizers: strip-and-log instead of silent rejection; 5-word cap + no-digits kept.
- Tests: 151 (105 pre-existing + 46 new).
Caveats carried forward:
- `normalizeCueText`/`normalizeV3Tag` are NOT on the live vocal-stream path (tests only) — prompt
  rule added (English tags); consider wiring into live path or deleting in Phase 3/5.
- `assets/all/info.json` (160 args) vs `client/public/info.json` (158, the one used) drift —
  cosmetic; regenerate together if ever regenerated.
- `scripts/` outside root tsconfig include — smoke script checked by tsx only.
- Studio == balanced model-wise for now; future differentiation candidates: gpt-5.5(-pro),
  reasoning effort, richer range detail.
The core inversion: model sees evidence, not conclusions.
- `src/corpus/` module: assemble grounded context — clean score MEI, reference MPM, a distilled
  structured rendering of `info.json` argumentations (position, transformer, certainty, motivation,
  argument text), MPM concepts from `MPM.md`. Deterministic output, stable ordering
  (cache-friendly: corpus first, per-request data last). Unit-test the assembly (size bounds, determinism).
- Server: new prompt architecture in `teacherStream.ts` — system = persona + task + corpus (stable);
  input = FULL structured diff (JSON from `diffStructured`, not the top-3 ASCII table) + judgement
  + candidates. Client sends the structured diff (extend the POST body; keep old field for fallback).
- Retire the DIFF GLOSSARY (spec is now in context). Keep sanitizers but demote hard rejections to
  logged warnings where safe; keep the 5-word cue cap (choreography depends on brevity).
- Model upgrade per Phase 0 findings; make tier→model mapping env-overridable (already partly is).
- Keep «MARKER» contract byte-compatible. All existing tests green + new tests for corpus/prompt/body.
- Live smoke test if keys exist: run the two `test_output` fixtures through the new route, save
  outputs to `test_output/modernized_*`, compare qualitatively in ledger.
- Acceptance: teacher references scholarly motivation in smoke output; no client regression.

### Phase 2 — Conversation memory + student model  [status: DONE 2026-08-08, commits 0ec4ec7..7694336]
Results:
- `src/sessions/`: take records (diff digest + what the teacher said), JSON persistence in
  gitignored `data/sessions/` (50-take cap, 30-day prune, path-safe ids), history section (≤5 takes)
  appended LAST in input; MEMORY_RULES prompt block added only for session requests as a SUFFIX —
  stateless prompt byte-identical (tested end-to-end).
- Student profile: fire-and-forget structured-output side-channel on gpt-5.4-mini (PROFILE_MODEL),
  clamped arrays, errors swallowed. Client: per-page-load session id (`client/src/session.ts`).
- Latency: no measurable cost (interleaved A/B: stateless 1448ms vs with-history 1389ms medians).
- Smoke verified: "Noch immer zu rasch..." back-references 3/3; synthetic progress case recognized
  3/3 ("Schon viel ruhiger..."); profile fills tendencies/improvements correctly; caps held.
- Tests: 190 (151 → +39).
Caveats carried forward:
- Prune runs once per process start (note for Phase 5 worker deployment).
- No TEACHER_PROFILE=0 kill switch (3-line addition if wanted).
- Page reload = new lesson (deliberate; sessionStorage would persist it).
- "already told them" accumulates (capped 6) — Phase 3 may want decay.
- knip: test-only exports buildTeacherSaid, SESSION_TTL_MS, updateStudentProfile,
  buildProfileInput → Phase 5 sweep list.

### Phase 3 — Agentic pedagogy  [status: DONE 2026-08-08, commits 28b21b9..61d89bf]
Results:
- `src/plan/`: strict structured-output schema { monologue, demo{mode, range, dimensions} };
  validator clamps strength [0.05,0.5], ranges to take bounds, filters dimensions to measured
  types. Live clamp fired unprompted and was caught. Agentic = request flag; non-agentic prompt
  AND response byte-compatible (tested); «MARKER» parser reused, not forked.
- Client: `exaggerate()` takes per-dimension strengths; EXAGGERATION_TUNING caps proven inviolable
  vs adversarial strengths up to MAX_SAFE_INTEGER; `allDimensions(0.2)` reproduces pre-Phase-3
  numbers exactly. Strategy executes exaggerated / pure-reference / talk-only (mood chord holds
  through monologue; `playAudioBuffer` now genuinely used — closes Phase 0 note).
- Flag: `VITE_TEACHER_AGENTIC` env, `localStorage.TEACHER_AGENTIC` override, default OFF.
- Plans are pedagogically sensible: strength tracks severity; ranges genuinely narrowed; studio
  names ONE dimension where realtime names 2-3; studio chose `reference` 6/6 on the near-perfect
  fixture and never for needs_work. Realtime agentic 1.5-2.0s (under bar).
- Tests: 278 (190 → +88).
Caveats carried forward:
- **Serialized render**: in agentic mode the /perform render waits for the plan (legacy overlapped
  it) — wall-clock time-to-play grows by ~one render. Fix ideas: speculative render or split call.
- `none` mode never triggered live (no zero-deviation fixture); unit-tested only.
- Strategy tested at its own seam (mocked renderer/vocal/mood) — full runTake needs Java /perform.
- No UI toggle for the flag (Phase 5 item); `03_timid` range narrowing was trivial (one beat) —
  prompt could name a bar count if tighter wanted.
- knip sweep list grows: DEFAULT_EXAGGERATION_STRENGTH, MIN_DEMO_TICKS, STRENGTH_MIN/MAX,
  LESSON_PLAN_SCHEMA, describePlan (client).

### Phase 4 — Voice input (push-to-talk)  [status: DONE 2026-08-08, commits a6443e5..1eba84f]
Results:
- `/teacher-ask`: typed or spoken questions (gpt-transcribe, webm accepted natively, language hint
  from OUTPUT_LANGUAGE), answered by the same grounded teacher — prose, ≤60 words, shares the
  cacheable prompt prefix with the take path (tested: askInstructions.startsWith(takeInstructions)).
  Q&As recorded on the session (own qa[] array, kind-tagged); next take's history carries ≤3.
- Grounded-vs-control verified: grounded answers describe THIS performance ("zieht er das Tempo
  Schritt für Schritt zurück", "bei Grünfeld"); ungrounded control describes the score in general.
- Audio loopback: TTS question → transcription verbatim → grounded answer. Latency: transcription
  ~1.4-1.9s, answer LLM ~1.4-3.7s, **ElevenLabs v3 TTS 8-10s = 4x the thinking** —
  `ELEVENLABS_ASK_MODEL_ID` lever added (default unchanged); flip to a flash-class model in Phase 5.
- Client: hold-to-ask button behind TEACHER_VOICE flag (env + localStorage), default OFF = zero UI;
  mic-denied graceful; blank transcript → no LLM call.
- Tests: 326 (278 → +48). Take-prompt byte-identity tested across all five prompt variants.
Caveats carried forward:
- No jsdom → no component-level "flag off renders nothing" test (flag logic unit-tested; voice UI
  hangs off one showVoice gate). jsdom = Phase 5 call (optional).
- useVoiceQuestion hook untested as a whole (extractable logic tested in voiceInput.ts).
- No max recording length / auto-stop (10mb body limit is the backstop) → Phase 5 small item.
- knip additions: MAX_QA_PER_SESSION, HISTORY_MAX_QA, QA_HEADING, PREFERRED_MIME_TYPES,
  audioExtension.

### Phase 5 — Deployability + handoff PR  [status: DONE 2026-08-08, commits 760982a..7f46d36]
Results:
- **Worker rejected with reasoning** (fs corpus, disk sessions, process-lifetime caches are what
  make the latency numbers real): DEPLOYMENT.md documents Node service on the api.welte225.org
  host — systemd unit, Caddy AND nginx configs, 15-var env table (verified against source),
  CORS (`TEACHER_CORS_ORIGIN`, new src/cors.ts, subdomain/scheme-attack tested), rollback.
- Teacher URL resolution: `localStorage.TEACHER_URL` > `VITE_TEACHER_URL` > localhost-if-DEV —
  preserves the documented SPOKEN_FEEDBACK.md local workflow (brief's mixed-content premise was
  Safari-only) while production visitors stop paying failing probes. Deploy workflow exports repo
  vars only-when-non-empty (Vite env precedence gotcha).
- ElevenLabs ask default → `eleven_turbo_v2_5`: 650ms vs v3's 10240ms medians (15.8x), 0% WER
  loopback on all candidates; v3's extra 36% audio duration is pacing/warmth — documented,
  `ELEVENLABS_ASK_MODEL_ID=eleven_v3` is the way back. Take path untouched (v3 + timestamps).
- 30s recording auto-stop; sidebar toggles for agentic/voice (voice applies immediately);
  debug sidebar de-beiged (#f3f4f6/#e5e7eb).
- knip fully clean, zero ignores added: uuid removed (root), vitest added (was unlisted!),
  midifile-ts kept (config fixed — genuinely used), 59 "unused exports" were barrel re-exports
  (trimmed), stale .env.example rewritten from a grep of process.env.
- jsdom skipped with reasoning (Tone.js/WebMIDI transitive weight) → FUTURE.md.
- Verified: type-check + client tsc clean, 346/346 tests, knip clean, production build succeeds,
  bundle contains no localhost:3002 by default and bakes VITE_TEACHER_URL correctly.
- Cost measured: ~7-8k input tok/take, ~4-4.5k of it cache-hittable; ElevenLabs is the real
  per-use line item.

## Progress log (append-only, newest last)

- 2026-08-08 09:40 — Baseline verified: type-check clean, 105/105 tests green on `main`.
- 2026-08-08 09:47 — Snapshot branch `pre-ai-modernization` pushed (viz scripts committed);
  working branch `ai-modernization` created and pushed.
- 2026-08-08 09:50 — Ledger created. Phase 0 agent briefed.
- 2026-08-08 10:00 — Phase 0 DONE (commit 118a997): dead code removed (-155 lines), env audited,
  model inventory measured — current tiering latency-inverted; new mapping recorded above.
  Checks verified independently by orchestrator: type-check clean, client tsc clean, 105/105 tests.
  Phase 1 agent being briefed.
- 2026-08-08 10:25 — Phase 1 DONE (commits 136524f..a833f7d, 5 logical units): teacher grounded in
  scholarly corpus at no latency cost (~1.3s realtime); grounding verified in smoke outputs;
  balanced tier remapped luna→terra on measurement. Orchestrator verified independently: type-check
  clean, client tsc clean, 151/151 tests. Phase 2 agent being briefed.
- 2026-08-08 11:05 — Phase 2 DONE (commits 0ec4ec7..7694336, 4 logical units): session memory +
  student profile working and verified live ("Noch immer...", progress recognition 3/3); zero
  latency cost; stateless path byte-stable. Orchestrator verified: 190/190 tests, both tsc clean.
  Phase 3 agent being briefed.
- 2026-08-08 11:35 — Phase 3 DONE (commits 28b21b9..61d89bf, 6 logical units): model now plans the
  lesson (mode/range/dimensions/strength) with hard safety ceilings; plans verified sensible in
  24 live runs (studio: reference-demo 6/6 on near-perfect). Flag default OFF. Orchestrator
  verified: 278/278 tests, both tsc clean. Phase 4 agent being briefed.
- 2026-08-08 12:10 — Phase 4 DONE (commits a6443e5..1eba84f, 4 logical units): push-to-talk Q&A
  live-verified with audio loopback (perfect transcription; grounded answers beat ungrounded
  control); ElevenLabs v3 identified as the answer-latency bottleneck (lever added). Orchestrator
  verified: 326/326 tests, both tsc clean. Phase 5 (final) agent being briefed.
- 2026-08-08 12:45 — Phase 5 DONE (commits 760982a..7f46d36, 5 logical units): deployment path
  documented end-to-end, ElevenLabs turbo default (15.8x), knip clean, production build verified.
  Orchestrator verified the full battery independently. ALL PHASES COMPLETE — handoff PR being
  opened; merging and deploying remain the user's decision. Baseline 105 tests → final 346.
