# MPM (Music Performance Markup) — LLM Reference

Source: https://axelberndt.github.io/MPM/guidelines/

MPM is an XML format that encodes **how** music is performed (tempo, dynamics, articulation, rubato, ornamentation, humanization) separately from the score. It does NOT encode pitch/rhythm (that's MEI/MSM/MIDI) or sound generation (that's the synthesizer/sampler).

## Document Structure

```xml
<mpm>
  <metadata>...</metadata>                              <!-- optional: authors, comments -->
  <performance name="..." pulsesPerQuarter="720">       <!-- one or more performances -->
    <global>                                            <!-- applies to ALL parts -->
      <header>...</header>                              <!-- style definitions (timeless) -->
      <dated>...</dated>                                <!-- timed instructions (maps) -->
    </global>
    <part name="Soprano" number="1" midi.channel="0" midi.port="0">
      <header>...</header>                              <!-- part-local style defs -->
      <dated>...</dated>                                <!-- part-local maps -->
    </part>
  </performance>
</mpm>
```

- **`global`** instructions apply to all parts; **`part`** instructions apply to one part and override global.
- **`header`** contains style definitions (no `date`); **`dated`** contains time-stamped maps.

## Timing Concept

- `pulsesPerQuarter` (ppq): tick resolution. Common values: 360, 480, 720.
- All `date` and `frameLength` attributes are in **ticks** (symbolic time), NOT milliseconds.
- Attributes ending in `Ms` (e.g. `absoluteDurationMs`, `absoluteDelayMs`) are in **milliseconds**.
- `milliseconds.offset` and `milliseconds.timingBasis` are in milliseconds.

**Timing pipeline** (order of application):
```
Tempo → Rubato → Asynchrony → Articulation (symbolic) → Ornamentation → [timing done] → Articulation (ms) → Randomization
```

## Tempo

### Style definitions (in `header`)
```xml
<tempoStyles>
  <styleDef name="Karajan">
    <tempoDef name="Adagio" value="60.0"/>    <!-- maps name→BPM -->
    <tempoDef name="Allegro" value="130.0"/>
  </styleDef>
</tempoStyles>
```

### Map entries (in `dated/tempoMap`)
```xml
<tempoMap>
  <style date="0.0" name.ref="Karajan"/>                               <!-- activate a style -->
  <tempo date="0.0" bpm="100.0" beatLength="0.25"/>                    <!-- constant tempo -->
  <tempo date="0.0" bpm="100.0" transition.to="120.0" beatLength="0.25"/>  <!-- continuous transition -->
  <tempo date="0.0" bpm="Allegro" beatLength="0.25"/>                  <!-- literal (resolved via style) -->
</tempoMap>
```

| Attribute | Meaning |
|---|---|
| `date` | Position in ticks |
| `bpm` | Beats per minute (numeric or literal name from style) |
| `transition.to` | Target BPM for continuous transition (numeric or literal) |
| `beatLength` | Note value of one beat: 0.25 = quarter, 0.5 = half, 0.125 = eighth |
| `meanTempoAt` | 0.0–1.0, shapes the transition curve (power function). 0.5 = linear. <0.5 = early accel, >0.5 = late accel |

A `tempo` instruction with only `bpm` sets constant tempo until the next instruction. With `transition.to`, it creates a continuous transition ending at the `date` of the next `tempo` entry.

## Dynamics

### Style definitions (in `header`)
```xml
<dynamicsStyles>
  <styleDef name="Karajan">
    <dynamicsDef name="p" value="30.0"/>     <!-- maps name→velocity (0–127) -->
    <dynamicsDef name="f" value="95.0"/>
    <dynamicsDef name="ff" value="122.0"/>
  </styleDef>
</dynamicsStyles>
```

### Map entries (in `dated/dynamicsMap`)
```xml
<dynamicsMap>
  <style date="0.0" name.ref="Karajan"/>
  <dynamics date="0.0" volume="80.0"/>                                         <!-- constant/terraced -->
  <dynamics date="14400.0" volume="50.0" transition.to="115.0" subNoteDynamics="true"/>  <!-- continuous (cresc/decresc) -->
  <dynamics date="164520.0" volume="80.0"/>                                    <!-- next constant level -->
</dynamicsMap>
```

| Attribute | Meaning |
|---|---|
| `date` | Position in ticks |
| `volume` | Dynamics level (numeric 0–127 or literal like "p", "f") |
| `transition.to` | Target level for continuous transition |
| `curvature` | Shapes the Bézier curve (-1.0 to 1.0). 0 = linear |
| `protraction` | Shifts the curve horizontally (-1.0 to 1.0). 0 = centered |
| `subNoteDynamics` | If `true`, uses MIDI CC (continuous controller) for within-note dynamics; if `false`/absent, note-wise velocity only |

Continuous transitions use cubic Bézier curves controlled by `curvature` and `protraction`.

## Metrical Accentuation

Recurring velocity patterns tied to meter. Defined in header, applied in dated.

