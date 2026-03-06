#!/usr/bin/env python3
"""
End-to-end test for the /implant endpoint using realistically expressive
student performances rendered via the /perform endpoint.

Instead of synthesizing MIDI mechanically (as test_dialogic.py does), this
script modifies the reference MPM to simulate different musical
interpretations, renders each variant through /perform, then feeds the
resulting MIDI into /implant and checks alignment quality.

Requires:
  - meico server at http://localhost:8080  (/convert, /perform)
  - implant server at http://localhost:8000 (/implant)

Run:
  python3 test_expressive.py
"""

import base64
import copy
import json
import sys
import traceback
from typing import Any, Dict, List, Tuple
from xml.etree import ElementTree as ET

import requests

# ── Config ──
CONVERT_URL = "http://localhost:8080/convert"
PERFORM_URL = "http://localhost:8080/perform"
IMPLANT_URL = "http://localhost:8000/implant"

MEI_PATH = "client/public/score.mei"
MPM_PATH = "assets/all/performance.mpm"

PPQ = 720
BEAT = PPQ            # 720
MEASURE = 4 * BEAT    # 2880

# Test regions (score dates)
REGIONS = [
    ("mm2-3", BEAT, 3 * MEASURE),          # dates 720 .. 8640
    ("mm5-6", 4 * MEASURE, 6 * MEASURE),   # dates 11520 .. 17280
]


# ═══════════════════════════════════════════════════════════════════
#  Helpers: load MEI, MPM, MSM
# ═══════════════════════════════════════════════════════════════════

def load_mei() -> str:
    with open(MEI_PATH) as f:
        return f.read()


def load_mpm() -> str:
    with open(MPM_PATH) as f:
        return f.read()


def get_msm_notes_from_mei(mei: str) -> Tuple[List[Dict[str, Any]], float]:
    """Call /convert to get MSM XML, then parse notes."""
    resp = requests.post(CONVERT_URL, json={"mei": mei})
    resp.raise_for_status()
    msm_xml = resp.json()["msm"]

    root = ET.fromstring(msm_xml)
    ppq = float(root.get("pulsesPerQuarter", "720"))

    notes = []
    for part_elem in root.findall(".//part"):
        part_num = int(part_elem.get("number", "0"))
        for note_elem in part_elem.findall(".//note"):
            note = {
                "xml:id": note_elem.get(
                    "{http://www.w3.org/XML/1998/namespace}id",
                    note_elem.get("xml:id", ""),
                ),
                "date": float(note_elem.get("date", "0")),
                "duration": float(note_elem.get("duration", "0")),
                "pitchname": note_elem.get("pitchname", ""),
                "octave": int(float(note_elem.get("octave", "0"))),
                "accidentals": float(note_elem.get("accidentals", "0")),
                "midi.pitch": int(float(note_elem.get("midi.pitch", "0"))),
                "part": part_num,
            }
            notes.append(note)

    return notes, ppq


def add_performance_data(
    notes: List[Dict], ppq: float, bpm: float = 80.0
) -> List[Dict]:
    """Add mechanical midi.onset / midi.duration / midi.velocity."""
    beats_per_sec = bpm / 60.0
    pulses_per_sec = ppq * beats_per_sec

    for n in notes:
        n["midi.onset"] = n["date"] / pulses_per_sec
        n["midi.duration"] = n["duration"] / pulses_per_sec
        n["midi.velocity"] = 64
        n["source"] = "reference"

    return notes


# ═══════════════════════════════════════════════════════════════════
#  MPM modification helpers
# ═══════════════════════════════════════════════════════════════════

def _parse_mpm(mpm_xml: str) -> ET.Element:
    return ET.fromstring(mpm_xml)


def _serialize_mpm(root: ET.Element) -> str:
    return ET.tostring(root, encoding="unicode", xml_declaration=False)


def _find_tempo_map(root: ET.Element) -> ET.Element:
    for elem in root.iter("tempoMap"):
        return elem
    raise ValueError("No <tempoMap> found in MPM")


def _find_dynamics_map(root: ET.Element) -> ET.Element:
    for elem in root.iter("dynamicsMap"):
        return elem
    raise ValueError("No <dynamicsMap> found in MPM")


def _find_ornamentation_map(root: ET.Element) -> ET.Element:
    for elem in root.iter("ornamentationMap"):
        return elem
    raise ValueError("No <ornamentationMap> found in MPM")


def _find_rubato_map(root: ET.Element) -> ET.Element:
    for elem in root.iter("rubatoMap"):
        return elem
    raise ValueError("No <rubatoMap> found in MPM")


def _clamp(val: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, val))


# ── Dynamics modifications ──

