# "Virtual Grünfeld"

## 1) Purpose

Build a prototypical AI web app (mobile/tablet friendly) that lets users **converse with a historical pianist’s rendition** (Alfred Grünfeld, 1905, Schumann *Träumerei*), request **places** in the music and **variants** (exaggerate dynamics/rubato, slower/faster, harmonic reduction). Basis: existing **MEI+MPM** reconstructions.
Primary output is **sound** (MEI+MPM → MIDI → audio). Score is rendered with **Verovio** for orientation/navigation and to **highlight** requested regions.

---

## 2) User stories (examples)

* “**Wie spielst du den Auftakt zu T. 2?**” → Parse locator → OMA → region → apply MPM → render/play → highlight region in Verovio.
* “**Spiele den Anfang bis Takt 3**” → Same; different locator.
* “**Kannst du nun die Dynamik an dieser Stelle übertreiben?**” → Modify MPM (dynamics) → re-render/play.
* “**Zeige mir die Stelle etwas langsamer!**” → Modify MPM (tempo factor) → re-render/play.
* “**Ich möchte die gleiche Stelle hören, aber als harmonischen Auszug.**” → Swap to reduction MEI+its MPM → render/play.
* “**Danke**” → stop current playback immediately.

---

## 3) Formats & Tools

**SDK:** OpenAI Agents SDK (TypeScript).
**Formats:** MEI, MPM (PPQ-based dates), MSM, MIDI, WAV/MP3, SVG.
**Tools:** `meico` (MEI+MPM→MIDI/MSM→audio), **MPM-modifier** (exaggerate/hide params, tempo scaling), **Verovio** (score SVG; selection/highlight).
*Assumption:* All MEI **repeats expanded** already.

---

## 4) High-level architecture

```
Browser (React + MUI)
  ├─ Chat UI (text input, minimal messages)
  └─ Verovio score panel (SVG; highlight region)

Node (TypeScript)
  ├─ Agents SDK runtime ("PianistAgent")
  │   ├─ Tools: filesystem, parsing, OMA↔ticks, meico, mpm-modifier, render, highlight
  │   └─ Guardrails: path whitelist, excerpt caps, timeouts
  ├─ REST API: /api/chat, /api/reconstructions, /renders/*
  └─ Filesystem (no DB)
       /assets/
         /full_reconstruction/
           score.mei
           performance.mpm
           info.json
         /harmonic_reduction/
           score.mei
           performance.mpm
           info.json
        /[... another reconstruction]
           score.mei
           performance.mpm
           info.json
       /renders/         # generated (gitignored)
         <hash>.mid | .msm | .mp3 | .wav | .log | .mpm
```

---

## 5) Agents design

### 5.1 Agent

**PianistAgent**
Role: “Alfred Grünfeld” who can play whole piece or specific places, exaggerate for demonstration, and play harmonic reductions.
Style: brief, precise; return **audio ASAP**, a one-liner only when something went wrong.

### 5.2 Tools (TypeScript contracts)

All tools are **typed** function tools exposed to the Agent.

```ts
// Common types
export type ReconId = "full_reconstruction" | "harmonic_reduction" | string;

export interface OMA {                   // canonical Open Music Address (see §7)
  from: { measure: number; beat?: number; beatOffset?: number };
  to?:  { measure: number; beat?: number; beatOffset?: number };
}

export interface RegionResult {
  oma: OMA;                              // normalized OMA
  meiXmlIds: string[];                   // notes/rests in selection (for highlight)
  startTick: number;                     // score-time ticks (MPM PPQ)
  endTick: number;                       // score-time ticks (MPM PPQ; exclusive)
  barsLabel: string;                     // e.g., "Anfang–T.3/1" or "Auftakt→T.2/1"
}

// Tool 1: list reconstructions
input:  { }
output: { reconstructions: Array<{ id: ReconId; label: string }> }

// Tool 2: parse NL locator (DE/EN) → OMA
input:  { text: string }
output: { oma: OMA, intent: "play" | "modify" | "stop" | "swap", modifiers?: ModifierSpec }

export interface ModifierSpec {
  exaggerate?: { dynamics?: number; rubato?: number; articulation?: number }; // 0..2
  tempo?: { factor: number }; // e.g., 0.9 slower, 1.1 faster
  hide?: { dynamics?: boolean; rubato?: boolean; articulation?: boolean };
  // If user says "an dieser Stelle", resolver will scope to last RegionResult
}

// Tool 3: OMA → region (MEI+MPM info.json)
input:  { reconId: ReconId, oma: OMA }
output: RegionResult

// Tool 4: apply MPM (compose/slice if needed) using meico
input:  { reconId: ReconId, region: RegionResult, mpmPath?: string }
output: { midiPath: string; msmPath?: string; log: string[] }

// Tool 5: modify MPM (exaggerate/hide/tempo) via MPM-modifier
input:  { mpmPath: string, modifiers: ModifierSpec }
output: { mpmPath: string; log: string[] }

// Tool 6: render audio
input:  { midiPath: string, format?: "mp3"|"wav" }
output: { audioPath: string; durationSec: number }

// Tool 7: swap reconstruction (e.g., to harmonic reduction)
input:  { reconId: ReconId }
output: { ok: true }

// Tool 8: stop playback (signal to frontend)
input:  { }
output: { ok: true }
```