### Style definitions
```xml
<metricalAccentuationStyles>
  <styleDef name="my patterns">
    <accentuationPatternDef name="quad time" length="4.0">
      <accentuation beat="1" value="1.0" transition.from="0.0" transition.to="0.25"/>
      <accentuation beat="2.5" value="0.5"/>
    </accentuationPatternDef>
  </styleDef>
</metricalAccentuationStyles>
```

### Map entries (in `dated/metricalAccentuationMap`)
```xml
<metricalAccentuationMap>
  <style date="0.0" name.ref="my patterns"/>
  <accentuationPattern date="0.0" name.ref="quad time" scale="1.0" loop="true" stickToMeasures="true"/>
</metricalAccentuationMap>
```

| Attribute | Meaning |
|---|---|
| `length` | Pattern length in beats |
| `beat` | Position within the pattern (1-based, can be fractional) |
| `value` | Accentuation level (added to velocity, scaled by `scale`) |
| `transition.from` / `transition.to` | Interpolation to/from neighboring beats |
| `scale` | Multiplier for all `value`s in the pattern |
| `loop` | If `true`, pattern repeats |
| `stickToMeasures` | If `true`, pattern restarts at each measure boundary |

Accentuation values are **added** on top of macro dynamics.

## Rubato

Tempo-compensated timing distortion (swing, Viennese waltz, etc.). Based on a power function.

### Map entries (in `dated/rubatoMap`)
```xml
<rubatoMap>
  <style date="0.0" name.ref="Jones"/>
  <rubato date="0.0" name.ref="swing" loop="true"/>
  <rubato date="0.0" intensity="0.8" frameLength="720.0"/>
  <rubato date="720.0" intensity="2.0" frameLength="2160.0" loop="true"/>
</rubatoMap>
```

| Attribute | Meaning |
|---|---|
| `date` | Position in ticks |
| `frameLength` | Length of one rubato cycle in ticks |
| `intensity` | Degree of distortion (0 = none, higher = more). Negative inverts the curve |
| `loop` | If `true`, the pattern repeats |
| `lateStart` | 0.0–1.0, delays onset of the rubato effect within the frame |
| `earlyEnd` | 0.0–1.0, shortens the rubato effect at the end of the frame |
| `name.ref` | Reference to a `rubatoDef` in the active style |

Style definitions use `rubatoStyles > styleDef > rubatoDef` with the same attributes.

## Asynchrony

Millisecond offsets to timing (e.g. one part slightly ahead/behind).

```xml
<asynchronyMap>
  <asynchrony date="0.0" milliseconds.offset="100.0"/>
  <asynchrony date="34650.0" milliseconds.offset="-50.0"/>
</asynchronyMap>
```

## Articulation

Shapes individual tones. Placed in `dated/articulationMap`.

### Map entries
```xml
<articulationMap>
  <style date="0.0" name.ref="Peterson" defaultArticulation="nonlegato"/>
  <articulation date="0.0" name.ref="staccato"/>                          <!-- by style name -->
  <articulation date="720.0" noteid="#2358d" name.ref="legato"/>           <!-- specific note -->
  <articulation date="6570.0" relativeDuration="0.4" absoluteDelayMs="14.0"/>  <!-- inline modifiers -->
</articulationMap>
```

- Without `noteid`: applies to ALL notes at that `date` (useful in `global`).
- With `noteid`: applies only to that specific note (useful in `part`).

### Modifiers (attributes on `<articulation>` or `<articulationDef>`)

| Modifier | Unit | Effect |
|---|---|---|
| `absoluteDuration` | ticks | Set duration to this value |
| `absoluteDurationChange` | ticks | Add to duration |
| `relativeDuration` | ratio | Multiply duration (0.5 = half, 1.0 = full) |
| `absoluteDurationMs` | ms | Set duration in milliseconds |
| `absoluteDurationChangeMs` | ms | Add to duration in milliseconds |
| `absoluteDelay` | ticks | Delay note onset |
| `absoluteDelayMs` | ms | Delay note onset in milliseconds |
| `absoluteVelocity` | 0–127 | Set velocity (overrides dynamics + accentuation) |
| `relativeVelocity` | ratio | Multiply velocity |
| `absoluteVelocityChange` | velocity units | Add to velocity |
| `detuneCents` | cents | Detune the note |
| `detuneHz` | Hz | Detune the note |

### Application order (when multiple modifiers conflict)
1. macro dynamics → 2. metrical accentuation → 3. `absoluteDelay` → 4. `absoluteDuration` → 5. `relativeDuration` → 6. `absoluteDurationChange` → 7. `absoluteVelocity` → 8. `relativeVelocity` → 9. `absoluteVelocityChange` → 10. ornamentation (non-ms) → 11. *timing computed* → 12. `absoluteDelayMs` → 13. `absoluteDurationMs` → 14. `absoluteDurationChangeMs` → 15. ornamentation (ms) → 16. randomizations

If `absoluteDurationMs` is specified, the non-ms duration modifiers (steps 4–6) are skipped.

