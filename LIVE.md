# The live lesson

A design for the rework: one Disklavier, no speech, Grünfeld answering by playing.

The student plays the instrument. The app listens continuously, tracks where they are in the
score, scores what they played against Grünfeld's reading, and when there is something worth
showing, Grünfeld takes the keyboard and plays the passage himself on that same piano. Nothing
is spoken. The argument is made by playing.

Everything below that carries a number was measured on 2026-09-20, against the real score, the
real reconstruction and the live Jev API, unless it is marked as sourced from the literature or
as needing a browser or the instrument to settle.

## 0. Where the data comes from

The reconstruction is published at `https://welte225.org/mpm/` and other projects depend on it.
This repository keeps no copy.

| file | what it is |
|---|---|
| `transcription.mei` | the score. Byte-identical to the `score.mei` this repo used to ship |
| `score.msm` | the MSM directly, so `convert(mei)` is no longer run at boot (129.5 ms saved, and the app's MSM is the one the reconstruction was fitted against rather than a re-derivation) |
| `performance.mpm` | Grünfeld's performance |
| `work.json` | the editorial record, formerly `info.json` |

`harmonic_reduction.mei` has no upstream counterpart and stays in `client/public/`. The files are
served with `Access-Control-Allow-Origin: *`, so the browser fetches them directly at boot.

Nothing is committed. `scripts/fetch-reconstruction.ts` mirrors the documents into
`client/public/` for the test suite and the developer scripts, which read from disk; the mirror is
gitignored and refreshed with `npm run fetch:data -- --force`. That keeps the tests offline and
fast without this repository holding a version that can drift. Two committed copies existed before
and had already drifted — `assets/all/score.mei` was 125 kB against `client/public/score.mei` at
472 kB, and a test existed whose only job was to assert the two MPM copies still matched. Both
copies and that test are gone.

`info.json` is read by nothing and is not mirrored.

The canonical `performance.mpm` states no `@endDate` on any slot, where the copy this repo shipped
stated 120. `scaffold.ts` already derives a span from the following slot's date when none is
stated, and that derivation is now the only path. Spans therefore widen wherever slots are not
contiguous. Re-measured, that **shortens** the window floors in §1 rather than lengthening them:
dynamics from 3.6 s to 2.0 s, tempo from 4.0 s to 3.6 s, and an identity take stays silent at every
window length down to a single quarter. `scaffold.ts:178` and `scaffold.test.ts:64` still assert
that the reference always states `@endDate` and need correcting.

The published `score.msm` is not textually identical to `convert(transcription.mei)` (57,642 against
54,657 characters) but both yield the same 458 reference notes, so the switch is safe. The
difference is worth understanding rather than assuming, since only one of the two is what the
reconstruction was fitted against.

## 1. What actually binds

Four constraints shape the design, and only one of them is a latency problem.

**Musical evidence is the bottleneck, not compute.** Measuring a window of playing against
Grünfeld takes 42–74 ms warm, 87–148 ms cold, and rendering the answer takes another 17–18 ms.
But the *shortest window that yields a correctly-named verdict is one bar*, and at Grünfeld's
tempo one bar is 3.96 seconds. Growing a window over a real take:

| verdict | needs | seconds |
|---|---|---|
| dynamics | 2 quarters | 2.0 |
| tempo | 3 quarters | 3.6 |
| any correctly-named verdict | 2 quarters | 2.0 |
| rubato | 4 bars | ~19 |

So the system is never waiting to think. It is waiting to have heard enough. A couple of seconds
of playing is the price of an opinion, and everything else in the chain is noise beside it.

A single quarter is unusable at any deviation size: the window-edge effect reports `articulation`
with an absurd aggregate JND (28.8, 63.6 and 92.6 for three sizes of a pure dynamics deviation).
Two quarters is the floor below which the gate does not merely stay shut, it names the wrong thing.

The size of the deviation matters as much as the window. A uniform `volume ×1.25` sits *below* the
audibility gate at every window length, aggregate JND 4.6–5.1, and produces nothing. At `×1.6` and
`×2.0` it reports `dynamics` correctly from two quarters onward. That is the gate behaving as
designed rather than a limitation: when both sides are fitted the same way, a modest uniform gain
on top of Grünfeld's own shaping is genuinely within tolerance.

**The live gate is tempo and dynamics. Nothing else is identifiable in a short window.**

*Rubato* is mislabelled, not missed. Below four bars it is reported as `tempo` and `ornament` at
every window from two quarters to three bars, because `fit.ts:618-623` refuses a rubato that only
re-describes the tempo fit. This is a real loss: rubato is close to the centre of what makes
Grünfeld's reading his.

*Articulation* is the opposite failure. It became a working dimension when the canonical edition
added `<style name.ref="performance_style"/>` to its map, and when articulation is genuinely what
changed the verdict is right in both directions — `artic ×0.6` gives `relativeDuration, sev=large,
dir=more, ref=1.1798 stu=0.7010`. But rubato, accentuation and ornament all leak into it, and the
leak is larger than the signal: a rubato ×2 take reads `ref=1.1382 stu=0.2352` at m5.1, severity
`large`, a bigger apparent articulation error than a genuine ×0.4 articulation take. A student
using rubato would be told "mehr Legato" more confidently than one actually playing staccato.
`fit.ts:770-779` solves `relativeDuration` as the median of measured over prescribed duration, so
anything that moves onsets moves measured durations. Tempo and dynamics do not leak.

Articulation is therefore worth fixing and not worth gating on until it is. The floor is also
coarse: a 30 % shortening measures 5.05 JND and is discarded as wholly sub-threshold, 40 % is
caught.

**The aggregate JND is not a usable trigger.** Identical rubato playing reads 131.88 JND at two
quarters, 38.19 at one bar and 18.91 at four bars. It is not comparable across window lengths.
The stable signals are `measuredTypes` being non-empty and per-event severity.

**The instrument enforces turn-taking, but not patience.** Eighty-eight keys, one action.
Grünfeld cannot sound a key the student is holding, so literal layering is unavailable. What is
available, and is the whole point of the single instrument, is that *the keys moving are
themselves the interruption*. He starts; the student feels the action move under their hands and
stops. There is no need to wait for a phrase to end, and the design does not.

**He plays fragments.** Annette Hullah, writing in 1906 while Leschetizky was still teaching:
"He plays a great deal during the lesson in a fragmentary way, but rarely anything straight
through." The evidence window and the demonstration are different lengths. Four seconds of
student playing buys the opinion; the answer is the chord, the turn of the phrase, the one
gesture — a second or two, played and played again, not a passage performed.

## 2. The four layers

```
  listen  ──►  track  ──►  score  ──►  deliberate  ──►  commit  ──►  play
  (main)       (worker)     (worker)     (Jev)           (main)      (Disklavier)
  every msg    ~250 ms      per bar      speculative     at a        MIDI out
                                         367 ms p50      boundary
```

**Listen.** The existing MIDI handler, unchanged in shape. What changes is that the silence timer
stops meaning *the take is over, go analyse it* and starts meaning *the hands are off, this is a
place Grünfeld could come in*. `SILENCE_BASE_MS = 1200` is already the right order.

**Track.** Re-run the existing matcher on a growing window every ~250 ms, in a worker. Measured
cost 0.4–2 ms against 458 reference notes, so an incremental matcher is unnecessary; what is
necessary is getting it off the main thread, where it sits today (`midi.ts:91` → `api.ts:22`).
`range.to` serves directly as the position read-out.

Two things must be fixed here, and the first is a bug in the app as it stands:

- **`dateWindow` defaults to ±30000 ticks, about ten bars.** A student playing the second pass of
  A has both passes inside that window, and `smithWaterman` breaks ties toward the earliest
  reference index (`matcher.ts:404-409`). Measured: 0 of 53 notes matched to the correct pass,
  and supplying the *correct* `dateHint` does not help, because the window is too wide to bite.
  At ±5760 to ±11520 ticks it is 53 of 53. The usable band is two to four bars either side.
- **The second repeat has no dates of its own.** The first is written out in `score.mei` as
  duplicated measures; `||: B A' :||` is not, so a student on its repeat can only match onto the
  first pass. No matcher recovers a distinction the score does not encode. Expanding that repeat
  in the MEI, as the first one already is, converts a tracking problem into a matching problem the
  existing code solves.

Beyond that, position needs a structural cursor — which of `A₁ | A₂ | B A' (1st) | B A' (2nd)`
the student is in — carried as hypothesis state rather than inferred from dates. parangonar's
`RepeatIdentifier` shows how to make that cheap: pay the dynamic programming once over a single
matrix, then score each candidate traversal by backtracking through it. A′ and A *are* locally
distinguishable wherever they differ, so precompute that diff and let confidence move sharply at
those onsets and barely elsewhere. Switch hypotheses only on a sustained margin, never on one
note.

Nakamura's symbolic-MIDI study gives the budget for the case that matters most in a lesson, a
student stopping mid-phrase and restarting elsewhere: with an explicit skip model and resumption
priors, recovery costs about two chords; with a uniform prior, 3.3; with no skip model, six to
eight, failing outright a quarter to a third of the time.

**Score.** On each completed bar, run the existing chain over the last N bars: `readScaffold` →
`fitStudent` → `takeEvidence`. Every one of these is already a pure function parameterised by a
range and does not care that the range is not a whole take. Quantise the window to the bar grid so
the reference-fit memo hits — `evidence.ts:148` keys on the exact tick pair today, so a sliding
window never hits it and grows unbounded. A bar-quantised key plus an LRU of 32–64 entries caches
the whole piece and never evicts. Measured: 42–74 ms warm against 98–139 ms cold.

**Deliberate.** As soon as a bar's evidence exists, ask Jev, speculatively, about the *next*
boundary. This is ReaLJam's pattern: predict, commit ahead of musical time, discard most of what
you predicted. Discarding is free.

**Commit.** A local, deterministic rule decides *when*, with no network on the path: a standing
verdict above threshold with hysteresis, a refractory period elapsed, tracking confidence
adequate, and the nearest note boundary reached. It does **not** wait for a phrase to end. The
period sources describe a teacher stopping a student at the first chord, and the instrument makes
that possible without violence, because the moving action stops the student rather than a voice
cutting across them. All of this is threshold logic over state already computed, it is
inspectable, and it is deterministic — which matters when the question "why did it stop the
student *there*" has to be answered.

**Play.** `perform(mei, counterMpm, range)` already cuts to a range and shifts the passage to start
at zero (`mpmRenderer.ts:162-180`), measured flat at 17–18 ms for two, four and eight bars. Out to
the Disklavier over Web MIDI.

## 3. Jev's place

Jev (TypeSafe AI, released mid-September 2026) is not an LLM and emits no text. It takes a `state`
and a map of named typed questions and answers them all in parallel with calibrated probabilities:
`noul` (yes/no as a probability), `choice` (one of up to 255 options, with a probability map), and
`score` (a rating against 2–10 ordered levels, returned as the expectation over level indices).

Measured from this machine, against `jev-1.13.0`:

| | |
|---|---|
| latency | p50 367 ms, p95 525 ms, p99 883 ms, sd 92 (40 calls, realistic state) |
| network share | ~250 ms of that is round trip; TCP connect alone is 237–325 ms |
| question count | free — five questions cost the same as three (366 vs 361 ms) |
| state size | drives the tail: a 5000-token state produced a 2.5 s outlier |
| determinism | not deterministic. Identical input moves `interrupt` ±0.05 around 0.60; categorical answers do not move |
| cost | $0.65 per hour of continuous playing at four calls per second |
| caching | none. No prefix caching, sessions or cached-token pricing. Every call re-sends the full state |

**What it decides, and what it must not.** It cannot be the thing that decides to cut in at the
moment of hearing: 367 ms p50 with an 883 ms p99 is not a reflex, and a verdict that arrives two
seconds late points at the wrong bar, which is worse than silence because the student cannot tell
what it answers. It is a **standing verdict**, recomputed continuously so the answer is already in
hand when a boundary arrives.

**It replaces the planner, not the voice.** `src/plan/schema.ts` already defines this exact
decision, built for the agentic lesson plan and currently gated behind `VITE_TEACHER_AGENTIC`:

```
demo.mode        exaggerated | path | reference | none
demo.range       from/to, as measure.beat
demo.dimensions  [{ type, strength }]
demo.edits       how many corrections
```

Every field maps onto a Jev primitive. `mode` is a `choice`, each `strength` is a `score`, whether
to come in at all is a `noul`, and the whole set arrives in one round trip. What Jev changes is
that this planner becomes fast enough to run while the student is still at the keyboard, where an
LLM at 1.3–3.7 s was not. `src/plan/validate.ts`, which clamps an unmusical answer rather than
obeying it, survives unchanged and is exactly what belongs between a probabilistic verdict and a
piano that moves its own keys.

**Why a model at all, when there is already a JND gate.** Because severity and the decision to
interrupt are different judgements, and the gate can only make the first. Measured across six
scenarios: on a gross rush at a phrase boundary, `interrupt` 0.84 and severity 3.39 of 4. On the
*same* deviation after Grünfeld has already made that point twice, severity stays at 3.36 and
`interrupt` falls to 0.32. The music is equally far from him either way; the teaching is not.
On an identity take — the student playing the roll back — `interrupt` is 0.06 and `dimension` is
`none`, so the project's zero-by-construction property survives.

**How to use the numbers.** Not as calibrated probabilities. TypeSafe claim calibration from
"Reinforcement Learning for Calibrated Decisions" but publish no ECE, Brier score or reliability
diagram. The one independent test with a real sample size (n=2000, frozen protocol, public
dataset) measured ECE 0.281, with a 0.4B open model beating it. That test is out of domain, so it
is not damning, but the probabilities should be calibrated against this project's own ground
truth before anything thresholds on them. `info.json` holds 136 argued editorial claims and there
are recorded takes; the material for that calibration already exists.

Practical consequences: pin `jev-1.13.0` rather than `jev-latest`, since thresholds are tuned
against a specific model's outputs. Use a Schmitt trigger, fire above ~0.70 and release below
~0.60, because the ±0.05 jitter would otherwise chatter a bare comparison polled four times a
second. Abandon a call at ~900 ms rather than waiting. Keep the connection warm, since the first
call after a TLS handshake costs ~700 ms. Keep the state small, because it drives both cost and
the tail. Route through the Node server rather than the browser — the SDK documents no browser
support, and the transatlantic hop happens once either way, so the proxy is close to free.

One limitation to design around: questions are evaluated independently and cannot condition each
other. Conditioning has to happen client-side over the returned probability distributions, which
is usually enough, since full per-option probabilities come back.

## 4. The instrument

The Disklavier is not a detail of the output stage. It is most of the design.

**Use Yamaha's 500 ms MIDI IN delay.** With it on, the strike lands at a documented 500 ms after
reception, and Yamaha state its purpose is "to eliminate delays that may occur in producing the
sound of weak and strong notes". With it off, response "will vary based on the velocity of the
notes and is not user-controllable". For a project whose whole claim is that the timing is right,
that is not a close call. Goebl and Bresin measured reproduction error at −20 to +30 ms with a
mean of −0.3 ms and s.d. 5.5 ms, so the instrument already centres the average.

It also happens that 500 ms is about Jev's p95. The lead time the piano needs mechanically and the
lead time the decision needs over the network overlap rather than add.

**Schedule in Chrome.** Verified in the Chromium source: the renderer passes an absolute timestamp
through unmodified and `midi_manager_mac.cc` converts it to a mach absolute time for CoreMIDI, so
the OS schedules the event rather than a JavaScript timer. Firefox's path is unverified past the
platform layer.

**The pedal feeds back; the keys do not.** The Mark III manual states that during playback and for
data received at MIDI IN, no data is sent to MIDI OUT "except for pedal data", because "unlike the
keyboard, the pedals cannot distinguish whether they are being activated by foot or by data".
Grünfeld's own pedalling returns as input and must be filtered against what was sent. This differs
by instrument — an MX-100A upright echoed solenoid-driven notes, a Mark II could not play back and
record at once — so it has to be checked on the actual piano.

**The student's pedalling is already available, and the code believes otherwise.** `cut.ts:36-41`
drops Grünfeld's pedal from every comparison because "Web MIDI gives us no CC64 from the student".
On a Disklavier the KBD Out filter defaults to continuous half-pedal, with CC64, 66 and 67 at full
range, mixed onto the same channel as the notes. The input handler already pushes every message
and `smf.ts` writes them all through, so the data reaches the SMF today. Pedal is a dimension this
project could measure for the first time, and unlike rubato it may be measurable in a short window.

**The sources make this the dimension to fit first.** Emma Grünfeld's 1912 memoir names what
pupils were meant to learn from him: "wie man studiert, vornehmlich **seine Pedalisierung**, seinen
Gesang auf dem Klavier". The one surviving trace of his manner in a pupil is a critic's note on
Johanna von Hartenau playing "im Grünfeldschen Sinn, klar, einfach, **ohne Pedalschatten**" (*Der
Tag*, 26.03.1927). The reconstruction carries 200 `movement` elements, damper and *una corda*. So
the dimension the app currently discards is the one the sources put first, and the instrument in
the room would supply the student's side of it. Fitting a `movementMap` is new work — `MeasuredNote`
is note-shaped and pedal is dropped at note extraction — but it is the work with the best
documentary claim on being done.

**Keys do not fight.** Solenoids push the back of the key upward, the same rotation a finger
produces at the front, so there is no opposed force. A key held fully down has not reset its jack,
so a command to strike it fails silently. That is inference from action mechanics rather than
Yamaha documentation, and the mid-press case is undocumented.

**A handover signal exists in the hardware.** Yamaha's SmartKey moves keys *slightly*, below the
threshold of sound, to show the next note, while still sensing the player. That is the physical
equivalent of Shimon's head-turn, and it gives Grünfeld a way to say *I am about to take over*
without yet taking over. A machine that seizes the keyboard with no warning is a different
experience from one that asks for it.

## 4a. The policy, calibrated without the piano

`scripts/simulate-lesson.ts` plays a synthetic student into the real pipeline — the real matcher,
the real fit, the real gate, the real Jev — against a virtual clock, with each call's measured
latency placed back onto that clock. It exists so the interruption policy is already tuned when the
instrument arrives.

Three things it settled that reading alone would not have.

**A bar must not be scored until the student is well into the next one.** Judged on its last onset,
a bar is judged on whichever notes happen to have finished sounding. An identity take scored six
notes of bar 5, read itself 4.4 bpm slow, and produced three `tempo` events at 17.27 JND. Half a
bar of settling later the same window is silent. `settleTicks` is half a bar.

**Human unevenness and a reading are close in magnitude and differ in kind.** Measured aggregate
JND over the same passage: identity 0.13, a fine player's jitter 6.17, ordinary human 8.89, an
uneven amateur 18.53, a deliberate 15 % rush 23.87. Noise moves about between windows; a reading
persists. Hence `persistenceWindows`: a dimension must survive two consecutive windows.

**The threshold belongs to this pipeline, not to the model's scale.** Jev's raw `interrupt`
probability on real evidence is nothing like the 0.84 a hand-written description of a gross
deviation produces. Measured here:

| student | interrupt | |
|---|---|---|
| ordinary human, uneven amateur | 0.28 – 0.50 | silent |
| rush 15 % | 0.33 – 0.51 | silent |
| rush 25 % | 0.36 – 0.59 | crosses |
| rush 40 % | 0.56 – 0.64 | fires |
| drag 30 % | 0.54 – 0.63 | fires |
| 60 % louder | 0.54 – 0.62 | fires |

**0.52** separates every genuine reading from every kind of unevenness, with the boundary between a
15 % and a 25 % tempo departure — 15 % is latitude, 25 % is a different idea of the piece. Dragging
is caught as readily as rushing. The dimension Jev names was correct in every run.

What the lesson then looks like: silence for the identity take, the fine player, the ordinary
human, the uneven amateur, the dropped notes and the 15 % rush; one to three fragments for the
genuine departures; and — the result worth the whole exercise — **four identical attempts at the
same rushed passage draw exactly one interruption, on the first.** Nothing enforces that. Jev is
given `already_corrected_this_lesson` and decides the point has been made. A lesson costs $0.0012.

**One operational requirement falls out.** A warm connection answers in 0.5–0.7 s; a cold socket
pays a TLS handshake and takes 2.1–2.4 s. The simulation cannot hold a socket open between verdicts
and so runs with a 4 s abandon timer, which is about the harness. The server must keep the
connection alive, and then 900 ms is the right number.

**What fine-tuning means on the day.** Everything in `POLICY` is a named constant with an
environment override, so the knobs can be turned against a real player without editing code:
`FIRE_ABOVE` / `RELEASE_BELOW` (how readily he comes in), `WINDOW_BARS`, `ABANDON_MS`. The rest —
`refractoryMs`, `verdictTtlMs`, `persistenceWindows`, `settleTicks` — are one-line changes in the
same block. The two that will most likely want moving against a real student are `fireAbove`,
because a real player's unevenness is not Gaussian the way the synthetic one's is, and
`refractoryMs`, because eight seconds was chosen to feel right rather than measured.

What the simulation cannot tell you: how it feels to be interrupted by a piano playing itself.

## 5. What must be measured on the piano before building

Four of these are five-minute checks and each could invalidate an assumption now in the pipeline.

1. Does MIDI OUT carry solenoid-driven **notes** during playback?
2. Does MIDI OUT carry solenoid-driven **pedal**? (Mark III says yes.)
3. Does MIDI OUT carry the **student's** pedal, and continuous or switched?
4. Does MIDI OUT carry **silent key presses**? (`Key Touch` defaults to ON and "sends silent notes",
   which would pollute the matcher with presses that never sounded.)
5. Acoustic onset against scheduled time across the velocity range, with MIDI IN Delay on and off.
6. **The lowest velocity that reliably sounds, per register, at the intended volume setting.**
7. What happens to a commanded note whose key is already held.

Items 1 to 4 gate the build. Items 5 to 7 are **deferred by decision**: this instrument is well
regulated and the quiet end is trusted for now.

The reason to keep them written down is that the published evidence is not reassuring, and if a
demonstration ever sounds wrong at the soft end this is the first place to look. Goebl and Bresin
found the dynamic extremes flatten out, soft tones playing back too loudly and loud tones too
softly, with good reproduction "only in a wide middle range" — and their instrument "did not
reproduce any silent notes at all". Yamaha concede that "faint pianissimo passages sometimes drop
out" and offer the volume control as the remedy, which makes the demonstration's dynamics depend on
a front-panel setting. The only published velocity window is Bolzinger's, second-hand, from 1995,
on an upright: linear only between roughly MIDI velocity 30 and 85. No public Disklavier velocity
calibration exists for any instrument, so producing one would be a contribution rather than a
lookup.

## 6. What goes, what stays, what is new

**Goes** (~4,600 lines): both teacher routes, the prompts, `gruenfeldVoice.ts`, TTS and
transcription, the cue scheduler and chunker, push-to-talk, `judgementMood.ts`, both feature flags.
This is most of what the 2026 modernization built. It goes without ceremony and without leaving
commentary behind: the history is in git, and no comment in the new code should explain what used
to be there.

The corpus reaches the student only through speech, and a silent Grünfeld cannot cite. That is
accepted — the scholarship has another route to its readers, and the live lesson is not it.
`info.json` remains where it is, because the reconstruction still rests on it.

**Stays**: the matcher, the fit, the whole `mpm/` tree, the worker, `mpmRenderer`, `src/plan/`
(promoted, with `monologue` removed), the counter-performance and its calibration.

**New**: the continuous listener replacing the take boundary; the structural position tracker,
which is the real new work; the bar-quantised memo key; a small Jev decision service; the
Disklavier output path with pedal filtering and velocity calibration; and the handover signal.

## 7. What the evidence does not support

Stated plainly, because the design is easier to believe than to justify.

**Nobody has built this.** Across Dannenberg and Vercoe, Antescofo, the Continuator, Yamaha's AI
Music Ensemble, Magenta's duet systems, ACCompanion, ReaLchords and ReaLJam, every system follows
the player. Several go to lengths to *absorb* mistakes rather than mark them. A machine that stops
a human to correct them appears in patents, not in research. In a survey of 184 live music agents,
proactive systems are 3% and turn-taking is 5%, the least common temporal structure. There is no
prior evaluation to lean on, and no evidence that being interrupted by a machine is a good
experience.

**Disklavier replay has been tested and the result was sober.** Twenty-five advanced students on a
Mark IV Pro, play → hear it replayed → play again. Students rated their own second performance
better on rhythm, agogics and interpretation. Professional raters heard no significant difference
in any group, and manipulating tempo and volume gave no advantage over plain replay. Self-perceived
improvement did not become audible improvement. Any evaluation of this project should be designed
knowing that.

**The modern motor-learning literature argues for sparing feedback**, and specifically that
*relative* timing — which is what MPM encodes and what Grünfeld's rubato is — is the parameter
frequent feedback damages most, while absolute duration is robust to it and does not transfer
(Wulf, Lee & Schmidt 1994; Winstein & Schmidt 1990; reviewed for musicians in Wulf & Mornell 2008).
Immediate knowledge of results is also less effective than delaying it a few seconds.

That evidence is about acquiring a motor skill through practice, and it is not what this project
is doing. The lesson is exposition: making Grünfeld's reading audible as a reading. The same review
lists observational practice among the things to incorporate, and modelling is not knowledge of
results, so frequent *demonstration* and sparing *error-marking* are consistent rather than in
tension.

The period sources point the same way and are the ones this project answers to. Leschetizky stopped
students at the first chord; Schütt recalls how often he interrupted a pupil's playing; Hullah
describes constant fragmentary demonstration and almost no complete performances. A reconstruction
of a period teacher teaches in period style. He comes in often and early, and what he plays is a
fragment.

**But the teacher is a construction, and the playing is not.** Grünfeld taught reluctantly and for
money. He began at Kullak's academy in 1871 because his parents could no longer support him — "Ich
habe ziemlich viel Plage mit Stunden, aber es bringt was ein" (to his parents, Berlin, 3 February
1871) — and turned down chairs at Moscow, Vienna, Prague, Petersburg and Chicago. His letters stop
in 1872, so everything about his mature teaching reaches us through his sister, the press and
pupils' letters, never in his own contemporaneous words. The evidence for how he *taught* is thin
where the evidence for how he *played* is a piano roll argued bar by bar.

That is an argument for the silent design rather than against it. Removing the speech removes the
part that had to be invented. What remains is the part the project can actually defend.

One honest difference: the period arrangement for this kind of teaching was **two pianos, side by
side, keyboards level** (Hullah, 1906), which is also, independently, what Yamaha's Remote Lesson
concluded. The single instrument is this project's constraint, not Grünfeld's.

## 8. Order of work

1. Remove the speech layer. It clears the ground for everything else and nothing depends on it.
2. The four five-minute instrument checks (§5, items 1–4). Cheap, and each could invalidate an
   assumption now in the pipeline.
3. Fix `dateWindow`, and expand the second repeat in `score.mei`. Both are bugs in the app as it
   stands, independent of this rework.
4. Move the matcher and the evidence chain into the worker; quantise the memo key.
5. The structural position tracker, validated against the existing offline matcher on recorded
   takes. This is the largest single piece.
6. The Disklavier output path: Web MIDI scheduling and pedal filtering.
7. The Jev decision service, with its thresholds calibrated against recorded takes rather than
   taken from the model's raw probabilities.
8. The commit rule and the handover signal.
