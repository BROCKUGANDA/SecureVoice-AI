"""Measure the ElevenLabs Idea Canvas template.

Emits docs/canvas-build/geometry.json:
  - printed text runs with true bounding boxes (embedded font widths)
  - horizontal / vertical rule segments (the template draws every border as a thin filled rect)
  - table cells reconstructed from rules that close on all four sides
  - the lettered box (A-Q) each cell belongs to
  - the limits the template prints on the page ("25 words max", "Two links", ...)

Nothing downstream hardcodes a coordinate; the renderer and verifier read this file.
"""
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import pypdf

TEMPLATE = Path(r"<home>/Downloads/ElevenLabs_Idea_Canvas.pdf")
OUT = Path(__file__).with_name("geometry.json")

RULE_MAX_THICKNESS = 1.6   # borders are drawn ~0.25-0.8pt thick
MIN_CELL = 8.0             # ignore slivers that are not real cells
BOX_HEADER = re.compile(r"^([A-Q])\s+[A-Z]")


# ---------------------------------------------------------------- font widths
class FontMetrics:
    """Advance widths for the template's embedded (subset) fonts.

    pypdf's visitor hands back the resolved font dictionary rather than its /Resources
    key, so fonts are also indexed by object identity.
    """

    def __init__(self, page):
        self.fonts = {}
        self.by_id = {}
        for key, ref in (page.get("/Resources", {}).get("/Font") or {}).items():
            try:
                f = ref.get_object()
            except Exception:
                continue
            widths, first = self._widths(f)
            entry = {
                "widths": widths,
                "first": first,
                "missing": float(f.get("/DW", 1000)),
                "descent": self._descent(f),
            }
            self.fonts[key] = entry
            self.by_id[id(f)] = entry

    @staticmethod
    def _descent(font):
        try:
            return float(font["/FontDescriptor"].get_object().get("/Descent", 200))
        except Exception:
            return 200.0

    def _entry(self, font):
        if isinstance(font, dict):
            got = self.by_id.get(id(font))
            if got:
                return got
        return self.fonts.get(font) or next(iter(self.fonts.values()), None)

    @staticmethod
    def _widths(font):
        first = int(font.get("/FirstChar", 0))
        arr = font.get("/Widths")
        if arr is None:
            return {}, first
        try:
            arr = arr.get_object()
        except Exception:
            return {}, first
        return {first + i: float(w.get_object()) for i, w in enumerate(arr)}, first

    def text_width(self, font, size, text):
        f = self._entry(font)
        if not f:
            return size * 0.5 * len(text)
        total = 0.0
        for ch in text:
            total += f["widths"].get(ord(ch), f["missing"])
        return total * size / 1000.0

    def descent(self, font, size):
        f = self._entry(font)
        d = f["descent"] if f else 200.0
        return abs(d) * size / 1000.0


# ---------------------------------------------------------------- text + rules
def collect_runs(page):
    metrics = FontMetrics(page)
    runs = []

    def visit(text, cm, tm, font_resource, font_size, *_):
        s = text if isinstance(text, str) else ""
        s = s.strip()
        if not s:
            return
        size = float(font_size or abs(tm[3]) or 0) or 8.0
        x, y = float(tm[4]), float(tm[5])
        w = metrics.text_width(font_resource, size, s)
        runs.append({
            "text": s,
            "x0": round(x, 2),
            "x1": round(x + w, 2),
            "baseline": round(y, 2),
            "top": round(y + metrics.descent(font_resource, size), 2),
            "bottom": round(y - size * 0.94, 2),
            "size": round(size, 2),
        })

    page.extract_text(visitor_text=visit)
    return runs


def collect_rules(page):
    """Thin filled rects -> horizontal and vertical segments in device space."""
    data = page.get_contents().get_data().decode("latin-1")
    h, v = [], []
    for m in re.finditer(r"([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+re", data):
        x, y, w, ht = (float(g) for g in m.groups())
        if w <= 0 or ht <= 0 or (w >= 600 and ht >= 700):
            continue
        if ht <= RULE_MAX_THICKNESS and w > RULE_MAX_THICKNESS:
            h.append({"y": round(y, 2), "x0": round(x, 2), "x1": round(x + w, 2)})
        elif w <= RULE_MAX_THICKNESS and ht > RULE_MAX_THICKNESS:
            v.append({"x": round(x, 2), "y0": round(y, 2), "y1": round(y + ht, 2)})

    def dedupe(segs, keys, span_key, tol=0.8):
        out = []
        for s in sorted(segs, key=lambda d: (d[keys[0]], d[keys[1]])):
            for o in out:
                if abs(o[keys[0]] - s[keys[0]]) <= tol and \
                   abs(o[span_key[0]] - s[span_key[0]]) <= tol and \
                   abs(o[span_key[1]] - s[span_key[1]]) <= tol:
                    break
            else:
                out.append(s)
        return out

    h = dedupe(h, ("y", "x0"), ("x0", "x1"))
    v = dedupe(v, ("x", "y0"), ("y0", "y1"))
    return h, v