### Common articulation style definitions
```xml
<articulationDef name="accent" absoluteVelocityChange="25.0"/>
<articulationDef name="legato" relativeDuration="1.0"/>
<articulationDef name="marcato" relativeDuration="0.8" absoluteVelocityChange="25.0"/>
<articulationDef name="nonlegato" relativeDuration="0.95"/>
<articulationDef name="staccato" relativeDuration="0.5"/>
<articulationDef name="tenuto" relativeDuration="0.9" absoluteVelocityChange="12.0"/>
```

The `style` element's `defaultArticulation` attribute names the `articulationDef` applied to notes without an explicit articulation.

## Ornamentation

Defined via transformers in `ornamentationStyles`, applied via `ornamentationMap`.

### Transformers

**`temporalSpread`** — offsets note onsets (e.g. arpeggios):
| Attribute | Meaning |
|---|---|
| `frame.start` | Start of the spread window (ticks or ms depending on `time.unit`) |
| `frameLength` | Length of the spread window |
| `time.unit` | `"milliseconds"` or omit for ticks |
| `intensity` | 0.0–1.0, scales the effect |
| `noteoff.shift` | If `true`, note-offs shift with note-ons; if `false`, durations shorten |

**`dynamicsGradient`** — adds velocity gradient across simultaneous notes:
| Attribute | Meaning |
|---|---|
| `transition.from` | Starting velocity offset |
| `transition.to` | Ending velocity offset |

### Example
```xml
<ornamentDef name="arpeggio">
  <dynamicsGradient transition.from="-1.0" transition.to="1.0"/>
  <temporalSpread frame.start="-22.0" frameLength="44.0"/>
</ornamentDef>
```

In the map:
```xml
<ornamentationMap>
  <style date="0.0" name.ref="my style"/>
  <ornament date="4860.0" name.ref="arpeggio" scale="10.0" note.order="#n96 #n97 #n98"/>
</ornamentationMap>
```

- `scale`: multiplier for transformer values (default 0.0)
- `note.order`: space-separated note IDs defining the sequence

## Randomization / Humanization

Imprecision maps add controlled randomness. Placed in `dated`. Four domains:

| Map | Domain |
|---|---|
| `imprecisionMap.timing` | Note onset timing (ms) |
| `imprecisionMap.dynamics` | Velocity |
| `imprecisionMap.toneduration` | Tone duration (ms) |
| `imprecisionMap.tuning` | Pitch (cents) |

### Distribution types

**Uniform** — equal probability within bounds:
```xml
<distribution.uniform date="0.0" limit.lower="-10.0" limit.upper="10.0"/>
```

**Gaussian** — normal distribution, mean = 0:
```xml
<distribution.gaussian date="0.0" limit.lower="-10.0" limit.upper="10.0" deviation.standard="3.0"/>
```

**Triangular** — triangle-shaped, with peak at `mode`:
```xml
<distribution.triangular date="0.0" mode="0.0" limit.lower="-1.0" limit.upper="1.0"
                          clip.lower="-0.7" clip.upper="0.7"/>
```

**Brownian Noise** (correlated) — random walk with bounded steps:
```xml
<distribution.correlated.brownianNoise date="0.0" limit.lower="-1.0" limit.upper="1.0"
                                        stepWidth.max="400.0" milliseconds.timingBasis="300.0"/>
```

**Compensating Triangle** (correlated) — triangle with drift correction:
```xml
<distribution.correlated.compensatingTriangle date="0.0" limit.lower="-80.0" limit.upper="80.0"
    clip.lower="-80.0" clip.upper="80.0" degreeOfCorrelation="4.0" milliseconds.timingBasis="300.0"/>
```

**Distribution List** (deterministic) — explicit sequence of values:
```xml
<distribution.list date="0.0" milliseconds.timingBasis="300.0">
  <measurement value="2.7"/>
  <measurement value="6.67"/>
</distribution.list>
```

| Attribute | Meaning |
|---|---|
| `milliseconds.timingBasis` | Rate (in ms) at which new random values are sampled |
| `seed` | Random seed for reproducibility |
| `degreeOfCorrelation` | How strongly successive values correlate (higher = more drift correction) |
| `stepWidth.max` | Maximum step size per sample (Brownian) |
| `clip.lower` / `clip.upper` | Hard clipping bounds (can be tighter than `limit`) |

### Recommended humanizer setup
- **Timing**: Use correlated distribution (compensatingTriangle) — uncorrelated timing sounds unnatural
- **Dynamics**: Uncorrelated (gaussian) is fine — each note has independent loudness variation
- **Tone duration**: Uncorrelated (triangular, biased toward shortening) — notes tend to end slightly early
- **Tuning**: Not always needed for piano; useful for strings/winds

## Style/Map Pattern

All domains follow the same pattern:
1. Define styles in `header` under `*Styles > styleDef > *Def`
2. In `dated/*Map`, use `<style date="..." name.ref="..."/>` to activate a style
3. Add map entries that either reference definitions by `name.ref` or specify values inline
4. Local (`part`) maps override `global` maps
