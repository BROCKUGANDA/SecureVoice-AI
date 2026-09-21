"""Stage 2 - Pillow graphics: key cards and caption overlays.

Reads the storyboard dump (out/story.json, written by dump-story.mjs from
scenes.mjs) so story text lives in exactly one place. Captions are emitted as
full-frame alpha PNGs, which lets assembly overlay them with a single ffmpeg
filter instead of drawing text during the encode.
"""
import json, os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
CARD = os.path.join(HERE, "out", "card")
W, H = 1920, 1080

INK = (10, 15, 12)
PAPER = (247, 245, 240)
ACCENT = (197, 154, 78)
TEAL = (47, 169, 145)
MUTED = (150, 158, 152)

os.makedirs(CARD, exist_ok=True)


def font(bold, size):
    names = ("segoeuib.ttf", "arialbd.ttf", "segoeui.ttf", "arial.ttf") if bold else \
            ("segoeui.ttf", "arial.ttf", "segoeuib.ttf")
    for n in names:
        p = os.path.join("C:/Windows/Fonts", n)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def wrap(d, text, f, maxw):
    cur, lines = "", []
    for w in text.split():
        trial = (cur + " " + w).strip()
        if d.textlength(trial, font=f) <= maxw:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def lattice(d):
    for y in range(-72, H + 72, 72):
        for x in range(-72, W + 72, 72):
            d.polygon([(x + 36, y + 24), (x + 48, y + 36), (x + 36, y + 48), (x + 24, y + 36)],
                      outline=(255, 255, 255))


def keycard(s):
    img = Image.new("RGB", (W, H), INK)
    d = ImageDraw.Draw(img)
    lattice(d)
    d.rectangle([0, H - 6, W, H], fill=ACCENT)
    d.text((140, 196), "S E C U R E V O I C E   A I", font=font(True, 26), fill=ACCENT)
    if s.get("chapter"):
        d.text((140, 236), s["chapter"].upper(), font=font(False, 22), fill=MUTED)
    y = 330
    for ln in wrap(d, s["title"], font(True, 92), W - 300)[:3]:
        d.text((140, y), ln, font=font(True, 92), fill=PAPER)
        y += 108
    if s.get("subtitle"):
        d.text((140, y + 20), s["subtitle"], font=font(False, 38), fill=TEAL)
    yy = H - 176
    for cap in s.get("captions", [])[:2]:
        d.text((140, yy), "- " + cap, font=font(False, 24), fill=MUTED)
        yy += 38
    img.save(os.path.join(CARD, s["id"] + ".png"))


def lower_third(s, i, total):
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pill = "%d / %d    %s" % (i + 1, total, (s.get("chapter") or "").upper())
    pw = d.textlength(pill, font=font(True, 22))
    d.rounded_rectangle([90, H - 268, 90 + pw + 46, H - 214], 26,
                        fill=(10, 15, 12, 215), outline=(197, 154, 78, 200), width=1)
    d.text((113, H - 254), pill, font=font(True, 22), fill=(197, 154, 78, 255))
    d.rounded_rectangle([90, H - 198, W - 90, H - 92], 22, fill=(10, 15, 12, 196))
    y = H - 184
    for cap in s.get("captions", [])[:2]:
        for ln in wrap(d, cap, font(False, 32), W - 280)[:1]:
            d.text((124, y), ln, font=font(False, 32), fill=(247, 245, 240, 250))
            y += 46
    img.save(os.path.join(CARD, "cap-" + s["id"] + ".png"))


story = json.load(open(os.path.join(HERE, "out", "story.json"), encoding="utf-8"))
caps = [s for s in story if s["kind"] == "capture"]
for s in story:
    if s["kind"] == "card":
        keycard(s)
for i, s in enumerate(caps):
    lower_third(s, i, len(caps))
print("  cards: %d key cards, %d caption overlays" % (len(story) - len(caps), len(caps)))