---

## 6) REST API (minimal)

```http
POST /api/chat
{ message: string, reconId?: ReconId, locale?: "de"|"en" }
→ {
  reply: string,                                 // short text
  audio?: { url: string, format: "mp3"|"wav", durationSec: number },
  highlight?: { xmlIds: string[] },              // for Verovio to emphasize
  context?: { reconId: ReconId, oma?: OMA }      // for subsequent "an dieser Stelle"
}

GET  /api/reconstructions
→ { reconstructions: Array<{ id: ReconId; label: string }> }

GET  /renders/:file
→ audio or MIDI/MSM files (static)
```

---

## 7) OMA (Open Music Addressability) — canonical form

**Goal:** deterministically convert natural-language locators into **score-time** regions (independent of expressive timing), then to **MPM PPQ ticks**.

### 7.1 Canonical OMA grammar (internal)

* `m<N>[.b<B>[+o<O>]]` for a point; N=measure≥1; B=beat≥1; O=fractional offset in beats (0≤O<1).
* A region is `from..to` (inclusive → exclusive).
* Examples:

  * “Anfang bis T. 3 Schlag 1” → `from m1.b1 .. to m3.b1`
  * “Auftakt zu Takt 2” → `from (m2.b1 - 1 beat) .. to m2.b1`
  * “T. 5–6” → `from m5 .. to m7` (to = first beat of bar 7)

### 7.2 NL → OMA heuristics

* **“Anfang”** → `m1.b1`.
* **“bis T. X (Schlag Y)”** → `to mX.bY` (default `b1`).
* **“Auftakt zu T. X”** → `to mX.b1`, `from = previous beat`; if `m1` is an anacrusis (detected via MEI bar @@numb/@metcon/@right="incomplete"), start at `m1.b1`.
* If only **one point** is given, choose a **default span**: `[point .. point + 1 bar)` clamped to piece end.

### 7.3 OMA → ticks (score-time)

* PPQ = read from MPM encoding
* For each measure, compute beats using MEI meter (`@meter.count`, `@meter.unit`).
* `tick(point) = (sum_{i<measure} beats(i) + (beat-1) + offset) * (PPQ * beatUnitFactor)`

  * `beatUnitFactor = 4 / meter.unit` (i.e., quarter=PPQ).
* Region ticks: `[startTick, endTick)`.

### 7.4 Highlighting in Verovio

* Build the set of **MEI xml\:id** of events whose **score-time onset** ∈ `[startTick, endTick)` (score-time, not expressive).
* Return `xmlIds` to the frontend; the Verovio SVG elements carry these ids; add a highlight CSS class.

---

## 8) Reconstructions & metadata

### 8.1 Files

```
/assets/<reconId>/
  score.mei
  performance.mpm
  info.json
```

### 8.2 `info.json` (per reconstruction)

```ts
export interface ReconInfo {
  id: ReconId;                        // "full_reconstruction" | "harmonic_reduction" | ...
  label: string;                      // UI label
  // possibly more metadata to come at a later stage
}
```

---

## 9) End-to-end flows

### 9.1 Play a place

`parseNLToOMA` → `omaToRegion` → `applyMPM` → `renderAudio` → respond with audio + `xmlIds`.

### 9.2 “Übertreiben / langsamer / Dynamik übertreiben”

Use the **last region**; `modifyMPM` with the requested parameter(s); `applyMPM` (with new MPM path) → `renderAudio`.

### 9.3 Swap to harmonic reduction

`swapReconstruction("harmonic_reduction")` → use same OMA → `omaToRegion` (on reduction score) → render.

### 9.4 Stop

`stopPlayback` → frontend stops audio immediately (no server work).

