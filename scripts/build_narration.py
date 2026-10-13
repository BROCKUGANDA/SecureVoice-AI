#!/usr/bin/env python
"""
Narration for the SecureVoice AI walkthrough.

One WAV per scene, synthesised with the hyperframes Kokoro TTS. The text is
deliberately plain-spoken and paced for ~15 characters/second, so each clip
lands inside its scene window with room to breathe rather than running over
the crossfade.

The numbers spoken here are the ones the deck shows on screen: two measured
p95 figures and one explicitly-labelled target. The 60-second claim is spoken
as a target, not as a measurement — the same distinction scene 7 makes
visually.

Run:  python scripts/build_narration.py
Out:  demo/walkthrough/source/assets/narration/<scene>.wav
      demo/walkthrough/source/assets/narration/timings.json
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "demo" / "walkthrough" / "source"
AUDIO = SRC / "assets" / "narration"

HF = os.environ.get(
    "HYPERFRAMES_BIN",
    "C:/Users/HP/AppData/Local/Temp/hf/node_modules/hyperframes/bin/hyperframes.mjs",
)
# The engine resolves `python3` first, which on this host is a scoop build with
# no kokoro-onnx. Point it at the interpreter that actually has the package.
PY = os.environ.get("HYPERFRAMES_PYTHON", "C:/Users/HP/anaconda3/python.exe")
VOICE = os.environ.get("NARRATION_VOICE", "af_heart")

# scene id -> spoken line. Keep each under ~200 characters so it clears the
# Kokoro phonemizer quickly and reads as one breath.
SCENES = [
    ("01-title",
     "SecureVoice AI. Real-time voice fraud intervention for banking "
     "and insurance. Deployed, live, and audited end to end."),
    ("02-gap",
     "A bank's fraud engine flags a case. An analyst takes nine minutes "
     "to see it, and thirty-eight to work it. The fraudster moves in seconds."),
    ("03-ingest",
     "A signed risk signal arrives. The platform verifies the signature, "
     "resolves the customer, and opens a case, under a second. The call "
     "category then selects the agent's prompt, its powers, and the "
     "preconditions enforced before a single dial."),
    ("04-call",
     "The platform places an outbound call. The agent opens with a "
     "disclosure, verifies the transaction, and stages a protective action. "
     "It never asks for a PIN, an OTP, or a password."),
    ("05-guardrails",
     "The controls live in the server, not in the prompt. A freeze is only "
     "ever staged, and a human finalises it. Pre-production cannot reach a "
     "real customer."),
    ("06-live",
     "Everything you have just seen is running. Captured live from "
     "securevoiceai.me."),
    ("07-evidence",
     "Two legs are measured. Five hundred fifty-one milliseconds from signal "
     "to call placement, and nine milliseconds for a tool round-trip. The "
     "sixty-second claim is still a target."),
    ("08-close",
     "Sixty seconds, with the proof attached. SecureVoice AI."),
]


def synth(scene_id: str, text: str) -> Path:
    out = AUDIO / f"{scene_id}.wav"
    r = subprocess.run(
        ["node", HF, "tts", text, "--voice", VOICE, "--output", str(out)],
        capture_output=True, text=True,
        env={**os.environ, "HYPERFRAMES_PYTHON": PY},
    )
    if r.returncode != 0 or not out.exists():
        raise SystemExit(f"TTS failed for {scene_id}:\n{(r.stderr or r.stdout)[-1200:]}")
    return out


def duration(wav: Path) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(wav)],
        capture_output=True, text=True, check=True,
    )
    return float(r.stdout.strip())


def main() -> int:
    AUDIO.mkdir(parents=True, exist_ok=True)
    print(f"voice: {VOICE}  ·  python: {PY}\n")

    timings = {}
    for scene_id, text in SCENES:
        wav = synth(scene_id, text)
        d = duration(wav)
        timings[scene_id] = {"duration": round(d, 3), "text": text}
        print(f"  {scene_id:<12} {d:6.2f}s  {wav.stat().st_size // 1024:>5} KB")

    (AUDIO / "timings.json").write_text(
        json.dumps(timings, indent=2), encoding="utf-8"
    )
    total = sum(t["duration"] for t in timings.values())
    print(f"\n  total narration {total:.1f}s across {len(timings)} scenes")
    print(f"  → {AUDIO / 'timings.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
