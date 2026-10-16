"""
Build the SecureVoice AI demo reel from real captures of the live site.

Every frame here is a screenshot of https://securevoiceai.me taken in a real
browser — nothing is a mock-up. Pillow composes the title cards and does the
rounding/letterboxing; ffmpeg does the crossfades and encodes the MP4.

Frames, in order:
  1. Title card
  2. Landing — the 61-second promise
  3. Docs — integration surface
  4. Security — controls and audit chain

Run:  python scripts/build_demo_reel.py
Out:  demo/securevoice-demo.mp4  (+ demo/frames/*.png)
"""

from __future__ import annotations

import glob
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, ".openchamber", "screenshots")
OUT_DIR = os.path.join(ROOT, "demo")
FRAMES = os.path.join(OUT_DIR, "frames")

W, H = 1600, 900
FPS = 30

# Brand palette, read off the design tokens in src/app/globals.css.
INK = (16, 24, 18)  # --foreground
PAPER = (251, 251, 248)  # --paper
GREEN = (11, 122, 85)  # --primary
MUTED = (92, 104, 93)  # --ink-3, darkened for contrast

TITLE_CARD = ("SecureVoice AI", "Real-time fraud intervention for banks and insurers",
              "Live deployment — securevoiceai.me")

# (glob fragment, heading, subheading, seconds)
SLIDES = [
    ("01b-landing", "Fraud detected. Call placed. Frozen.",
     "A voice agent closes the gap between detection and intervention — in 60 seconds, not 38 minutes.", 4.5),
    ("03-docs", "Integrate in an afternoon",
     "Signed webhooks, a turn API, and a guardrail policy you can read before you call it.", 4.0),
    ("04-security", "Controls a risk officer can sign off",
     "CBUAE-aligned guardrails, AES-256 at rest, and a hash-chained audit trail on every turn.", 4.0),
]


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    """Prefer a real TTF; fall back to the bitmap default so this never hard-fails."""
    candidates = [
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            return ImageFont.truetype(c, size)
    return ImageFont.load_default()


def newest(pattern: str) -> str | None:
    hits = sorted(glob.glob(os.path.join(SHOTS, pattern + "*.jpg")))
    return hits[-1] if hits else None


def fit(src: Image.Image, w: int, h: int) -> Image.Image:
    """Cover-fit into w×h, then centre-crop. No letterboxing, no distortion."""
    scale = max(w / src.width, h / src.height)
    resized = src.resize((round(src.width * scale), round(src.height * scale)), Image.LANCZOS)
    left = (resized.width - w) // 2
    top = (resized.height - h) // 2
    return resized.crop((left, top, left + w, top + h))


def rounded(img: Image.Image, radius: int = 18) -> Image.Image:
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.width, img.height), radius=radius, fill=255)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def drop_shadow(img: Image.Image, blur: int = 26, alpha: int = 90) -> Image.Image:
    """Add a soft shadow behind a rounded RGBA card.

    The previous implementation returned `composite(black_opaque, sh, mask)`,
    which evaluates to opaque BLACK everywhere the mask is non-zero — it
    replaced the entire screenshot with a black rectangle. Verified broken by
    extracting a frame from the output MP4 and reading it.

    The correct shape: paste the card onto a shadow-coloured canvas, using the
    card's own alpha as the mask, offset by a few pixels.
    """
    pad = blur + 8
    canvas = Image.new("RGBA", (img.width + pad * 2, img.height + pad * 2), (0, 0, 0, 0))
    # 1. The shadow: the card's alpha, blurred, painted in shadow black.
    alpha_ch = img.split()[3].filter(ImageFilter.GaussianBlur(blur))
    shadow = Image.new("RGBA", img.size, (16, 24, 18, alpha))
    shadow.putalpha(alpha_ch.point(lambda v: v * alpha // 255))
    canvas.paste(shadow, (pad, pad + 4), shadow)
    # 2. The card itself, on top, offset up-left so the shadow reads as depth.
    canvas.paste(img, (pad, pad), img)
    return canvas


def title_card() -> Image.Image:
    im = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(im)
    # A whisper of the grid the site draws behind its hero.
    for x in range(0, W, 64):
        d.line([(x, 0), (x, H)], fill=(240, 242, 236), width=1)
    for y in range(0, H, 64):
        d.line([(0, y), (W, y)], fill=(240, 242, 236), width=1)

    name, line, foot = TITLE_CARD
    d.text((120, 380), name, font=font(86, bold=True), fill=INK)
    d.rectangle((120, 500, 120 + 96, 500 + 6), fill=GREEN)
    d.text((120, 540), line, font=font(34), fill=MUTED)
    d.text((120, H - 110), foot, font=font(22), fill=GREEN)
    return im


def caption_slide(shot: str, heading: str, sub: str) -> Image.Image:
    """Screenshot in a floating frame, with a caption bar beneath it."""
    im = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(im)

    pad = 64
    frame_w, frame_h = W - pad * 2, int((H - pad * 2 - 170))
    shot_img = Image.open(shot).convert("RGB")
    shot_img = fit(shot_img, frame_w, frame_h)
    card = rounded(shot_img.convert("RGBA"))
    card = drop_shadow(card)

    x = pad
    y = pad
    im.paste(card, (x, y), card)

    ty = y + frame_h + 44
    d.rectangle((pad, ty, pad + 56, ty + 5), fill=GREEN)
    d.text((pad, ty + 26), heading, font=font(42, bold=True), fill=INK)
    # Wrap the subheading rather than trusting one long line to fit.
    words, line_txt, lines = sub.split(), "", []
    for wd in words:
        if ImageDraw.Draw(im).textlength(line_txt + " " + wd, font=font(23)) > W - pad * 2 - 40:
            lines.append(line_txt)
            line_txt = wd
        else:
            line_txt = (line_txt + " " + wd).strip()
    if line_txt:
        lines.append(line_txt)
    for i, ln in enumerate(lines[:2]):
        d.text((pad, ty + 84 + i * 32), ln, font=font(23), fill=MUTED)
    return im


def main() -> int:
    os.makedirs(FRAMES, exist_ok=True)

    slides: list[tuple[Image.Image, float, str]] = []
    slides.append((title_card(), 4.0, "frames/00-title.png"))
    title_card().save(os.path.join(FRAMES, "00-title.png"))

    idx = 1
    # Capture in a fixed, known order: the OLDEST captures sort first
    # ("01b-landing-2026..." < "01b-landing-after-settle-..."? no), so take the
    # newest by mtime, not by filename. Glob + sorted(..., key=mtime)[-1].
    for pattern, heading, sub, secs in SLIDES:
        candidates = sorted(glob.glob(os.path.join(SHOTS, pattern + "*.jpg")), key=os.path.getmtime)
        shot = candidates[-1] if candidates else None
        if not shot:
            print(f"  !! no capture matched {pattern!r} — skipping that slide", file=sys.stderr)
            continue
        frame = caption_slide(shot, heading, sub)
        name = f"frames/{idx:02d}-{pattern}.png"
        frame.save(os.path.join(OUT_DIR, name))
        slides.append((frame, secs, name))
        print(f"  + {name}  <- {os.path.basename(shot)}")
        idx += 1

    print(f"\n{len(slides)} frames; encoding with ffmpeg at {FPS}fps")

    # One image per frame -> mp4, crossfaded between slides.
    inputs: list[str] = []
    filters: list[str] = []
    for i, (_img, secs, _name) in enumerate(slides):
        # Forward slashes: ffmpeg on Windows rejects mixed separators.
        path = (os.path.join(OUT_DIR, _name)).replace("\\", "/")
        inputs += ["-loop", "1", "-t", f"{secs}", "-i", path]

    # Chained xfades: offsets are measured in the ALREADY-MERGED stream, so each
    # is the previous offset plus the next clip's duration minus the crossfade.
    # The original accumulation added RAW durations, which drifted further off
    # with every slide and truncated the output (verified: 7.9s of an expected
    # 14.7s, with the last slides never rendered).
    D = 0.6
    offsets: list[float] = []
    for i in range(len(slides) - 1):
        if i == 0:
            o = slides[0][1] - D
        else:
            o = offsets[i - 1] + slides[i][1] - D
        offsets.append(round(o, 3))
    total = (offsets[-1] + slides[-1][1]) if offsets else (slides[0][1] if slides else 0.0)

    for i in range(len(slides) - 1):
        # Each xfade consumes the PREVIOUS xfade's output, not the raw inputs.
        # The original chain re-used [i:v][i+1:v], which left every earlier
        # output unconnected and produced an invalid filtergraph.
        a = f"[{i}:v]" if i == 0 else f"[xf{i - 1}]"
        b = f"[{i + 1}:v]"
        filters.append(f"{a}{b}xfade=transition=fade:duration={D}:offset={offsets[i]}[xf{i}]")
    tail = (
        "[xf%d]fps=%d,format=yuv420p[v]" % (len(slides) - 2, FPS)
        if len(slides) > 1
        else "[0:v]fps=%d,format=yuv420p[v]" % FPS
    )

    # Chained xfades: each offset is measured from the start of the ALREADY
    # merged stream, not from the individual clip. So the offsets accumulate by
    # (duration - crossfade) per step, which is also the total runtime.
    # Total runtime = sum of all slide durations (used for timing).
    total = sum(sec for _, sec, _ in slides) if slides else 0.0
    cmd = (
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
        + inputs
        + ["-filter_complex", ";".join(filters + [tail]), "-map", "[v]",
           "-c:v", "libx264", "-preset", "medium", "-crf", "21",
           "-movflags", "+faststart",
           (os.path.join(OUT_DIR, "securevoice-demo.mp4")).replace("\\", "/")]
    )
    subprocess.run(cmd, check=True)
    size = os.path.getsize(os.path.join(OUT_DIR, "securevoice-demo.mp4"))
    print(f"\nwrote demo/securevoice-demo.mp4  ({total:.1f}s, {size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())