---

## 10) meico & MPM specifics

* **MPM dates are PPQ-based** in **score-time**. All NL locators are resolved to **score-time ticks** before application.
* `applyMPM` **may** pass a region to meico (if supported) or slice MIDI **post-hoc** to `[startTick, endTick)`.
* If `modifyMPM` changes tempo/dynamics, write a **new MPM** to `/renders/<hash>.mpm` and pass that to `applyMPM`.
* Always generate MSM when feasible for diagnostics (optional in UI).

---

## 11) Hashing, caching, limits

* **Render key** = hash of `{reconId, oma, modifiers, toolVersions}` → reuse if files exist.
* **Caps:** default max region length = **60 s** of score-time (reject with a polite message).
* **Timeouts:** `modifyMPM` 30 s, `applyMPM` 90 s, `renderAudio` 60 s.
* **Paths:** whitelist `/assets` (read) and `/renders` (write); no `..`.

---

## 12) Frontend (React + MUI + Verovio)

* **Chat** (bottom), **Score panel** (top).
* On reply with `highlight.xmlIds`, add a CSS class to matching SVG elements.
* Single **audio player** with stop button; typing “**Danke**” also stops.
* Minimal latency UX: show “Wird gerendert …” while waiting; auto-play when ready.

---

## 13) Environment

```
# .env
OPENAI_API_KEY=...
AGENTS_MODEL=gpt-5o-mini
MEICO_BIN=/usr/local/bin/meicoApp
MPM_MOD_BIN=/usr/local/bin/mpm-modifier
RENDER_AUDIO_FORMAT=mp3
RENDER_MAX_SECONDS=60
```

---

## 14) Implementation stubs (TypeScript)

```ts
// src/types.ts
export type ReconId = string;
export interface OMA { from:{measure:number;beat?:number;beatOffset?:number}; to?:{measure:number;beat?:number;beatOffset?:number}; }
export interface RegionResult { oma:OMA; meiXmlIds:string[]; startTick:number; endTick:number; barsLabel:string; }

// src/tools/parseNLToOMA.ts
// DE keywords: "Auftakt", "T.", "Takt", "Schlag", "Anfang", "bis", "langsamer", "übertreiben", "Dynamik", "Danke".
export function parseNLToOMA(text:string): { oma?:OMA; intent:"play"|"modify"|"stop"|"swap"; modifiers?:ModifierSpec; targetReconId?:ReconId } { /* ... */ }

// src/tools/omaToRegion.ts
// Use MEI + info.ppq + meter parsing → ticks; map ticks → xmlIds via MEI traversal (score-time onset).
export function omaToRegion(reconId:ReconId, oma:OMA): RegionResult { /* ... */ }

// src/tools/modifyMPM.ts (wrap CLI)
export function modifyMPM(inPath:string, spec:ModifierSpec): Promise<{mpmPath:string, log:string[]}> { /* ... */ }

// src/tools/applyMPM.ts (wrap meico)
export function applyMPM(reconId:ReconId, region:RegionResult, mpmPath?:string): Promise<{midiPath:string, msmPath?:string, log:string[]}> { /* ... */ }

// src/tools/renderAudio.ts
export function renderAudio(midiPath:string, format:"mp3"|"wav"="mp3"): Promise<{audioPath:string, durationSec:number}> { /* ... */ }
```

---

## 15) Testing checklist

* NL→OMA: “Auftakt zu T. 2”, “Anfang bis T. 3 Schlag 1”, “T. 5–6”.
* OMA→ticks: verify with hand-computed bar/beat grid for multiple meters.
* Modify MPM: dynamics only; rubato only; tempo factor; combined.
* Swap reconstruction: full ↔ reduction; same locator works on both.
* Highlight: xmlIds correspond to audible region boundaries.
* “Danke” stops playback instantly.

---

## 16) Acceptance criteria

* ✅ All exemplar queries produce correct **audio** and **score highlight**.
* ✅ NL locators map deterministically to **OMA** and then to **MPM PPQ ticks**.
* ✅ Variants (dynamics/rubato/tempo) work via `MPM-modifier`.
* ✅ Swap to **harmonic reduction** works (if present).
* ✅ No DB; **filesystem-only**; safe paths; cached renders reused.

---

**Notes**

* If MEI meter changes mid-piece, recompute grid per measure.
* If anacrusis detection is ambiguous, default **one beat** before the target bar (clamped to start).
* If the user says “an dieser Stelle”, use the **last RegionResult** in context.