def modify_dynamics(mpm_xml: str, volume_delta: float) -> str:
    """Shift all dynamics volume and transition.to by a fixed delta."""
    root = _parse_mpm(mpm_xml)
    dmap = _find_dynamics_map(root)

    for dyn in dmap.findall("dynamics"):
        vol = dyn.get("volume")
        if vol is not None:
            dyn.set("volume", str(_clamp(float(vol) + volume_delta, 1, 127)))
        tr = dyn.get("transition.to")
        if tr is not None:
            dyn.set("transition.to", str(_clamp(float(tr) + volume_delta, 1, 127)))

    return _serialize_mpm(root)


# ── Tempo modifications ──

def modify_tempo(mpm_xml: str, factor: float) -> str:
    """Scale all tempo bpm and transition.to by a multiplicative factor."""
    root = _parse_mpm(mpm_xml)
    tmap = _find_tempo_map(root)

    for tempo in tmap.findall("tempo"):
        bpm = tempo.get("bpm")
        if bpm is not None:
            tempo.set("bpm", str(float(bpm) * factor))
        tr = tempo.get("transition.to")
        if tr is not None:
            tempo.set("transition.to", str(float(tr) * factor))

    return _serialize_mpm(root)


def modify_rubato_heavy(mpm_xml: str) -> str:
    """
    Simulate heavy rubato by widening existing rubato intensities
    (making some beats rush and others drag) and adding rubato entries
    for beats that currently lack them.
    """
    root = _parse_mpm(mpm_xml)
    rmap = _find_rubato_map(root)

    # Exaggerate existing rubato entries: alternate between faster and slower
    rubatos = rmap.findall("rubato")
    for i, rub in enumerate(rubatos):
        intensity = rub.get("intensity")
        if intensity is not None:
            val = float(intensity)
            # Push odd entries faster (>1) and even entries slower (<1)
            if i % 2 == 0:
                new_val = _clamp(val * 0.65, 0.4, 0.85)
            else:
                new_val = _clamp(val * 1.45, 1.15, 1.6)
            rub.set("intensity", str(new_val))

    # Also add a few new rubato entries in gaps to increase variability
    existing_dates = {float(r.get("date", "0")) for r in rubatos}
    new_dates = []
    for beat_date in range(0, 92160, BEAT):
        d = float(beat_date)
        if d not in existing_dates:
            new_dates.append(d)

    # Add rubato at every other missing beat
    for i, d in enumerate(sorted(new_dates)):
        if i % 3 != 0:
            continue
        rub = ET.SubElement(rmap, "rubato")
        rub.set("xml:id", f"rubato_exp_{int(d)}")
        rub.set("date", str(d))
        rub.set("frameLength", str(BEAT))
        rub.set("loop", "false")
        # Alternate faster/slower
        if i % 2 == 0:
            rub.set("intensity", "0.55")
        else:
            rub.set("intensity", "1.45")

    return _serialize_mpm(root)


def modify_arpeggiate(mpm_xml: str) -> str:
    """
    Add wider temporalSpread to chord ornaments in the header,
    and increase the scale attribute of existing ornaments,
    simulating a student who heavily arpeggiates chords.
    """
    root = _parse_mpm(mpm_xml)

    # Find the styleDef for ornaments and widen all temporalSpread elements
    for style_def in root.iter("styleDef"):
        if style_def.get("name") == "performance_style":
            for orn_def in style_def.findall("ornamentDef"):
                for ts in orn_def.findall("temporalSpread"):
                    frame_start = ts.get("frame.start")
                    frame_len = ts.get("frameLength")
                    if frame_start is not None and frame_len is not None:
                        # Widen the arpeggiation window by 2.5x
                        ts.set("frame.start", str(float(frame_start) * 2.5))
                        ts.set("frameLength", str(float(frame_len) * 2.5))

    # Increase scale on ornament instances in the ornamentationMap
    omap = _find_ornamentation_map(root)
    for orn in omap.findall("ornament"):
        scale = orn.get("scale")
        if scale is not None:
            orn.set("scale", str(int(float(scale) * 2)))
        else:
            orn.set("scale", "4")

    return _serialize_mpm(root)


# ═══════════════════════════════════════════════════════════════════
#  /perform and /implant calls
# ═══════════════════════════════════════════════════════════════════

def call_perform(
    mei: str, mpm_xml: str, from_date: float, to_date: float
) -> bytes:
    """
    Call /perform to render MEI + MPM into MIDI for a given score-date range.
    Returns raw MIDI bytes.
    """
    body = {
        "mei": mei,
        "mpm": mpm_xml,
        "from": from_date,
        "to": to_date,
        "ppq": PPQ,
    }
    resp = requests.post(PERFORM_URL, json=body, timeout=120)
    resp.raise_for_status()
    data = resp.json()

    midi_b64 = data.get("midi_b64")
    if not midi_b64:
        raise ValueError(f"/perform returned no midi_b64 field; keys: {list(data.keys())}")

    return base64.b64decode(midi_b64)


