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
   (deterministic moat, 63 tests), and what `client/src/services/mpmRenderer.ts` plays — it
   reproduces the retired Java renderer's `/perform` note for note, in-process via espressivo.

## Context-management protocol

- Orchestrator (main session) stays thin: briefs subagents, reviews diffs, runs checks, commits,
  updates this ledger. Heavy reading/implementation happens in **subagents with fresh contexts**.
- Every subagent brief must include: this file's path, the phase spec below, and the key-file map.
  Subagents report back concise structured summaries, not file dumps.
- If the orchestrator context is compacted or lost: re-read this file, `git log --oneline -15`,
  and `git status` — that is the complete state.

## Key-file map (verified 2026-08-08; expressive rows re-verified 2026-08-26)

| Concern | File |
|---|---|
| The only LLM call | `src/routes/teacherStream.ts` (OpenAI Responses API, non-streaming) |
| Prompt | `src/prompts/teacherStream.ts` (monologue, «JUDGE»/«m2.3» markers, German) |
| Model config | `src/config.ts` (3-tier: gpt-4.1-mini / gpt-5-mini / gpt-5.2) |
| TTS | `src/tts/synthesizeWithTimestamps.ts` (ElevenLabs v3, char timestamps) |
| The student's playing as a document | `client/src/student/` (`scaffold.ts` reads Grünfeld's slots, `fit.ts` solves them) |
| Evidence | `client/src/mpm/evidence.ts` → `compare.ts` (JND + audibility gate) + `pair.ts` (raw units), in `client/src/workers/` |
| Diff + reduction | `client/src/mpm/diff.ts` (`PER_TYPE_TOP_N=3` truncation, ASCII table) |
| Counter-performance | `client/src/mpm/counter.ts` (per-instruction pivot away from the student, legacy caps, strength 0.2) |
| Corrected-take demo | `client/src/mpm/path.ts` (`diffMpm`, the k costliest edits on the student's own document) |
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
- ElevenLabs ask default → `eleven_turbo_v2_5`: re-measured after the network warning with an
  interleaved 4-round A/B timed to response headers (bandwidth-proof): v3 generation 9667ms
  (spread 1.15x) vs turbo 796ms — 12.1x; network instability appeared only in transfer times as
  expected. 0% WER loopback; v3's extra 36% audio duration is pacing/warmth — documented,
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
- 2026-08-08 13:10 — Post-run correction (user request): motivation vocabulary aligned with
  mpmify's canonical four-step scale `intensify (++) / move (+) / calm (-) / relax (--)`
  (mpmify Transformer.ts activityMotivations; semantics from mpm-desk intensityCurve.ts sign/gain;
  both repos share the same file:../mpmify checkout). Corpus parser maps the legacy export
  vocabulary onto the scale WITHOUT keeping legacy labels (user decision): intensification→
  intensify, relaxation/relax→relax, forward-lilt→move, shading/resonance/pianissimo→calm.
  Mapped distribution over the 158 argumentations: intensify 28, move 10, calm 18, relax 27,
  unknown 75. Primer rewritten to the four categories. Fixed a Phase 1 bug that normalized the
  CANONICAL 'relax' to legacy 'relaxation'. 346/346 tests, knip clean.
  NOTE: client/public/info.json still carries the old vocabulary — when regenerated from
  mpm-desk it will emit the canonical four natively and the mapping becomes a pass-through.
- 2026-08-08 13:30 — Synced the current mpm-desk export (user request): client/public/info.json +
  score.mei (← transcription.mei) + assets/all/performance.mpm all from ../mpm-desk/public
  (matched set, 2026-04-02; note IDs verified identical, 532 notes). 136 argumentations, native
  canonical motivations (intensify 41 / calm 30 / relax 30 / move 27 / unknown 8 — was 75 unknown),
  certainties substantively revised (plausible 86 now dominant). Concept map gained InsertTempo→
  tempo, InsertMetadata→metadata; 6 data-pinned tests re-anchored to the new content. 346/346.
  Notes: compact-vs-full digest distinction nearly collapsed (12,450 vs 12,861 chars) since almost
  all argumentations now carry motivations — CORPUS_DEPTH tiering could be revisited;
  new top-level `secondary.tempo` key in info.json is ignored by the corpus parser (mpmify's
  importWork handles it); assets/all/info.json is orphaned (referenced by no code) and left as-is;
  a real in-app take against the new chain (which now uses InsertTempo) has NOT been run — mpmify
  is the same checkout mpm-desk uses, so importWork supports it, but verify on first play.
- 2026-08-08 16:45 — Grünfeld voice integrated (user request): the companion project
  ../gruenfeld-style distilled how Grünfeld actually talked (gruenfeld-styleguide.md — letters,
  feuilletons, interviews, critics' reception vocabulary). New src/prompts/gruenfeldVoice.ts
  carries a ~3k-char prompt-ready distillation (stance: Vormachen statt Erklären, judgement as
  Empfindung, correction as Merksatz, praise superlative / blame as Litotes; his praise scale and
  Viennese idiom; sentence shapes; imagery: singen/perlen/Orchester/Samtpfote) with an explicit
  DOSAGE section so word limits and format rules always outrank the voice. Inserted between
  PERSONA and the MPM primer in the byte-stable cached prefix — applies to take, QA, memory and
  agentic variants alike. Deliberately excluded: letter formulas, success statistics, war
  rhetoric, first-person claims to BE Grünfeld (app framing stays "modeled after"; recording and
  editor remain third person). Full prompt 19.0k → ~22k chars. 2 new prompt tests; README count
  158→136 fixed alongside. Voice effect on live output not yet auditioned — judge on next real take.
- 2026-08-08 17:05 — Framing correction (user request): the teacher does not merely imitate
  Grünfeld — it IS Grünfeld, first person. PERSONA now opens "You are Alfred Grünfeld"; the roll
  is "your own playing", the corpus "your own intentions, written down by a careful listener";
  QA answers "as the man himself"; diff refValue "is yours". Voice block rewritten to second
  person (YOUR STANCE/WORDS/SENTENCES) with an explicit first-person allowance („so spiel ich
  das") while roll/reconstruction/editor stay backstage. Guard kept: never claim a specific
  intention the record does not document. Dialog.tsx's outside description ("modeled after")
  and profile.ts (unspoken note-keeper) intentionally unchanged.
- 2026-08-26 — **espressivo only: mpmify and mpm-ts removed** (branch ai-modernization, commits
  097779d..HEAD, eight slices). The expressive pipeline was rebuilt on espressivo alone; the Java
  MPM renderer had already gone in-process (b750465). What replaced what:
  - **The reference is a document, not a rebuild.** Boot used to run `mpmify(baseMsm, info.json)`
    — 494 transformer calls over 136 argumentations — to *manufacture* a reference MPM whose
    instruction ids the diff could join on. Grünfeld's document already prints those ids, so the
    client now fetches `client/public/performance.mpm` (the mpm-desk snapshot, byte-identical to
    `assets/all/performance.mpm`, pinned by a test). It is the editorial document: the sound's
    base, the scaffold every `xml:id` is read from, what the server's corpus reads, and what the
    comparison side is fitted from per take — see the R2 note below. It is the only MPM the app
    fetches.
  - **A take is fitted, not re-chained.** `client/src/student/` writes the student's playing into
    Grünfeld's own instruction slots (`scaffold.ts` reads them, `fit.ts` solves them on espressivo's
    primitives — `fitTransitionCurve` with a seeded RNG, the tick⇄ms algebra, `rubatoAt`). The
    student's MPM is then a document like his, and pairing is a `Map` lookup on `${type}::${xml:id}`.
  - **The comparison has two layers.** `compareMpm` prices the whole window in JND and gates out
    what is inaudible (`mpm/compare.ts`); `mpm/pair.ts` says what changed where, in bpm, velocity
    and milliseconds — the raw units the severity ladder and the German cue table were calibrated
    on. `mpm/evidence.ts` composes both, off the main thread (`workers/evidence.worker.ts`).
  - **The counter-performance pivots per instruction.** `mpm/counter.ts` writes onto the cut
    editorial document, at the same `xml:id`, for every attribute the take actually paired: ratio
    attributes `x' = x_ed·(ref_fit/stu)^a`, signed offsets `x' = x_ed − (stu − ref_fit)·a`, with
    per-attribute strengths and the legacy caps (±12 velocity, ±10 bpm, ±0.2 multiplier), only for
    types the take measured, confined to the range, the reference kept pristine. An identity take
    is a no-op by construction. (An earlier draft used espressivo's `exaggerateMpm(reference,
    {center})`: one exponent per type serves only one side of the neutral, so it refused 8 of 22
    sites on an identity take. It remains available for whole-performance sampling.)
  - **A third demonstration: `path`.** `mpm/path.ts` runs `diffMpm` over the two cut documents and
    plays the student's *own* take back with the k costliest edits applied — "your playing,
    corrected where it matters". Skipped above 12 bars, where the edit script's ~n^3.2 bites.
  - The mood chord, the cue scheduling and the teacher/LLM server contract are unchanged.
  - **Two findings the old chain had been hiding.** (a) *Tempo was silent.* The stale `mpmify/lib`
    the app actually ran did not register `InsertTempo`, so the boot-built reference carried no
    tempo at all — and with no tempo, no rubato, no `relativeDuration`, no pedal. Of the seven
    dimensions the teacher believed it heard, three reached the LLM. Six do now. (b) *Articulation
    is inert in `performance.mpm` itself*: its `articulationMap` has no `<style>` switch, so
    `@name.ref` resolves to nothing and neither the renderer nor `compareMpm` applies its 47
    instructions — scaling every `relativeDuration` ×0.7 changes 0 of 476 rendered notes. The
    audibility gate rightly suppresses the type. Fixing it is a rebake of the editorial document
    (one `<style name.ref="…"/>` in that map) and is Niels' call, not this run's.
  - **R2, taken, then taken further: the comparison side is Grünfeld fitted _per take_.** Writing
    one performance by hand in an editor and solving it from onsets are not the same act — an
    identity take measured 22 bpm and 9.22 JND apart — so the comparison side is Grünfeld's own
    playing through the student's fitter. The first version of that was a committed asset,
    `client/public/reference.fitted.mpm`, fitted once from `performMsmToData` note *data* over the
    whole piece. Browser run #2 measured what it left behind: a take does not arrive as note data,
    it arrives as **MIDI** — unisons folded, velocities integer, the matcher's assignment on top —
    and over its own window, not the piece; `<ornament @scale>` is a ratio of the velocity gradient
    across a rolled chord and is sensitive to exactly that. A flawless take was criticised on its
    ornaments in *every* passage: 3 events at 3.35 JND over m5–m9, 3 at 3.64 over m1–m5, 3 at 4.10
    over m9–m13, always `<ornament @scale>`/`@intensity` ("oben mehr zeigen", severity `large`),
    plus one window-edge tempo slot.

    So the reference now goes through the student's own path at take time, inside the evidence
    worker: `renderMsm(scoreMsm, performance.mpm, range)` → `implantLocal(scoreNotes, midi)` →
    `fitStudent` → the take's `referenceFitText`, which `pair.ts`, `compare.ts`, `counter.ts` and
    `path.ts` all read as the reference. The two fitted documents come out **byte-identical** on an
    identity take, so it is 0 events, 0 peaks and exactly 0 JND by construction, and S4 §2's
    window-edge effects go with it. Memoized per range (a student repeating a passage pays once);
    cost 90–230 ms for eight bars, off the main thread. `reference.fitted.mpm`,
    `scripts/fit-reference.ts` and `mpm/fittedReference.test.ts` are deleted. Cost, unchanged and
    documented: the `refValue` numbers the teacher quotes come from a fitted document, the corpus
    prose from the editorial one. One fixture moved with it — `ornament @scale ×0.5` measured 0.67
    JND once the bias was gone and the gate rightly silenced it, so the altered-take fixture is
    ×0.25, the smallest swept value that crosses one JND.
  - Lines, per slice (excluding the two committed `.mpm` assets, +1108):
    S1 measured note shape +212/−92 · S2 reference as text +682/−0 · S3 the fitter +3375/−0 ·
    S4 fitted reference +183/−16 and pairing +1911/−7 · S5 the pipeline switch +1070/−1018 ·
    S5 fix +555/−34 · S6 counter-performance +1646/−746 · S7 `path` mode +1607/−115 ·
    S8 removal (this entry). Net over the run: +11,341 / −1,941 across 95 files.
  - **S8, the removal itself:** `mpmify` and `mpm-ts` are gone from `package.json`,
    `package-lock.json`, `knip.json` and `.github/workflows/deploy.yml` (two checkout and two build
    steps; espressivo and react-pianosound stay, Node 22 stays). `generate_test.ts` and
    `visualize_implant.ts` were rewritten onto the client's own modules — `generate_test.ts` had
    carried a ~530-line private copy of the diff and the exaggeration because the browser code
    could not be imported outside Vite, and it no longer needs it (1427 → 838 lines);
    `client/tsconfig.scripts.json` + `npm run type-check:scripts` keep both honest.
    `test_pipeline.ts` and `test_teacher_sync.ts` were deleted: both tested private copies of
    objects that no longer exist, and vitest covers what they covered (diff and pairing:
    `mpm/pair.test.ts`, `mpm/compare.test.ts`, `mpm/evidence.test.ts`; exaggeration caps, range
    confinement, determinism and non-mutation: `mpm/counter.test.ts`; render:
    `services/mpmRenderer.test.ts`; timing map and cue spacing: `teacherCues.test.ts`).
  - Verified: 645 tests green (352 at the start of the run), `npm run type-check` and
    `cd client && npx tsc --noEmit` clean, `npm run knip` clean, `cd client && npm run build`
    succeeds. `node_modules` holds espressivo and nothing else MPM-shaped.
