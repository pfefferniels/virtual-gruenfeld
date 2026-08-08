"""
Two-panel teacher response visualization:
  Top:    Symmetric waveform envelope of TTS speech with chunk labels
  Bottom: Compact piano roll (mood chord + correction MIDI) with sustain pedal

Reads *_teacher_viz.json produced by generate_test.ts.
Usage:  python3 render_teacher_pianoroll.py [scenario_name]
"""

import json
import sys
import glob
import subprocess
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

# ── Locate data ──

scenario = sys.argv[1] if len(sys.argv) > 1 else None
if scenario:
    path = f'test_output/{scenario}_teacher_viz.json'
else:
    paths = sorted(glob.glob('test_output/*_teacher_viz.json'))
    if not paths:
        print('No *_teacher_viz.json found in test_output/. Run generate_test.ts first.')
        sys.exit(1)
    path = paths[0]
    print(f'Using: {path}')

with open(path) as f:
    data = json.load(f)

# ── Colors ──

COL_MOOD = '#9B59B6'
COL_CORRECTION = '#555555'
COL_PEDAL = '#E8DAEF'
COL_ENTRY_LINE = '#BDC3C7'
COL_WAVEFORM = '#D35400'
COL_WAVEFORM_FILL = '#F5CBA7'
COL_LABEL = '#555555'

# ── Audio loading via ffmpeg ──