def call_implant(
    notes: List[Dict],
    midi_bytes: bytes,
    date_hint: float,
    date_window: float,
) -> Dict:
    """Call /implant with reference notes and student MIDI."""
    body = {
        "notes": notes,
        "midi": list(midi_bytes),
        "date_hint": date_hint,
        "date_window": date_window,
    }
    resp = requests.post(IMPLANT_URL, json=body, timeout=120)
    if resp.status_code != 200:
        return {"error": resp.status_code, "detail": resp.text}
    return resp.json()


# ═══════════════════════════════════════════════════════════════════
#  Analysis
# ═══════════════════════════════════════════════════════════════════

def analyze(
    result: Dict,
    expected_from: float,
    expected_to: float,
    test_name: str,
) -> Dict[str, Any]:
    """Analyze an /implant result for correctness."""
    if "error" in result:
        return {
            "test": test_name,
            "status": "ERROR",
            "error": result.get("detail", str(result.get("error"))),
        }

    returned_range = result.get("range", {})
    actual_from = returned_range.get("from", 0)
    actual_to = returned_range.get("to", 0)

    debug = result.get("debug", {})
    implant_info = debug.get("implant", {})
    implant_effects = implant_info.get("implant_effects", {})

    matched = implant_effects.get("kept_matched_in_region", 0)
    dropped = implant_effects.get("dropped_in_region_unmatched", 0)
    total_in_region = matched + dropped
    match_rate = matched / total_in_region if total_in_region > 0 else 0

    expected_span = expected_to - expected_from
    actual_span = actual_to - actual_from
    range_ratio = actual_span / expected_span if expected_span > 0 else 0

    # Check the result is in the right general area (not a wrong-section match)
    region_center = (expected_from + expected_to) / 2.0
    actual_center = (actual_from + actual_to) / 2.0
    center_offset = abs(actual_center - region_center)
    wrong_section = center_offset > expected_span * 2

    status = "PASS"
    issues = []

    # Range ratio check: 0.7 .. 1.3
    if range_ratio < 0.7 or range_ratio > 1.3:
        status = "FAIL"
        issues.append(
            f"Range ratio {range_ratio:.2f} outside [0.7, 1.3] "
            f"(expected span {expected_span}, actual span {actual_span})"
        )

    # Match rate check: >= 40%
    if match_rate < 0.4:
        status = "FAIL"
        issues.append(
            f"Low match rate: {match_rate:.1%} ({matched}/{total_in_region})"
        )

    # Wrong section check
    if wrong_section:
        status = "FAIL"
        issues.append(
            f"Wrong section: actual center {actual_center:.0f} vs "
            f"expected center {region_center:.0f} "
            f"(offset {center_offset:.0f} > {expected_span * 2:.0f})"
        )

    # Check for implanted notes far outside the expected region
    returned_notes = result.get("notes", [])
    implanted = [n for n in returned_notes if n.get("source") == "implanted"]
    for n in implanted:
        d = n["date"]
        if d < expected_from - 3000 or d > expected_to + 3000:
            status = "FAIL"
            issues.append(
                f"Implanted note at date={d} far outside expected "
                f"[{expected_from}, {expected_to}]"
            )
            break

    return {
        "test": test_name,
        "status": status,
        "expected_range": [expected_from, expected_to],
        "actual_range": [actual_from, actual_to],
        "range_ratio": round(range_ratio, 3),
        "match_rate": f"{match_rate:.1%}",
        "matched": matched,
        "dropped": dropped,
        "implanted_count": len(implanted),
        "issues": issues,
    }


# ═══════════════════════════════════════════════════════════════════
#  Test runner
# ═══════════════════════════════════════════════════════════════════

def print_result(analysis: Dict):
    status = analysis["status"]
    tag = {"PASS": "[PASS]", "FAIL": "[FAIL]", "WARN": "[WARN]",
           "ERROR": "[ERR ]", "EXCEPTION": "[EXC ]"}.get(status, "[????]")
    print(f"  {tag} {analysis.get('test', '?')}")
    if status != "ERROR":
        print(f"         range: expected={analysis.get('expected_range')}, "
              f"actual={analysis.get('actual_range')}")
        print(f"         ratio={analysis.get('range_ratio')}, "
              f"match_rate={analysis.get('match_rate')}, "
              f"matched={analysis.get('matched')}, "
              f"dropped={analysis.get('dropped')}")
    if analysis.get("issues"):
        for issue in analysis["issues"]:
            print(f"         !! {issue}")
    if analysis.get("error"):
        print(f"         error: {analysis['error'][:200]}")


