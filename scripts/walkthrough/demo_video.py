"""
SecureVoice AI — demo showcase video generator.

Pipeline:
  1. edge-tts synthesises natural, upbeat narration (no API key required)
  2. Pillow renders each scene as a 1920x1080 frame with the app's own palette
  3. ffmpeg assembles frames + audio into an MP4 with a sidecar .srt

The visual language matches the product: clean fintech, light surfaces,
the brand green (#0b7a55), generous whitespace, no dark-mode tokens.

Usage:
  python scripts/walkthrough/demo_video.py [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# ── canvas ──────────────────────────────────────────────────────────────────
WIDTH, HEIGHT = 1920, 1080
FPS = 30
BG = (251, 251, 248)          # --paper
CARD = (255, 255, 255)       # --card
INK = (16, 24, 18)            # --foreground
INK2 = (70, 82, 74)           # --ink-2
INK3 = (102, 116, 103)        # --ink-3
LINE = (231, 234, 227)        # --line
PRIMARY = (11, 122, 85)       # --primary
GREEN_DEEP = (8, 92, 63)      # --green-deep
GREEN_BRIGHT = (20, 163, 116) # --green-bright
GREEN_TINT = (233, 245, 239)  # --green-tint
RED = (214, 69, 80)           # --destructive
AMBER = (185, 122, 17)        # --amber-soft
WHITE = (255, 255, 255)

# ── narration script ────────────────────────────────────────────────────────
# ~15 characters per second is the pacing budget. Upbeat but measured.
VOICE_NAME = "Microsoft Zira Desktop"   # natural-sounding female, en-US
SAPI_RATE = 2    # -10..+10; +2 is slightly upbeat, still natural

SCENES: list[dict] = [
    {
        "id": "01-problem",
        "chapter": "The gap",
        "title": "38 minutes vs 60 seconds",
        "subtitle": "Real-time voice fraud intervention",
        "narration": (
            "A bank's fraud engine flags a case. An analyst takes nine minutes to see it "
            "and thirty-eight to work it. A fraudster needs seconds. SecureVoice AI closes "
            "that gap — the platform, live."
        ),
        "captions": ["A fraud case takes an agent 38 minutes", "A fraudster needs seconds"],
        "accent": PRIMARY,
    },
    {
        "id": "02-detect",
        "chapter": "Detection",
        "title": "Signed risk signal in",
        "subtitle": "Bank webhook → platform ingest",
        "narration": (
            "A signed risk signal arrives from the bank's fraud engine. The platform verifies "
            "the signature, resolves the customer, and opens a case — all in under a second."
        ),
        "captions": ["HMAC-signed inbound webhook", "Signature verified before ingest"],
        "accent": GREEN_BRIGHT,
    },
    {
        "id": "03-call",
        "chapter": "The call",
        "title": "Detection to call in seconds",
        "subtitle": "Outbound voice, customer's language",
        "narration": (
            "The platform places an outbound call. The agent opens with a disclosure, verifies "
            "the transaction, and freezes the card — phase by phase, never asking for a PIN "
            "or a password."
        ),
        "captions": ["Disclosure → verification → freeze", "Never asks for PIN, OTP or password"],
        "accent": PRIMARY,
    },
    {
        "id": "04-multilingual",
        "chapter": "Multilingual",
        "title": "The same flow in any language",
        "subtitle": "Voice identity per language",
        "narration": (
            "The customer's language is the agent's language. English, Arabic, Hindi, Urdu, "
            "French, Swahili — each carries its own voice, so it never sounds translated."
        ),
        "captions": ["Six languages, six voice identities", "Bilingual transcript on screen"],
        "accent": GREEN_DEEP,
    },
    {
        "id": "05-audit",
        "chapter": "Evidence",
        "title": "A chain that proves itself",
        "subtitle": "Immutable audit log",
        "narration": (
            "Every action is sealed as a row in an immutable audit log. A SHA-256 hash over "
            "the canonical serialisation, chained to the row before it — so editing any field "
            "breaks the link from that point onward."
        ),
        "captions": ["SHA-256 hash chain", "Tamper-evident by construction"],
        "accent": AMBER,
    },
    {
        "id": "06-outcome",
        "chapter": "Outcome",
        "title": "Frozen in 60 seconds",
        "subtitle": "Fraud detected · Customer called · Account frozen",
        "narration": (
            "Fraud detected, customer called, account frozen — sixty seconds instead of "
            "thirty-eight minutes, in the customer's own language, with an audit trail that "
            "proves itself afterwards. That is SecureVoice AI."
        ),
        "captions": ["60 seconds, not 38 minutes", "Audit trail included"],
        "accent": PRIMARY,
    },
]


# ── fonts ────────────────────────────────────────────────────────────────────
def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        "C:/Windows/Fonts/segoui.ttf" if not bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arial.ttf" if not bold else "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/calibri.ttf" if not bold else "C:/Windows/Fonts/calibrib.ttf",
    ]
    # Prefer Segoe UI (Windows system font, clean fintech look)
    seg = "C:/Windows/Fonts/segoeuisl.ttf" if not bold else "C:/Windows/Fonts/segoeuib.ttf"
    for p in [seg] + candidates:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def text_size(draw: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont) -> tuple[int, int]:
    bbox = draw.textbbox((0, 0), text, font=f)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def wrap(draw: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont, max_w: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    cur = ""
    for w in words:
        trial = (cur + " " + w).strip()
        tw, _ = text_size(draw, trial, f)
        if tw <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


# ── frame rendering ──────────────────────────────────────────────────────────
def rounded_rect(draw: ImageDraw.ImageDraw, xy, radius: int, fill=None, outline=None, width: int = 1):
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def draw_scene(scene: dict, frame_idx: int, total_frames: int) -> Image.Image:
    img = Image.new("RGB", (WIDTH, HEIGHT), BG)
    d = ImageDraw.Draw(img)
    accent: tuple = scene.get("accent", PRIMARY)

    # ── top bar ──────────────────────────────────────────────────────────────
    d.rectangle([0, 0, WIDTH, 6], fill=accent)

    # ── chapter eyebrow ──────────────────────────────────────────────────────
    eyebrow_font = font(22, bold=True)
    chapter = scene.get("chapter", "").upper()
    tw, th = text_size(d, chapter, eyebrow_font)
    d.text((120, 60), chapter, font=eyebrow_font, fill=accent)

    # rule under eyebrow
    d.line([120, 60 + th + 12, 120 + tw + 40, 60 + th + 12], fill=LINE, width=2)

    # ── title ────────────────────────────────────────────────────────────────
    title_font = font(76, bold=True)
    title = scene.get("title", "")
    lines = wrap(d, title, title_font, WIDTH - 240)
    ty = 140
    for line in lines:
        d.text((120, ty), line, font=title_font, fill=INK)
        ty += 92

    # ── subtitle ─────────────────────────────────────────────────────────────
    sub_font = font(34, bold=False)
    subtitle = scene.get("subtitle", "")
    d.text((120, ty + 8), subtitle, font=sub_font, fill=INK2)
    ty += 60

    # ── feature card ─────────────────────────────────────────────────────────
    card_y = ty + 40
    card_h = HEIGHT - card_y - 200
    rounded_rect(d, [120, card_y, WIDTH - 120, card_y + card_h], radius=20, fill=CARD, outline=LINE, width=2)

    # accent bar on card
    rounded_rect(d, [120, card_y, 128, card_y + card_h], radius=20, fill=accent)
    d.rectangle([124, card_y, 128, card_y + card_h], fill=accent)  # square off inner edge

    # ── captions inside the card ────────────────────────────────────────────
    cap_font = font(30, bold=False)
    captions = scene.get("captions", [])
    cy = card_y + 48
    for cap in captions:
        # bullet
        d.ellipse([170, cy + 12, 182, cy + 24], fill=accent)
        d.text((200, cy), cap, font=cap_font, fill=INK)
        cy += 52

    # ── chapter indicator dots ───────────────────────────────────────────────
    total = len(SCENES)
    idx = SCENES.index(scene)
    dot_r = 6
    gap = 18
    total_w = total * dot_r * 2 + (total - 1) * gap
    sx = (WIDTH - total_w) // 2
    dy = HEIGHT - 90
    for i in range(total):
        cx = sx + i * (dot_r * 2 + gap) + dot_r
        if i == idx:
            d.ellipse([cx - dot_r, dy - dot_r, cx + dot_r, dy + dot_r], fill=PRIMARY)
        else:
            d.ellipse([cx - dot_r, dy - dot_r, cx + dot_r, dy + dot_r], fill=LINE)

    # ── brand mark ───────────────────────────────────────────────────────────
    brand_font = font(20, bold=True)
    d.text((WIDTH - 260, 60), "SecureVoice AI", font=brand_font, fill=INK3)

    # ── subtle animation: progress bar at bottom ────────────────────────────
    progress = frame_idx / max(1, total_frames - 1)
    bar_w = int(WIDTH * 0.3)
    bar_x = (WIDTH - bar_w) // 2
    bar_y = HEIGHT - 40
    rounded_rect(d, [bar_x, bar_y, bar_x + bar_w, bar_y + 6], radius=3, fill=LINE)
    rounded_rect(d, [bar_x, bar_y, bar_x + int(bar_w * progress), bar_y + 6], radius=3, fill=PRIMARY)

    return img


def render_intro_frame() -> Image.Image:
    """Opening title card."""
    img = Image.new("RGB", (WIDTH, HEIGHT), BG)
    d = ImageDraw.Draw(img)

    # Centered logo mark
    f_big = font(120, bold=True)
    f_sub = font(40, bold=False)
    f_tag = font(24, bold=True)

    title = "SecureVoice AI"
    sub = "Real-time voice fraud intervention"
    tag = "PLATFORM SHOWCASE"

    tw, th = text_size(d, title, f_big)
    sw, sh = text_size(d, sub, f_sub)
    gw, gh = text_size(d, tag, f_tag)

    cx = WIDTH // 2
    cy = HEIGHT // 2 - 60

    # accent bar
    d.rectangle([cx - 80, cy - 40, cx - 72, cy + th + 40], fill=PRIMARY)

    d.text((cx - tw // 2 + 20, cy), title, font=f_big, fill=INK)
    d.text((cx - sw // 2 + 20, cy + th + 24), sub, font=f_sub, fill=INK2)
    d.text((cx - gw // 2 + 20, cy + th + 90), tag, font=f_tag, fill=PRIMARY)

    return img


# ── TTS ──────────────────────────────────────────────────────────────────────
def synth_narration(text: str, out_path: Path) -> float:
    """Synthesize narration via PowerShell SAPI. Returns duration in seconds."""
    ps_script = f"""
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('{VOICE_NAME}')
$s.Rate = {SAPI_RATE}
$s.SetOutputToWaveFile('{out_path}')
$s.Speak(@'
{text}
'@)
$s.Dispose()
"""
    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps_script],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"SAPI TTS failed:\n{result.stderr[-500:]}")

    # probe duration
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(out_path)],
        capture_output=True, text=True, check=True,
    )
    return float(probe.stdout.strip())


def ffmpeg(args: list[str], label: str) -> None:
    try:
        subprocess.run(["ffmpeg"] + args, check=True, capture_output=True)
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode() if e.stderr else ""
        raise RuntimeError(f"{label} failed:\n{stderr[-2000:]}")


# ── main ─────────────────────────────────────────────────────────────────────
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="render frames without TTS")
    args = ap.parse_args()

    out_dir = Path(__file__).parent / "out" / "demo"
    audio_dir = out_dir / "audio"
    frame_dir = out_dir / "frames"
    final_dir = out_dir / "final"

    for d in [out_dir, audio_dir, frame_dir, final_dir]:
        d.mkdir(parents=True, exist_ok=True)

    print(f"Canvas: {WIDTH}x{HEIGHT} @ {FPS}fps")
    print(f"Scenes: {len(SCENES)}")
    print(f"Voice:  {VOICE_NAME} @ rate {SAPI_RATE}")
    print()

    # ── Stage 1: TTS narration ───────────────────────────────────────────────
    timings = []
    total_dur = 0.0

    for i, scene in enumerate(SCENES):
        audio_path = audio_dir / f"{scene['id']}.wav"
        print(f"  [{i+1}/{len(SCENES)}] {scene['id']} — synthesising narration...")

        if args.dry_run:
            dur = 8.0
        else:
            dur = synth_narration(scene["narration"], audio_path)

        scene_dur = max(dur + 0.8, 4.0)  # breathing room after narration
        timings.append({
            "id": scene["id"],
            "narr": audio_path.name,
            "narr_dur": round(dur, 2),
            "scene_dur": round(scene_dur, 2),
            "at": round(total_dur, 2),
        })
        total_dur += scene_dur
        print(f"        narration {dur:.1f}s  →  scene {scene_dur:.1f}s")

    # intro + outro
    intro_dur = 3.0
    outro_dur = 3.0
    total_dur += intro_dur + outro_dur

    print(f"\nTotal duration: {total_dur:.1f}s")
    (out_dir / "timings.json").write_text(json.dumps({
        "total": round(total_dur, 2),
        "intro_dur": intro_dur,
        "outro_dur": outro_dur,
        "scenes": timings,
    }, indent=2))

    # ── Stage 2: render frames ──────────────────────────────────────────────
    print("\nRendering frames...")
    intro_frames = intro_dur * FPS
    for f in range(int(intro_frames)):
        img = render_intro_frame()
        # subtle fade-in
        alpha = min(1.0, f / (FPS * 0.6))
        img = img.point(lambda p: int(p * alpha + BG[0] * (1 - alpha)))
        img.save(frame_dir / f"intro_{f:05d}.png")

    for t in timings:
        scene = next(s for s in SCENES if s["id"] == t["id"])
        n = int(t["scene_dur"] * FPS)
        for f in range(n):
            img = draw_scene(scene, f, n)
            img.save(frame_dir / f"{t['id']}_{f:05d}.png")

    # outro = reuse last scene's frame with a fade
    last_scene = SCENES[-1]
    for f in range(int(outro_dur * FPS)):
        img = draw_scene(last_scene, 0, 1)
        alpha = max(0.0, 1.0 - f / (FPS * 0.8))
        img = img.point(lambda p: int(p * alpha + BG[0] * (1 - alpha)))
        img.save(frame_dir / f"outro_{f:05d}.png")

    frame_count = len(list(frame_dir.glob("*.png")))
    print(f"  {frame_count} frames rendered")

    # ── Stage 3: assemble with ffmpeg ────────────────────────────────────────
    print("\nAssembling video...")

    # Encode each segment as its own MP4 (image2 demuxer + pattern), then
    # concat the per-segment MP4s. This is the same approach the existing
    # walkthrough pipeline uses — it is far more reliable than feeding 2000+
    # individual PNGs through the concat demuxer.
    clip_dir = out_dir / "clip"
    clip_dir.mkdir(parents=True, exist_ok=True)

    def encode_clip(name: str, pattern: str, dur: float, audio: Path | None) -> Path:
        out = clip_dir / f"{name}.mp4"
        args = [
            "-y",
            "-framerate", str(FPS),
            "-i", str(frame_dir / pattern),
            "-t", f"{dur:.2f}",
        ]
        if audio:
            args += ["-i", str(audio)]
        args += [
            "-vf", f"scale={WIDTH}:{HEIGHT},format=yuv420p",
            "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-pix_fmt", "yuv420p", "-r", str(FPS),
        ]
        if audio:
            args += [
                "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
                "-af", "afade=t=in:st=0:d=0.4,afade=t=out:st=" + f"{max(0, dur - 0.7):.2f}" + ":d=0.7",
                "-shortest",
            ]
        else:
            args += ["-an"]
        args.append(str(out))
        ffmpeg(args, name)
        return out

    clips: list[Path] = []

    # Intro: silent title card
    intro_clip = encode_clip("intro", "intro_%05d.png", intro_dur, None)
    clips.append(intro_clip)

    # Scenes: narration + frames
    for t in timings:
        clip = encode_clip(t["id"], f"{t['id']}_%05d.png", t["scene_dur"], audio_dir / t["narr"])
        clips.append(clip)

    # Outro: silent fade
    outro_clip = encode_clip("outro", "outro_%05d.png", outro_dur, None)
    clips.append(outro_clip)

    # Concat all clips
    list_file = clip_dir / "list.txt"
    list_file.write_text("\n".join(f"file '{c.name}'" for c in clips) + "\n")

    raw_mp4 = out_dir / "raw.mp4"
    ffmpeg([
        "-y",
        "-f", "concat", "-safe", "0", "-i", str(list_file),
        "-c", "copy",
        "-movflags", "+faststart",
        str(raw_mp4),
    ], "concat")

    # ── Stage 4: sidecar captions ────────────────────────────────────────────
    srt = ""
    n = 0
    at = intro_dur
    for t in timings:
        scene = next(s for s in SCENES if s["id"] == t["id"])
        half = t["scene_dur"] / max(1, len(scene.get("captions", [])))
        for k, cap in enumerate(scene.get("captions", [])):
            s = at + k * half
            e = at + (k + 1) * half - 0.1
            n += 1
            srt += f"{n}\n{fmt_srt(s)} --> {fmt_srt(e)}\n{cap}\n\n"
        at += t["scene_dur"]

    srt_path = final_dir / "demo.srt"
    # Explicit UTF-8: the caption text is ASCII but `Path.write_text` takes the
    # LOCALE encoding on Windows, and cp1252 raises on any arrow/dash the script
    # may carry. Encoding is a property of the file, not of the machine.
    srt_path.write_text(srt, encoding="utf-8")

    # ── final output ─────────────────────────────────────────────────────────
    final_mp4 = final_dir / "securevoice-demo.mp4"
    shutil.copy2(raw_mp4, final_mp4)

    # poster
    ffmpeg([
        "-y", "-ss", str(total_dur * 0.45), "-i", str(final_mp4),
        "-frames:v", "1", str(final_dir / "poster.png"),
    ], "poster")

    print(f"\nDemo video → {final_mp4}")
    print(f"  Captions  → {srt_path}")
    print(f"  Poster    → {final_dir / 'poster.png'}")
    print(f"  Duration  → {total_dur:.1f}s")


def fmt_srt(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ",")


if __name__ == "__main__":
    main()
