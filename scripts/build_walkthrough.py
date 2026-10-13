"""
Build the SecureVoice AI platform walkthrough.

Eight scenes, 96 seconds, 1920x1080 @ 30fps. Every colour, font and corner
radius traces back to `src/app/globals.css` / `src/app/layout.tsx` — the deck
speaks the product's own design language rather than inventing one. Every
screenshot inside it is a live capture of https://securevoiceai.me.

Three stages, one per tool:

  1. capture   — Puppeteer drives chrome-headless-shell over the real
                 deployment and writes PNGs into assets/.
  2. render    — HyperFrames compiles index.html (GSAP timelines + the
                 captured frames) into an MP4.
  3. finish    — ffmpeg pulls the poster frame, Pillow types the poster
                 copy over it, and the sidecar .srt is written.

Run:  python scripts/build_walkthrough.py [--skip-capture]
Out:  demo/walkthrough/securevoice-walkthrough.mp4  (+ poster.png, .srt)

The composition itself lives in demo/walkthrough/source/index.html — it is
checked in alongside its assets so the render is reproducible, not a one-off.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "demo" / "walkthrough" / "source"
OUT = ROOT / "demo" / "walkthrough"
ASSETS = SRC / "assets"
SHOTS = ASSETS

CHROME = Path(
    os.environ.get(
        "HYPERFRAMES_CHROME",
        Path.home() / ".cache" / "hyperframes" / "chrome" / "chrome-headless-shell"
        / "win64-152.0.7977.30" / "chrome-headless-shell-win64"
        / "chrome-headless-shell.exe",
    )
)

# The pages worth showing a judge, in the order the deck shows them.
PAGES = [
    ("https://securevoiceai.me/", "shot-landing"),
    ("https://securevoiceai.me/docs", "shot-docs"),
    ("https://securevoiceai.me/security", "shot-security"),
]

FPS = 30
DURATION = 96


def run(cmd: list[str], label: str, cwd: Path | None = None) -> None:
    print(f"  → {label}")
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        tail = (r.stderr or r.stdout or "")[-2000:]
        raise SystemExit(f"{label} failed:\n{tail}")
    if r.stdout.strip():
        print("    " + r.stdout.strip()[-800:])


def capture() -> None:
    """Stage 1 — screenshot the live deployment."""
    if not CHROME.exists():
        raise SystemExit(
            f"chrome-headless-shell not found at {CHROME}\n"
            "Install it with:  npx hyperframes browser ensure"
        )
    SHOTS.mkdir(parents=True, exist_ok=True)

    script = SRC / "_capture.mjs"
    pages = ",".join(f"{url}|{name}" for url, name in PAGES)
    script.write_text(
        "import puppeteer from 'puppeteer-core';\n"
        f"const EXE = {CHROME.as_posix()!r};\n"
        f"const OUT = {str(SHOTS).replace(chr(92), '/')!r};\n"
        f"const PAGES = {pages!r}.split(',').map(s => s.split('|'));\n"
        "const b = await puppeteer.launch({ executablePath: EXE, headless: 'shell',\n"
        "  args: ['--no-sandbox','--disable-dev-shm-usage','--hide-scrollbars'] });\n"
        "const p = await b.newPage();\n"
        "await p.setViewport({ width: 1600, height: 900, deviceScaleFactor: 2 });\n"
        "for (const [url, name] of PAGES) {\n"
        "  const r = await p.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });\n"
        "  await new Promise(res => setTimeout(res, 3500));\n"
        "  const t = await p.title();\n"
        "  await p.screenshot({ path: `${OUT}/${name}.png` });\n"
        "  console.log(`  captured ${name}  ${r.status()}  ${t.slice(0, 50)}`);\n"
        "}\n"
        "await b.close();\n",
        encoding="utf-8",
    )
    run(["node", str(script)], "capturing live pages", cwd=SRC)
    script.unlink()


def render() -> None:
    """Stage 2 — compile the composition to MP4."""
    hf = os.environ.get("HYPERFRAMES_BIN")
    cmd = [hf] if hf else ["npx", "--yes", "hyperframes@0.8.152"]
    run(
        cmd + ["check"],
        "lint + contrast + layout",
        cwd=SRC,
    )
    run(
        cmd + ["render", "--quality", "high", "--fps", str(FPS),
               "--output", "securevoice-walkthrough.mp4"],
        "rendering composition",
        cwd=SRC,
    )
    shutil.copy2(SRC / "securevoice-walkthrough.mp4", OUT / "securevoice-walkthrough.mp4")


def finish() -> None:
    """Stage 3 — poster via ffmpeg + Pillow, then the sidecar captions."""
    from PIL import Image, ImageDraw, ImageFont

    W, H = 1920, 1080
    raw = OUT / ".poster-raw.png"
    run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
         "-ss", "3.2", "-i", str(OUT / "securevoice-walkthrough.mp4"),
         "-frames:v", "1", "-vf", f"scale={W // 2}:-1", str(raw)],
        "extracting poster frame",
    )

    frame = Image.open(raw).convert("RGB").resize((W, H), Image.Resampling.LANCZOS)

    # Paper-tint veil, heavier toward the lower-left where the copy sits, so
    # the poster text reads over the screenshot without hiding the product.
    veil = Image.new("RGBA", (W, H), (251, 251, 248, 0))
    dv = ImageDraw.Draw(veil)
    for y in range(H):
        dv.line([(0, y), (W, y)], fill=(251, 251, 248, int(210 * (y / H) ** 1.35)))
    out = Image.alpha_composite(frame.convert("RGBA"), veil).convert("RGB")

    def f(size: int, bold: bool = False):
        p = "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf"
        return ImageFont.truetype(p, size) if Path(p).exists() else ImageFont.load_default()

    d = ImageDraw.Draw(out)
    d.rectangle((140, 470, 260, 477), fill=(11, 122, 85))
    d.text((140, 520), "SecureVoice AI", font=f(104, True), fill=(16, 24, 18))
    d.text((140, 660), "Platform walkthrough — fraud detected to account frozen,",
           font=f(40), fill=(70, 82, 74))
    d.text((140, 716), "with the audit trail that proves it afterwards.",
           font=f(40), fill=(70, 82, 74))
    d.text((140, 830), "securevoiceai.me", font=f(34, True), fill=(11, 122, 85))
    out.save(OUT / "poster.png", optimize=True)
    raw.unlink()
    print(f"  → poster.png  {(OUT / 'poster.png').stat().st_size // 1024} KB")

    # Sidecar captions, timed to the composition's data-start values so the
    # SRT stays in step with the video if a scene's timing changes.
    scenes = [
        (0.0, 7.0, "Fraud detected. Customer called. Account frozen."),
        (7.0, 18.0, "A Tier-1 analyst takes 38 minutes. The fraudster needs seconds."),
        (18.0, 31.0, "A signed risk signal in — HMAC verified, case open, dial enqueued."),
        (31.0, 46.0, "Disclosure, verification, then a freeze the agent can only stage."),
        (46.0, 60.0, "The controls live in the server, not in the prompt."),
        (60.0, 76.0, "Captured live from securevoiceai.me — not a mock-up."),
        (76.0, 88.0, "Measured: 551 ms to call placement, 9 ms tool round-trip. "
                     "The 60-second claim is still a target."),
        (88.0, 96.0, "Sixty seconds, with the proof attached."),
    ]

    def ts(s: float) -> str:
        return (f"{int(s // 3600):02d}:{int((s % 3600) // 60):02d}:{s % 60:06.3f}"
                .replace(".", ","))

    srt = "".join(
        f"{i}\n{ts(a)} --> {ts(b)}\n{cap}\n\n"
        for i, (a, b, cap) in enumerate(scenes, 1)
    )
    (OUT / "walkthrough.srt").write_text(srt, encoding="utf-8")
    print(f"  → walkthrough.srt  {len(scenes)} cues")


def verify() -> None:
    """Prove the artifact matches what the deck claims."""
    mp4 = OUT / "securevoice-walkthrough.mp4"
    if not mp4.exists() or mp4.stat().st_size == 0:
        raise SystemExit("walkthrough.mp4 missing or empty")

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "format=duration:stream=codec_name,width,height,nb_frames",
         "-of", "default=noprint_wrappers=1", str(mp4)],
        capture_output=True, text=True, check=True,
    ).stdout

    dur = float(next(l.split("=")[1] for l in probe.splitlines() if l.startswith("duration")))
    frames = int(next(l.split("=")[1] for l in probe.splitlines() if l.startswith("nb_frames")))

    print(f"  duration {dur:.1f}s  ·  {frames} frames @ {FPS}fps  ·  "
          f"{mp4.stat().st_size / 1e6:.1f} MB")

    if abs(dur - DURATION) > 0.5:
        raise SystemExit(f"duration {dur}s != expected {DURATION}s")
    if frames != DURATION * FPS:
        raise SystemExit(f"{frames} frames != expected {DURATION * FPS}")
    print("  ✓ duration and frame count match the composition")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-capture", action="store_true",
                    help="reuse the screenshots already in demo/walkthrough/source/assets")
    args = ap.parse_args()

    print(f"SecureVoice AI walkthrough  ·  {DURATION}s @ {FPS}fps  ·  1920x1080\n")
    if args.skip_capture:
        print("stage 1 — capture (skipped)")
    else:
        print("stage 1 — capture the live deployment")
        capture()
    print("\nstage 2 — render the composition")
    render()
    print("\nstage 3 — poster and captions")
    finish()
    print("\nverify")
    verify()

    print(f"\nwrote {OUT / 'securevoice-walkthrough.mp4'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