def run_tests():
    print("=" * 72)
    print("EXPRESSIVE PERFORMANCE TESTS")
    print("Tests /implant with MIDI rendered from modified MPMs via /perform")
    print("=" * 72)

    # ── Load resources ──
    print("\n[1/3] Loading MEI...")
    mei = load_mei()
    print(f"      MEI loaded ({len(mei)} chars)")

    print("[2/3] Loading reference MPM...")
    mpm_xml = load_mpm()
    print(f"      MPM loaded ({len(mpm_xml)} chars)")

    print("[3/3] Converting MEI to MSM and building reference notes...")
    notes, ppq = get_msm_notes_from_mei(mei)
    notes = add_performance_data(notes, ppq, bpm=80.0)
    notes.sort(key=lambda n: (n["date"], n["midi.pitch"]))
    print(f"      {len(notes)} notes, ppq={ppq}")

    # ── Define test variants ──
    # Each variant: (label, description, modified_mpm_xml)
    variants: List[Tuple[str, str, str]] = [
        (
            "reference",
            "Unmodified reference MPM (baseline)",
            mpm_xml,
        ),
        (
            "louder",
            "Student plays LOUDER (+20 velocity)",
            modify_dynamics(mpm_xml, +20),
        ),
        (
            "softer",
            "Student plays SOFTER (-20 velocity)",
            modify_dynamics(mpm_xml, -20),
        ),
        (
            "faster",
            "Student plays FASTER (tempo +15%)",
            modify_tempo(mpm_xml, 1.15),
        ),
        (
            "slower",
            "Student plays SLOWER (tempo -15%)",
            modify_tempo(mpm_xml, 0.85),
        ),
        (
            "rubato",
            "Student plays with heavy RUBATO",
            modify_rubato_heavy(mpm_xml),
        ),
        (
            "arpeggiate",
            "Student ARPEGGIATES chords heavily",
            modify_arpeggiate(mpm_xml),
        ),
    ]

    results: List[Dict] = []

    # ── Run tests ──
    for region_name, start_date, end_date in REGIONS:
        region_notes = [n for n in notes if start_date <= n["date"] < end_date]
        if len(region_notes) < 5:
            print(f"\n  Skipping region {region_name}: only {len(region_notes)} notes")
            continue

        date_hint = (start_date + end_date) / 2.0
        date_window = (end_date - start_date) / 2.0 + 5000

        for variant_label, variant_desc, variant_mpm in variants:
            test_name = f"{variant_label}_{region_name}"
            print(f"\n{'=' * 72}")
            print(f"TEST: {test_name}")
            print(f"  Region: [{start_date}, {end_date}] ({len(region_notes)} notes)")
            print(f"  Variant: {variant_desc}")

            try:
                # Step 1: Render the modified MPM into MIDI via /perform
                print("  [perform] Rendering MIDI...")
                midi_bytes = call_perform(mei, variant_mpm, start_date, end_date)
                print(f"  [perform] Got {len(midi_bytes)} bytes of MIDI")

                # Step 2: Send rendered MIDI to /implant
                print("  [implant] Aligning...")
                result = call_implant(notes, midi_bytes, date_hint, date_window)

                # Step 3: Analyze
                analysis = analyze(result, start_date, end_date, test_name)
                results.append(analysis)
                print_result(analysis)

            except Exception as e:
                print(f"  EXCEPTION: {e}")
                traceback.print_exc()
                results.append({
                    "test": test_name,
                    "status": "EXCEPTION",
                    "error": str(e),
                    "issues": [str(e)],
                })

    # ═══════════════════════════════════════════════════════════════
    #  Summary
    # ═══════════════════════════════════════════════════════════════
    print("\n" + "=" * 72)
    print("SUMMARY")
    print("=" * 72)

    pass_count = sum(1 for r in results if r.get("status") == "PASS")
    fail_count = sum(1 for r in results if r.get("status") == "FAIL")
    warn_count = sum(1 for r in results if r.get("status") == "WARN")
    err_count = sum(1 for r in results
                    if r.get("status") in ("ERROR", "EXCEPTION"))
    total = len(results)

    print(f"\n  PASS: {pass_count}/{total}   FAIL: {fail_count}   "
          f"WARN: {warn_count}   ERROR: {err_count}\n")

    for r in results:
        print_result(r)

    # ── Detailed JSON dump ──
    print("\n\nDETAILED RESULTS (JSON):")
    print(json.dumps(results, indent=2, default=str))

    # Exit code
    if fail_count > 0 or err_count > 0:
        sys.exit(1)


if __name__ == "__main__":
    run_tests()
