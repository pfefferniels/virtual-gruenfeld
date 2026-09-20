"""
The teacher's answer as a compact piano roll with sustain-pedal shading.

Reads *_teacher_viz.json produced by generate_test.ts.
Usage:  python3 render_teacher_pianoroll.py [scenario_name]
"""

import json
import sys
import glob
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

COL_NOTE = '#555555'
COL_PEDAL = '#E8DAEF'

# ── Extract data ──

notes = data['notes']
pedal = data.get('pedal', [])

all_ends = [n['onset'] + n['duration'] for n in notes]
t_max = max(all_ends) + 0.5 if all_ends else 10

# ── Figure ──

fig, ax_piano = plt.subplots(1, 1, figsize=(24, 3), dpi=300)
fig.patch.set_facecolor('white')
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
    rect = FancyBboxPatch(
        (n['onset'], n['pitch'] - 0.35),
        max(n['duration'], 0.02), 0.7,
        boxstyle='round,pad=0.005,rounding_size=0.02',
        facecolor=COL_NOTE, edgecolor=COL_NOTE, linewidth=0.4,
        alpha=0.9, zorder=3,
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
