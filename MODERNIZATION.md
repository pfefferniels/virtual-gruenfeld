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

### Phase 0 — Baseline & housekeeping  [status: IN PROGRESS]
- Verify local `.env`: which keys exist (OPENAI_API_KEY, ELEVENLABS_*). Never print values.
- Query OpenAI `GET /v1/models` with the local key; record actually-available current model IDs here
  (do not trust guesses; config currently pins `gpt-5.2` which may be stale).
- Remove dead code: unused cue-library runtime path, `REALTIME_PLAYBACK_DEADLINE_MS` plumbing.
  Keep `renderCueLibrary.ts` only if something imports it.
- Acceptance: checks green, ledger updated with model list, dead code gone.

### Phase 1 — Grounded teacher  [status: TODO]
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

### Phase 2 — Conversation memory + student model  [status: TODO]
- Server-side take history per session (in-memory + JSON persistence): each take's judgement,
  diff summary, and what the teacher said. Include compact history in the model input.
- Student model: persistent structured profile (recurring tendencies, addressed issues, trajectory)
  the model updates each take (structured output side-channel).
- Teacher can compare takes ("better than last time"). Client passes a session id.
- Acceptance: two-take smoke test shows the second reaction referencing the first.

### Phase 3 — Agentic pedagogy  [status: TODO]
- Replace fixed choreography constants with model decisions: new structured response schema
  (lesson plan): { reaction, cues[], demo: { range, dimensions: [{type, strength}], mode:
  exaggerated|reference|none } }. Server validates against safety bounds
  (tempoSafety/dynamicsSafety logic).
- Client `strategies/` executes the plan: `exaggerate()` takes model-chosen dimensions/strength
  instead of global 0.2; demo can be the pure reference; demo can be skipped (talk only).
- Feature flag `TEACHER_AGENTIC=1`; legacy path remains default until smoke-validated.
- Acceptance: plan-driven take runs end-to-end in a scripted client test with mocked LLM; live smoke ok.

### Phase 4 — Voice input (push-to-talk)  [status: TODO]
- Feature-flagged push-to-talk: mic → transcription (OpenAI audio transcription) → question enters
  the same conversation → answer spoken via existing ElevenLabs path. No realtime API yet
  (documented as future work in FUTURE.md with GPT-Realtime-2 / Gemini Live notes).
- Degrades cleanly without keys/mic permission.
- Acceptance: flag off = zero behavior change; flag on = ask "warum?" and get a grounded spoken answer.

### Phase 5 — Deployability + handoff PR  [status: TODO]
- Make the teacher service deployable: `worker/` Cloudflare Worker (or documented alternative)
  proxying teacher-stream + TTS with server-side keys; `VITE_TEACHER_URL` wiring in client config
  + deploy workflow (branch only — DO NOT deploy, DO NOT merge).
- Write `DEPLOYMENT.md` (exact steps for the user to flip it on).
- Final sweep: knip dead-code pass, README update, FUTURE.md (realtime voice, RUMAA comparison,
  Pianist Transformer notes).
- Open a PR `ai-modernization` → `main` with a full description. Merging is the user's decision.
- Acceptance: PR open, CI-equivalent checks green, ledger closed out.

## Progress log (append-only, newest last)

- 2026-08-08 09:40 — Baseline verified: type-check clean, 105/105 tests green on `main`.
- 2026-08-08 09:47 — Snapshot branch `pre-ai-modernization` pushed (viz scripts committed);
  working branch `ai-modernization` created and pushed.
- 2026-08-08 09:50 — Ledger created. Phase 0 agent being briefed.
