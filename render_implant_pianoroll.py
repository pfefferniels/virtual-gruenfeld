"""
Minimal piano roll showing the implantation result:
reference notes (blue) with student notes (orange) spliced in.
"""

import json
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
from matplotlib.lines import Line2D

with open('test_output/implant_viz_data.json') as f:
    data = json.load(f)

ref_notes = data['refNotes']
implanted_notes = data['implantedNotes']
matches = data['matches']
rng = data['range']
measure_ticks = data['measure']

COL_REF = '#B0B0B0'
COL_STU = '#E8862E'

# Re-normalise: undo head shift so pre-region notes stay in place
first_match = min(matches, key=lambda m: m['refOnset'])
head_shift = first_match['stuOnset'] - first_match['refOnset']
impl = [{**n, 't': n['onset'] - head_shift} for n in implanted_notes]

# Region boundaries (in renormalised coords)
impl_region = [n for n in impl if n.get('source') == 'implanted']
reg_start = min(n['t'] for n in impl_region)
reg_end = max(n['t'] + n['duration'] for n in impl_region)

# View window: crop around region with context
ref_in_range = [n for n in ref_notes if rng['from'] <= n['date'] <= rng['to']]
reg_ref_start = min(n['onset'] for n in ref_in_range)
reg_ref_end = max(n['onset'] + n['duration'] for n in ref_in_range)
ctx = (reg_ref_end - reg_ref_start) * 0.55
view_min = max(0, reg_ref_start - ctx)
view_max = max(reg_ref_end + ctx,
               max((n['t'] + n['duration'] for n in impl
                    if n['t'] + n['duration'] <= reg_ref_end + ctx * 2),
                   default=reg_ref_end + ctx))

all_p = [n['pitch'] for n in impl]
p_min = min(all_p) - 1.5
p_max = max(all_p) + 1.5

# Figure
fig, ax = plt.subplots(figsize=(24, 8), dpi=300)
fig.patch.set_facecolor('white')
ax.set_facecolor('white')
ax.set_xlim(view_min, view_max)
ax.set_ylim(p_min - 0.5, p_max + 0.5)
ax.axis('off')

# Region highlight
ax.axvspan(reg_start, reg_end, color='#FFF0D8', alpha=0.5, zorder=0)
ax.axvline(reg_start, color=COL_STU, lw=0.8, ls='--', alpha=0.4, zorder=1)
ax.axvline(reg_end, color=COL_STU, lw=0.8, ls='--', alpha=0.4, zorder=1)

# Notes
for n in impl:
    t = n['t']
    if t + n['duration'] < view_min or t > view_max:
        continue
    col = COL_STU if n.get('source') == 'implanted' else COL_REF
    rect = FancyBboxPatch(
        (t, n['pitch'] - 0.3), max(n['duration'], 0.04), 0.6,
        boxstyle="round,pad=0.008,rounding_size=0.04",
        facecolor=col, edgecolor=col, linewidth=0.4, alpha=0.8, zorder=3)
    ax.add_patch(rect)


out_path = 'test_output/implant_pianoroll.png'
fig.savefig(out_path, dpi=300, bbox_inches='tight', facecolor='white', pad_inches=0.15)
plt.close()
print(f'Saved: {out_path}')
