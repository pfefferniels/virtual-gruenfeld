#!/usr/bin/env python3
"""
End-to-end test for the dialogic teaching pipeline.

Tests the /implant endpoint with various simulated student performances
to check alignment quality and identify bugs in the matching/implant logic.
"""

import json
import requests
import numpy as np
from xml.etree import ElementTree as ET
from io import BytesIO
import mido
from typing import List, Dict, Any, Tuple
import sys
import traceback


# ── Config ──
CONVERT_URL = "http://localhost:8080/convert"
IMPLANT_URL = "http://localhost:8000/implant"
MEI_PATH = "client/public/score.mei"


def load_mei() -> str:
    with open(MEI_PATH) as f:
        return f.read()


def get_msm_notes_from_mei(mei: str) -> List[Dict[str, Any]]:
    """Call /convert to get MSM XML, then parse notes from it."""
    resp = requests.post(CONVERT_URL, json={"mei": mei})
    resp.raise_for_status()
    msm_xml = resp.json()["msm"]

    root = ET.fromstring(msm_xml)
    ns = {"": ""}  # MSM doesn't seem to use a namespace

    ppq = float(root.get("pulsesPerQuarter", "720"))

    notes = []
    for part_elem in root.findall(".//part"):
        part_num = int(part_elem.get("number", "0"))
        for note_elem in part_elem.findall(".//note"):
            note = {
                "xml:id": note_elem.get("{http://www.w3.org/XML/1998/namespace}id", note_elem.get("xml:id", "")),
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


def add_performance_data(notes: List[Dict], ppq: float, bpm: float = 80.0) -> List[Dict]:
    """
    Add midi.onset, midi.duration, midi.velocity to MSM notes
    to simulate a reference performance (mechanical, straight timing).
    """
    beats_per_sec = bpm / 60.0
    pulses_per_sec = ppq * beats_per_sec

    for n in notes:
        date = n["date"]
        dur = n["duration"]
        n["midi.onset"] = date / pulses_per_sec
        n["midi.duration"] = dur / pulses_per_sec
        n["midi.velocity"] = 64  # neutral
        n["source"] = "reference"

    return notes


def create_student_midi(
    notes: List[Dict],
    start_date: float,
    end_date: float,
    ppq_score: float,
    bpm: float = 80.0,
    timing_noise_ms: float = 30.0,
    velocity_noise: float = 10.0,
    wrong_note_prob: float = 0.0,
    miss_note_prob: float = 0.0,
    extra_note_prob: float = 0.0,
    tempo_factor: float = 1.0,
    seed: int = 42,
) -> bytes:
    """
    Create a MIDI file simulating a student playing a section of the score.

    Args:
        notes: MSM notes with midi.onset, midi.duration, midi.velocity
        start_date, end_date: score date range to extract
        timing_noise_ms: std dev of timing noise in milliseconds
        velocity_noise: std dev of velocity noise
        wrong_note_prob: probability of playing a wrong pitch
        miss_note_prob: probability of missing a note entirely
        extra_note_prob: probability of inserting an extra note
        tempo_factor: >1 = faster, <1 = slower
    """
    rng = np.random.default_rng(seed)

    # Filter notes in the date range
    region_notes = [n for n in notes if start_date <= n["date"] < end_date]
    region_notes.sort(key=lambda n: (n["midi.onset"], n["midi.pitch"]))

    if not region_notes:
        raise ValueError(f"No notes in date range [{start_date}, {end_date})")

    # Build student performance
    student_notes = []
    t0 = region_notes[0]["midi.onset"]

    for n in region_notes:
        # Skip note?
        if rng.random() < miss_note_prob:
            continue

        onset = (n["midi.onset"] - t0) / tempo_factor
        onset += rng.normal(0, timing_noise_ms / 1000.0)
        onset = max(0, onset)

        dur = n["midi.duration"] / tempo_factor
        dur += rng.normal(0, timing_noise_ms / 2000.0)
        dur = max(0.02, dur)

        pitch = n["midi.pitch"]
        if rng.random() < wrong_note_prob:
            pitch += rng.choice([-2, -1, 1, 2])
            pitch = max(21, min(108, pitch))

        vel = n["midi.velocity"] + rng.normal(0, velocity_noise)
        vel = max(20, min(127, int(vel)))

        student_notes.append((onset, dur, pitch, vel))

        # Extra note?
        if rng.random() < extra_note_prob:
            extra_onset = onset + rng.uniform(0.01, 0.05)
            extra_pitch = pitch + rng.choice([-7, -5, -3, 3, 5, 7])
            extra_pitch = max(21, min(108, extra_pitch))
            extra_vel = max(20, min(127, vel + rng.integers(-10, 10)))
            student_notes.append((extra_onset, 0.1, extra_pitch, extra_vel))

    student_notes.sort(key=lambda x: (x[0], x[2]))

    # Build MIDI
    mid = mido.MidiFile(ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)

    # Set tempo
    student_bpm = bpm * tempo_factor
    tempo_us = int(60_000_000 / student_bpm)
    track.append(mido.MetaMessage("set_tempo", tempo=tempo_us, time=0))

    # Convert to absolute ticks
    ticks_per_sec = 480 * student_bpm / 60.0
    events = []
    for onset, dur, pitch, vel in student_notes:
        on_tick = int(onset * ticks_per_sec)
        off_tick = int((onset + dur) * ticks_per_sec)
        events.append((on_tick, "note_on", pitch, vel))
        events.append((off_tick, "note_off", pitch, 0))

    events.sort(key=lambda e: (e[0], 0 if e[1] == "note_off" else 1))

    last_tick = 0
    for tick, msg_type, pitch, vel in events:
        delta = max(0, tick - last_tick)
        track.append(mido.Message(msg_type, note=pitch, velocity=vel, time=delta))
        last_tick = tick

    track.append(mido.MetaMessage("end_of_track", time=0))

    buf = BytesIO()
    mid.save(file=buf)
    return buf.getvalue()


def call_implant(
    notes: List[Dict],
    midi_bytes: bytes,
    pad_notes: int = 120,
    min_notes: int = 5,
    date_hint: float = None,
    date_window: float = 30000,
) -> Dict:
    """Call the /implant endpoint."""
    body = {
        "notes": notes,
        "midi": list(midi_bytes),
        "pad_notes": pad_notes,
        "min_notes": min_notes,
    }
    if date_hint is not None:
        body["date_hint"] = date_hint
        body["date_window"] = date_window
    resp = requests.post(IMPLANT_URL, json=body, timeout=60)
    if resp.status_code != 200:
        return {"error": resp.status_code, "detail": resp.text}
    return resp.json()


def analyze_implant_result(
    result: Dict,
    original_notes: List[Dict],
    expected_start_date: float,
    expected_end_date: float,
    test_name: str,
    range_tolerance: float = 1500,
) -> Dict[str, Any]:
    """Analyze the implant result for correctness."""
    if "error" in result:
        return {
            "test": test_name,
            "status": "ERROR",
            "error": result["detail"],
        }

    returned_range = result.get("range", {})
    actual_from = returned_range.get("from", 0)
    actual_to = returned_range.get("to", 0)

    debug = result.get("debug", {})
    implant_info = debug.get("implant", {})
    counts = debug.get("counts", {})
    implant_effects = implant_info.get("implant_effects", {})

    # Check range accuracy
    range_from_ok = abs(actual_from - expected_start_date) < range_tolerance
    range_to_ok = abs(actual_to - expected_end_date) < range_tolerance
    range_ok = range_from_ok and range_to_ok

    # Check implant effects
    matched = implant_effects.get("kept_matched_in_region", 0)
    dropped = implant_effects.get("dropped_in_region_unmatched", 0)
    total_in_region = matched + dropped
    match_rate = matched / total_in_region if total_in_region > 0 else 0

    # Check returned notes
    returned_notes = result.get("notes", [])
    implanted = [n for n in returned_notes if n.get("source") == "implanted"]
    original_count = counts.get("reference_notes_in", 0)
    returned_count = counts.get("reference_notes_out", 0)

    # Notes should not disappear outside the region
    notes_lost = original_count - returned_count

    status = "PASS"
    issues = []

    if not range_ok:
        status = "FAIL"
        issues.append(f"Range mismatch: expected [{expected_start_date}, {expected_end_date}], got [{actual_from}, {actual_to}]")

    if match_rate < 0.4:
        status = "FAIL"
        issues.append(f"Low match rate: {match_rate:.1%} ({matched}/{total_in_region})")

    if notes_lost > total_in_region * 0.3 + 5:
        status = "WARN" if status == "PASS" else status
        issues.append(f"Many notes lost: {notes_lost} (region had {total_in_region})")

    # Check for obvious bugs: implanted notes outside the expected region
    for n in implanted:
        if n["date"] < expected_start_date - 1000 or n["date"] > expected_end_date + 1000:
            status = "FAIL"
            issues.append(f"Implanted note at date={n['date']} outside expected region [{expected_start_date}, {expected_end_date}]")
            break

    return {
        "test": test_name,
        "status": status,
        "expected_range": [expected_start_date, expected_end_date],
        "actual_range": [actual_from, actual_to],
        "range_ok": range_ok,
        "match_rate": f"{match_rate:.1%}",
        "matched": matched,
        "dropped": dropped,
        "implanted": len(implanted),
        "notes_in": original_count,
        "notes_out": returned_count,
        "issues": issues,
        "alignment_counts": debug.get("implant", {}).get("alignment_counts", {}),
    }


def run_test_suite():
    print("=" * 70)
    print("DIALOGIC TEACHING PIPELINE - END-TO-END TESTS")
    print("=" * 70)

    # Load score and get MSM
    print("\n[1/2] Loading MEI and converting to MSM...")
    mei = load_mei()
    notes, ppq = get_msm_notes_from_mei(mei)
    print(f"  Got {len(notes)} notes, ppq={ppq}")

    # Add reference performance data
    print("[2/2] Adding reference performance data...")
    notes = add_performance_data(notes, ppq, bpm=80.0)

    # Sort by date for easier region selection
    notes.sort(key=lambda n: (n["date"], n["midi.pitch"]))

    # Find date ranges for test regions
    dates = sorted(set(n["date"] for n in notes))
    print(f"  Date range: [{dates[0]}, {dates[-1]}]")
    print(f"  Unique dates: {len(dates)}")

    # Pick a section - let's use measures 2-5 (after the pickup)
    # In Träumerei with ppq=720, one beat = 720 pulses
    # Time signature is 4/4, so one measure = 2880 pulses
    beat = ppq  # 720
    measure = 4 * beat  # 2880

    # Define test regions
    regions = [
        ("mm2-3", 1 * beat, 3 * measure),       # measures 2-3 (beginning)
        ("mm5-6", 4 * measure, 6 * measure),     # measures 5-6 (middle)
        ("mm3-5", 2 * measure, 5 * measure),     # measures 3-5 (longer)
        ("mm1-2", 0, 2 * measure),               # very beginning with pickup
    ]

    results = []

    # ── Test 1: Perfect playing (baseline) ──
    for region_name, start, end in regions:
        region_notes = [n for n in notes if start <= n["date"] < end]
        if len(region_notes) < 5:
            print(f"\n  Skipping {region_name}: only {len(region_notes)} notes")
            continue

        test_name = f"perfect_{region_name}"
        print(f"\n{'─' * 50}")
        print(f"TEST: {test_name}")
        print(f"  Region dates: [{start}, {end}], notes in region: {len(region_notes)}")

        try:
            midi = create_student_midi(notes, start, end, ppq, bpm=80.0,
                                       timing_noise_ms=0, velocity_noise=0, seed=42)
            result = call_implant(notes, midi, date_hint=(start + end) / 2, date_window=(end - start) / 2 + 5000)
            analysis = analyze_implant_result(result, notes, start, end, test_name)
            results.append(analysis)
            print(f"  Status: {analysis['status']}")
            print(f"  Range: expected={analysis['expected_range']}, actual={analysis['actual_range']}")
            print(f"  Match rate: {analysis['match_rate']}, matched={analysis['matched']}, dropped={analysis['dropped']}")
            if analysis['issues']:
                for issue in analysis['issues']:
                    print(f"  ⚠ {issue}")
        except Exception as e:
            print(f"  EXCEPTION: {e}")
            traceback.print_exc()
            results.append({"test": test_name, "status": "EXCEPTION", "error": str(e)})

    # ── Test 2: Small timing noise (realistic good student) ──
    for region_name, start, end in regions[:2]:
        region_notes = [n for n in notes if start <= n["date"] < end]
        if len(region_notes) < 5:
            continue

        test_name = f"timing_noise_30ms_{region_name}"
        print(f"\n{'─' * 50}")
        print(f"TEST: {test_name}")

        try:
            midi = create_student_midi(notes, start, end, ppq, bpm=80.0,
                                       timing_noise_ms=30, velocity_noise=10, seed=42)
            result = call_implant(notes, midi, date_hint=(start + end) / 2, date_window=(end - start) / 2 + 5000)
            analysis = analyze_implant_result(result, notes, start, end, test_name)
            results.append(analysis)
            print(f"  Status: {analysis['status']}")
            print(f"  Range: expected={analysis['expected_range']}, actual={analysis['actual_range']}")
            print(f"  Match rate: {analysis['match_rate']}, matched={analysis['matched']}, dropped={analysis['dropped']}")
            if analysis['issues']:
                for issue in analysis['issues']:
                    print(f"  ⚠ {issue}")
        except Exception as e:
            print(f"  EXCEPTION: {e}")
            results.append({"test": test_name, "status": "EXCEPTION", "error": str(e)})

    # ── Test 3: Wrong notes ──
    for region_name, start, end in regions[:2]:
        region_notes = [n for n in notes if start <= n["date"] < end]
        if len(region_notes) < 5:
            continue

        test_name = f"wrong_notes_10pct_{region_name}"
        print(f"\n{'─' * 50}")
        print(f"TEST: {test_name}")

        try:
            midi = create_student_midi(notes, start, end, ppq, bpm=80.0,
                                       timing_noise_ms=20, velocity_noise=8,
                                       wrong_note_prob=0.10, seed=42)
            result = call_implant(notes, midi, date_hint=(start + end) / 2, date_window=(end - start) / 2 + 5000)
            analysis = analyze_implant_result(result, notes, start, end, test_name)
            results.append(analysis)
            print(f"  Status: {analysis['status']}")
            print(f"  Range: expected={analysis['expected_range']}, actual={analysis['actual_range']}")
            print(f"  Match rate: {analysis['match_rate']}, matched={analysis['matched']}, dropped={analysis['dropped']}")
            if analysis['issues']:
                for issue in analysis['issues']:
                    print(f"  ⚠ {issue}")
        except Exception as e:
            print(f"  EXCEPTION: {e}")
            results.append({"test": test_name, "status": "EXCEPTION", "error": str(e)})

    # ── Test 4: Missing notes ──
    for region_name, start, end in regions[:2]:
        region_notes = [n for n in notes if start <= n["date"] < end]
        if len(region_notes) < 5:
            continue

        test_name = f"missing_notes_15pct_{region_name}"
        print(f"\n{'─' * 50}")
        print(f"TEST: {test_name}")

        try:
            midi = create_student_midi(notes, start, end, ppq, bpm=80.0,
                                       timing_noise_ms=20, velocity_noise=8,
                                       miss_note_prob=0.15, seed=42)
            result = call_implant(notes, midi, date_hint=(start + end) / 2, date_window=(end - start) / 2 + 5000)
            analysis = analyze_implant_result(result, notes, start, end, test_name, range_tolerance=3000)
            results.append(analysis)
            print(f"  Status: {analysis['status']}")
            print(f"  Range: expected={analysis['expected_range']}, actual={analysis['actual_range']}")
            print(f"  Match rate: {analysis['match_rate']}, matched={analysis['matched']}, dropped={analysis['dropped']}")
            if analysis['issues']:
                for issue in analysis['issues']:
                    print(f"  ⚠ {issue}")
        except Exception as e:
            print(f"  EXCEPTION: {e}")
            results.append({"test": test_name, "status": "EXCEPTION", "error": str(e)})

    # ── Test 5: Extra notes (student adds notes) ──
    for region_name, start, end in regions[:2]:
        region_notes = [n for n in notes if start <= n["date"] < end]
        if len(region_notes) < 5:
            continue

        test_name = f"extra_notes_10pct_{region_name}"
        print(f"\n{'─' * 50}")
        print(f"TEST: {test_name}")

        try:
            midi = create_student_midi(notes, start, end, ppq, bpm=80.0,
                                       timing_noise_ms=20, velocity_noise=8,
                                       extra_note_prob=0.10, seed=42)
            result = call_implant(notes, midi, date_hint=(start + end) / 2, date_window=(end - start) / 2 + 5000)
            analysis = analyze_implant_result(result, notes, start, end, test_name)
            results.append(analysis)
            print(f"  Status: {analysis['status']}")
            print(f"  Range: expected={analysis['expected_range']}, actual={analysis['actual_range']}")
            print(f"  Match rate: {analysis['match_rate']}, matched={analysis['matched']}, dropped={analysis['dropped']}")
            if analysis['issues']:
                for issue in analysis['issues']:
                    print(f"  ⚠ {issue}")
        except Exception as e:
            print(f"  EXCEPTION: {e}")
            results.append({"test": test_name, "status": "EXCEPTION", "error": str(e)})

    # ── Test 6: Different tempo ──
    for region_name, start, end in regions[:2]:
        region_notes = [n for n in notes if start <= n["date"] < end]
        if len(region_notes) < 5:
            continue

        for tempo_factor, tempo_label in [(0.85, "slow"), (1.15, "fast")]:
            test_name = f"tempo_{tempo_label}_{region_name}"
            print(f"\n{'─' * 50}")
            print(f"TEST: {test_name}")

            try:
                midi = create_student_midi(notes, start, end, ppq, bpm=80.0,
                                           timing_noise_ms=20, velocity_noise=8,
                                           tempo_factor=tempo_factor, seed=42)
                result = call_implant(notes, midi, date_hint=(start + end) / 2, date_window=(end - start) / 2 + 5000)
                analysis = analyze_implant_result(result, notes, start, end, test_name)
                results.append(analysis)
                print(f"  Status: {analysis['status']}")
                print(f"  Range: expected={analysis['expected_range']}, actual={analysis['actual_range']}")
                print(f"  Match rate: {analysis['match_rate']}, matched={analysis['matched']}, dropped={analysis['dropped']}")
                if analysis['issues']:
                    for issue in analysis['issues']:
                        print(f"  ⚠ {issue}")
            except Exception as e:
                print(f"  EXCEPTION: {e}")
                results.append({"test": test_name, "status": "EXCEPTION", "error": str(e)})

    # ── Test 7: Combination of issues (realistic messy student) ──
    for region_name, start, end in regions[:2]:
        region_notes = [n for n in notes if start <= n["date"] < end]
        if len(region_notes) < 5:
            continue

        test_name = f"messy_student_{region_name}"
        print(f"\n{'─' * 50}")
        print(f"TEST: {test_name}")

        try:
            midi = create_student_midi(notes, start, end, ppq, bpm=80.0,
                                       timing_noise_ms=50, velocity_noise=15,
                                       wrong_note_prob=0.05, miss_note_prob=0.10,
                                       extra_note_prob=0.05, tempo_factor=0.9, seed=42)
            result = call_implant(notes, midi, date_hint=(start + end) / 2, date_window=(end - start) / 2 + 5000)
            analysis = analyze_implant_result(result, notes, start, end, test_name)
            results.append(analysis)
            print(f"  Status: {analysis['status']}")
            print(f"  Range: expected={analysis['expected_range']}, actual={analysis['actual_range']}")
            print(f"  Match rate: {analysis['match_rate']}, matched={analysis['matched']}, dropped={analysis['dropped']}")
            if analysis['issues']:
                for issue in analysis['issues']:
                    print(f"  ⚠ {issue}")
        except Exception as e:
            print(f"  EXCEPTION: {e}")
            results.append({"test": test_name, "status": "EXCEPTION", "error": str(e)})

    # ── Summary ──
    print("\n" + "=" * 70)
    print("SUMMARY")
    print("=" * 70)

    pass_count = sum(1 for r in results if r.get("status") == "PASS")
    fail_count = sum(1 for r in results if r.get("status") == "FAIL")
    warn_count = sum(1 for r in results if r.get("status") == "WARN")
    error_count = sum(1 for r in results if r.get("status") in ("ERROR", "EXCEPTION"))

    print(f"PASS: {pass_count}  FAIL: {fail_count}  WARN: {warn_count}  ERROR: {error_count}")
    print()

    for r in results:
        status_icon = {"PASS": "✓", "FAIL": "✗", "WARN": "⚠", "ERROR": "✗", "EXCEPTION": "✗"}.get(r.get("status", "?"), "?")
        print(f"  {status_icon} {r.get('test', '?')}: {r.get('status', '?')}")
        if r.get("issues"):
            for issue in r["issues"]:
                print(f"      {issue}")

    # Dump full results as JSON for debugging
    print("\n\nDETAILED RESULTS (JSON):")
    print(json.dumps(results, indent=2, default=str))


if __name__ == "__main__":
    run_test_suite()