# ---------------------------------------------------------------- cell finding
def cluster(values, tol=1.0):
    """Group near-identical coordinates; return [(centre, [members])]."""
    groups = []
    for v in sorted(values):
        if groups and v - groups[-1][-1] <= tol:
            groups[-1].append(v)
        else:
            groups.append([v])
    return [(round(sum(g) / len(g), 2), g) for g in groups]


def interval_map(segs, fixed_key, a_key, b_key, tol=1.0):
    """fixed value -> merged list of (a, b) spans, clustering fixed values within tol."""
    centres = cluster([s[fixed_key] for s in segs], tol)
    lookup = {}
    for centre, members in centres:
        for v in members:
            lookup[round(v, 2)] = centre
    merged = {}
    for s in segs:
        c = lookup[round(s[fixed_key], 2)]
        merged.setdefault(c, []).append((s[a_key], s[b_key]))
    out = {}
    for c, spans in merged.items():
        spans.sort()
        acc = []
        for a, b in spans:
            if acc and a <= acc[-1][1] + 1.5:
                acc[-1][1] = max(acc[-1][1], b)
            else:
                acc.append([a, b])
        out[c] = [tuple(x) for x in acc]
    return out


def covers(spans, a, b, slack=1.5):
    lo, hi = a + slack, b - slack
    for s0, s1 in spans:
        if s0 <= lo + 0.5 and s1 >= hi - 0.5:
            return True
    return False


def find_cells(h_rules, v_rules):
    """A cell = rect whose four sides are each covered by drawn segments (possibly joined)."""
    hmap = interval_map(h_rules, "y", "x0", "x1")
    vmap = interval_map(v_rules, "x", "y0", "y1")
    ys = sorted(hmap)
    xs = sorted(vmap)

    cells = []
    for i in range(len(ys) - 1):
        y0, y1 = ys[i], ys[i + 1]
        if y1 - y0 < MIN_CELL:
            continue
        for j in range(len(xs) - 1):
            x0, x1 = xs[j], xs[j + 1]
            if x1 - x0 < MIN_CELL:
                continue
            if covers(hmap.get(y0, []), x0, x1) and covers(hmap.get(y1, []), x0, x1) \
               and covers(vmap.get(x0, []), y0, y1) and covers(vmap.get(x1, []), y0, y1):
                cells.append({"x0": x0, "y0": y0, "x1": x1, "y1": y1})

    # A cell fully enclosed by another with identical bounds on all sides is a duplicate.
    uniq = []
    for c in cells:
        if not any(u == c for u in uniq):
            uniq.append(c)
    return uniq


def build_boxes(runs, cells, page_height):
    """Box letter runs stand alone at the left edge; the header row also carries the limit.

    Returns bands (letter, title, limit text, y_top, y_bottom) and assigns each cell to a band.
    """
    letters = [r for r in runs if len(r["text"]) == 1 and "A" <= r["text"] <= "Q" and r["x0"] < 78]
    letters.sort(key=lambda r: -r["baseline"])

    boxes = []
    for i, hd in enumerate(letters):
        y = hd["baseline"]
        row = [r for r in runs if abs(r["baseline"] - y) <= 3.0]
        title = " ".join(r["text"] for r in sorted(row, key=lambda r: r["x0"]))
        y_bottom = letters[i + 1]["baseline"] if i + 1 < len(letters) else 30
        boxes.append({
            "letter": hd["text"],
            "header_y": y,
            "y_top": y + 12,
            "y_bottom": y_bottom,
            "header_row": title,
        })

    for c in cells:
        c["box"] = next((b["letter"] for b in boxes if b["y_bottom"] < c["y1"] <= b["y_top"]), None)
    return boxes


LIMIT_RE = re.compile(
    r"(\d+\s+words?\s+max|\d+\s+words per step|\d+\s+words per row|Max \d+ KPIs?|"
    r"Two links|One link|Numbers only|Complete every field|No adjectives)", re.I)


def main():
    reader = pypdf.PdfReader(str(TEMPLATE))
    doc = {"template": str(TEMPLATE), "pages": []}
    for i, page in enumerate(reader.pages):
        runs = collect_runs(page)
        h, v = collect_rules(page)
        cells = find_cells(h, v)
        boxes = build_boxes(runs, cells, float(page.mediabox.height))
        for b in boxes:
            b["limits"] = sorted({m.group(0).lower() for m in LIMIT_RE.finditer(b["header_row"])})
        doc["pages"].append({
            "page": i + 1,
            "width": float(page.mediabox.width),
            "height": float(page.mediabox.height),
            "printed": runs,
            "h_rules": h,
            "v_rules": v,
            "cells": cells,
            "boxes": boxes,
        })
        print(f"page {i+1}: {len(runs)} runs, {len(cells)} cells")
        for b in boxes:
            n = sum(1 for c in cells if c["box"] == b["letter"])
            print(f"   box {b['letter']} y {b['y_bottom']}..{b['y_top']} cells={n} "
                  f"limits={b['limits']} | {b['header_row'][:58]}")

    OUT.write_text(json.dumps(doc, indent=1), encoding="utf-8")
    print(f"\nwrote {OUT} ({OUT.stat().st_size//1024} KB)")


if __name__ == "__main__":
    sys.exit(main())