def load_audio_samples(audio_path, sr=22050):
    """Decode audio → mono PCM float samples."""
    cmd = [
        'ffmpeg', '-v', 'error', '-i', audio_path,
        '-ac', '1', '-ar', str(sr), '-f', 's16le', '-',
    ]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        print(f'  ffmpeg error: {result.stderr.decode()[:200]}')
        return None, sr
    samples = np.frombuffer(result.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    return samples, sr

# ── Extract data ──

notes = data['notes']
scheduled = data['scheduledChunks']
correction_entry = data['correctionEntrySec']
pedal = data.get('pedal', [])
vocal_path = data.get('vocalAudioPath')

# Timeline bounds
all_ends = [n['onset'] + n['duration'] for n in notes]
for c in scheduled:
    all_ends.append(c['atSec'] + c['durationSec'])
t_max = max(all_ends) + 0.5 if all_ends else 10

# Load audio
raw_samples, sr = None, 22050
if vocal_path:
    print(f'Loading audio: {vocal_path}')
    raw_samples, sr = load_audio_samples(vocal_path)

# Build the full waveform mapped to the playback timeline.
# Resolution: one sample per display-pixel at 300dpi across 24in = 7200 points.
# Use a higher internal resolution for smooth RMS, then thin for plotting.
DISPLAY_SR = 1000  # 1 sample per ms for RMS computation
n_display = int(t_max * DISPLAY_SR) + 1
waveform_pos = np.zeros(n_display, dtype=np.float32)  # positive envelope
waveform_neg = np.zeros(n_display, dtype=np.float32)  # negative envelope (mirrored)

if raw_samples is not None and len(raw_samples) > 0:
    for chunk in scheduled:
        at_sec = chunk['atSec']
        a_start = chunk['audioStartSec']
        a_end = chunk['audioEndSec']
        dur = chunk['durationSec']
        if dur <= 0:
            continue

        # Extract source audio slice
        src_start = int(a_start * sr)
        src_end = int(a_end * sr)
        src_start = max(0, min(src_start, len(raw_samples)))
        src_end = max(src_start, min(src_end, len(raw_samples)))
        chunk_samples = raw_samples[src_start:src_end]
        if len(chunk_samples) == 0:
            continue

        # Compute RMS in small windows, then map to display timeline
        src_dur = len(chunk_samples) / sr
        # Number of display frames this chunk occupies
        n_frames = max(1, int(dur * DISPLAY_SR))
        dst_start = int(at_sec * DISPLAY_SR)

        for fi in range(n_frames):
            # Map display frame → source sample range
            t_frac = fi / n_frames
            src_sample = int(t_frac * len(chunk_samples))
            window = 128  # ~6ms at 22050
            win_start = max(0, src_sample - window // 2)
            win_end = min(len(chunk_samples), src_sample + window // 2)
            if win_end <= win_start:
                continue
            seg = chunk_samples[win_start:win_end]
            rms = np.sqrt(np.mean(seg ** 2))
            idx = dst_start + fi
            if 0 <= idx < n_display:
                waveform_pos[idx] = rms
                waveform_neg[idx] = -rms

    # Normalize to [-1, 1]
    peak = max(float(waveform_pos.max()), 1e-6)
    waveform_pos /= peak
    waveform_neg /= peak

waveform_times = np.linspace(0, t_max, n_display)

# ── Figure setup ──

fig, (ax_voice, ax_piano) = plt.subplots(
    2, 1, figsize=(24, 6), dpi=300,
    gridspec_kw={'height_ratios': [1.1, 1], 'hspace': 0.04},
    sharex=True,
)
fig.patch.set_facecolor('white')

# ── Top panel: Symmetric waveform ──

ax_voice.set_facecolor('white')
ax_voice.set_xlim(0, t_max)

# Continuous center line (silence = flat line)
ax_voice.axhline(0, color='#CCCCCC', linewidth=0.4, zorder=0)

# Fill symmetric waveform
ax_voice.fill_between(
    waveform_times, waveform_neg, waveform_pos,
    color=COL_WAVEFORM_FILL, alpha=0.8, zorder=1,
)
# Outline
ax_voice.plot(waveform_times, waveform_pos, color=COL_WAVEFORM, linewidth=0.5, zorder=2)
ax_voice.plot(waveform_times, waveform_neg, color=COL_WAVEFORM, linewidth=0.5, zorder=2)

# Chunk labels
for ci, chunk in enumerate(scheduled):
    at_sec = chunk['atSec']
    dur = chunk['durationSec']
    if dur <= 0:
        continue
    words = chunk.get('text', chunk['marker']).split()
    label = ' '.join(words[:5])
    if len(words) > 5:
        label += '\u2026'
    ax_voice.text(
        at_sec + dur / 2, 1.15, label,
        ha='center', va='bottom', fontsize=10,
        color=COL_LABEL, style='italic',
    )

ax_voice.set_ylim(-1.3, 1.5)
ax_voice.axis('off')

# ── Bottom panel: Piano roll ──

ax_piano.set_facecolor('white')

# Sustain pedal shading
if pedal:
    pedal_on = None
    for p in pedal:
        if p['value'] > 63 and pedal_on is None:
            pedal_on = p['time']
        elif p['value'] <= 63 and pedal_on is not None:
            ax_piano.axvspan(pedal_on, p['time'], color=COL_PEDAL, alpha=0.3, zorder=0)
            pedal_on = None
    if pedal_on is not None:
        ax_piano.axvspan(pedal_on, t_max, color=COL_PEDAL, alpha=0.3, zorder=0)

# Notes
if notes:
    all_pitches = [n['pitch'] for n in notes]
    p_min = min(all_pitches) - 1.5
    p_max = max(all_pitches) + 1.5
else:
    p_min, p_max = 48, 84

for n in notes:
    col = COL_MOOD if n.get('source') == 'mood' else COL_CORRECTION
    alpha = 0.9 if n.get('source') == 'correction' else 0.75
    rect = FancyBboxPatch(
        (n['onset'], n['pitch'] - 0.35),
        max(n['duration'], 0.02), 0.7,
        boxstyle='round,pad=0.005,rounding_size=0.02',
        facecolor=col, edgecolor=col, linewidth=0.4,
        alpha=alpha, zorder=3,
    )
    ax_piano.add_patch(rect)

ax_piano.set_xlim(0, t_max)
ax_piano.set_ylim(p_min - 0.5, p_max + 0.5)
ax_piano.axis('off')

# ── Save ──

out_path = path.replace('_teacher_viz.json', '_teacher_pianoroll.png')
fig.savefig(out_path, dpi=300, bbox_inches='tight', facecolor='white', pad_inches=0.08)
plt.close()
print(f'Saved: {out_path}')
