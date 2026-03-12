# Architecture Refactoring Plan

## Goal
Clean separation of concerns, eliminate duplication, make the pipeline explicit and composable.

## Target Structure

```
client/src/
├── Dialog.tsx              ← UI only: buttons, debug panel, display
├── useTake.ts              ← hook: owns the take lifecycle
│
├── pipeline/
│   ├── types.ts            ← Take, PipelineContext, TeacherStrategy
│   ├── takeRunner.ts       ← orchestrates: match → diff → respond
│   ├── strategies/
│   │   ├── exaggerated.ts  ← current: exaggerate → perform → cue → play
│   │   └── reduction.ts    ← future: harmonic reduction mode
│   └── boot.ts             ← fetch info.json, score.mei, build ref MPM
│
├── mpm/
│   ├── build.ts            ← mpmify()
│   ├── diff.ts             ← collectDiffs, diffStructured, diff
│   ├── diffFormat.ts       ← formatTable, tempoRow, dynamicsRow (LLM text)
│   ├── exaggerate.ts       ← exaggerate()
│   └── cueText.ts          ← cueTextForDiff() + future i18n
│
├── cues/
│   ├── planning.ts         ← pickCueCandidates, planTeacherCues, resolve
│   ├── prepare.ts          ← prepareTeacherCues, collision resolution
│   └── render.ts           ← renderCueAudioBuffers (HTTP call)
│
├── services/
│   ├── mpmRenderer.ts      ← Java service client (convert, perform)
│   └── api.ts              ← Node server calls (explain, plan-cues, render-cues, judge)
│
├── shared/
│   ├── constants.ts        ← PPQ, BEATS_PER_MEASURE, tickToPos
│   ├── tts.ts              ← ALLOWED_V3_TAGS, normalizeV3Tag, sanitizeCueForSpeech
│   └── severity.ts         ← severityWeight, severityRank, DiffSeverity
│
├── matcher.ts              ← untouched
├── midi.ts                 ← untouched
├── smf.ts                  ← untouched
├── judgement.ts             ← untouched
├── dynamicsSafety.ts        ← untouched
└── tempoSafety.ts           ← untouched

server/
├── server.ts               ← Express app + route wiring only
├── routes/
│   ├── explain.ts
│   ├── planCues.ts
│   ├── renderCues.ts
│   └── judge.ts
├── prompts/
│   ├── explanation.ts
│   ├── cuePlanning.ts
│   └── judgement.ts
├── tts/
│   ├── synthesize.ts        ← synthesizeCueAudio + cache
│   └── cueLibrary.ts        ← readCueLibrary, file I/O
└── shared/
    └── tts.ts               ← single source of truth for V3 tags
```

## Execution Order

### Phase 1: Extract shared utilities (kills duplication, zero risk)
- [ ] Create `client/src/shared/constants.ts` — PPQ, BEATS_PER_MEASURE, tickToPos
- [ ] Create `client/src/shared/severity.ts` — severityWeight, severityRank, DiffSeverity
- [ ] Create `client/src/shared/tts.ts` — ALLOWED_V3_TAGS, V3_TAG_ALIASES, normalizeV3Tag, sanitizeCueForSpeech
- [ ] Update all imports in mpm.ts, teacherCues.ts, judgement.ts, server.ts, renderCueLibrary.ts

### Phase 2: Split server.ts into modules
- [ ] Extract prompts into `src/prompts/`
- [ ] Extract TTS logic into `src/tts/`
- [ ] Extract route handlers into `src/routes/`
- [ ] server.ts becomes ~30 lines of Express wiring

### Phase 3: Split mpm.ts into focused modules
- [ ] Extract `client/src/mpm/build.ts` — mpmify()
- [ ] Extract `client/src/mpm/diff.ts` — collectDiffs, diffStructured, diff
- [ ] Extract `client/src/mpm/diffFormat.ts` — formatTable, row formatters
- [ ] Extract `client/src/mpm/exaggerate.ts` — exaggerate()
- [ ] Extract `client/src/mpm/cueText.ts` — cueTextForDiff()
- [ ] Barrel export from `client/src/mpm/index.ts`

### Phase 4: Create services layer
- [ ] Create `client/src/services/mpmRenderer.ts` — Java service client (configurable base URL)
- [ ] Create `client/src/services/api.ts` — pure HTTP calls to Node server
- [ ] Move orchestration out of current api.ts into cues/

### Phase 5: Extract cue modules from api.ts
- [ ] Create `client/src/cues/render.ts` — renderCueAudioBuffers
- [ ] Create `client/src/cues/prepare.ts` — prepareTeacherCues, collision resolution
- [ ] Create `client/src/cues/planning.ts` — from teacherCues.ts

### Phase 6: Pipeline abstraction + Dialog cleanup
- [ ] Define Take type in `client/src/pipeline/types.ts`
- [ ] Extract boot sequence into `client/src/pipeline/boot.ts`
- [ ] Create takeRunner in `client/src/pipeline/takeRunner.ts`
- [ ] Create exaggerated strategy in `client/src/pipeline/strategies/exaggerated.ts`
- [ ] Create `client/src/useTake.ts` hook
- [ ] Dialog.tsx becomes a thin UI shell

## Notes
- Each phase is independently shippable and testable
- matcher.ts, midi.ts, smf.ts, judgement.ts, dynamicsSafety.ts, tempoSafety.ts stay untouched
- The `any` casts on MSM/MPM notes are a separate concern (depends on mpm-ts types)
- German cue text extraction in Phase 3 prepares for i18n but doesn't implement it yet
