/**
 * Compact MPM concept primer, distilled from `MPM.md` plus the vocabulary the
 * info.json argumentations use. This replaces the old DIFF GLOSSARY block: the
 * teacher now reads real MPM values, so it needs the spec, not a cheat sheet.
 * Kept byte-stable — it is part of the cached prompt prefix.
 */
export const MPM_CONCEPT_PRIMER = `MPM CONCEPTS — the performance model behind every number you see.
MPM encodes HOW music is played, separately from the score. All positions are ticks at 720 per quarter note; positions are written mX.Y (measure.beat).

- tempo: \`bpm\` at a position, optionally moving to \`transition.to\` by the next tempo entry. \`beatLength\` says which note value the bpm counts (0.25 = quarter, 0.5 = half) — a bpm figure is only comparable within the same beatLength. Higher bpm = faster.
- dynamics: \`volume\` on a 0–127 velocity scale (roughly ppp≤20, pp≤35, p≤50, mp≤65, mf≤80, f≤95, ff≤110), optionally moving to \`transition.to\` (crescendo/decrescendo). \`curvature\` and \`protraction\` shape the curve.
- rubato: a timing distortion inside a fixed frame of \`frameLength\` ticks, governed by a power function. It self-compensates — the end of every frame is back in sync with the meter. \`intensity\` < 1 = short-long (notes at the start of the frame arrive early, the end lingers); \`intensity\` > 1 = long-short (the start lingers, the end is compressed); 1 = no distortion. This is NOT "playing freely".
- metrical accentuation (\`accentuationPattern\`): a recurring velocity pattern tied to the bar (good/bad-beat weighting). \`scale\` multiplies the pattern's strength; the values are ADDED on top of the macro dynamics. Higher scale = more strongly weighted downbeats.
- articulation: shapes single notes. \`relativeDuration\` multiplies note length (1.0 = full value, so lower = shorter/detached, higher = overlapping legato). \`relativeVelocity\` multiplies note loudness (accent).
- ornamentation in this corpus means ARPEGGIATION, never trills, mordents or turns. \`temporalSpread\` (\`frameLength\`, \`intensity\`) spreads a chord's onsets in time; \`dynamicsGradient\` shades the notes inside the chord from soft to loud or the reverse. These are the corpus's words, not yours: never say "Ornament", "Verzierung", "Arpeggio", "Agogik" or "Phrasierung" out loud — a student cannot act on a term. Speak in concrete images instead: the chord broken from below, the top note singing, the hand opening.
- asynchrony: \`milliseconds.offset\` — one hand deliberately ahead of or behind the other.
- pedal: sustain depth over a span.

SCHOLARLY VOCABULARY — the reconstruction's terms for WHY a passage is played that way.
Every motivation sits on one four-step intensity scale, from strong build to full release:
- intensify (++): driving forward strongly, building tension (Steigerung).
- move (+): a gentle push ahead — leaning into the next downbeat or phrase (Hinspielen).
- calm (-): a gentle settling — shading the colour down, letting the sound ring, easing the touch.
- relax (--): releasing fully, letting the line come to rest (lösen).
Certainty ladder, strongest first: authentic > likely > plausible > possible > speculative > unlikely.`;
