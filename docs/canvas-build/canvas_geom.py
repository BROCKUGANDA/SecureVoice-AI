"""Measured layout model for the ElevenLabs Idea Canvas overlay.

Everything here is *derived* from docs/canvas-build/geometry.json (which was
produced by measure-template.py from the untouched template PDF):

  * a printed run's true glyph envelope, from its baseline and font size,
  * a box's band, from the full-width rule lines the template draws between boxes,
  * a table's row/column grid, from the short rule segments inside that band,
  * the x a column's text starts at, from the template's own printed column header.

`cells` from find_cells is deliberately NOT used: Word draws interior column rules
as fragments, so cells never close reliably.  Row band + printed-run envelopes are
enough, and they are what the verifier re-derives, so writer and gate agree on
coordinates while the checks themselves stay independent.

Envelope convention (PDF user space, y grows upward):
    top    = baseline + ASC  * size
    bottom = baseline - DESC * size
ASC/DESC are deliberately generous (the template's embedded sans subset reaches
~0.75 em above and ~0.25 em below the baseline) so that any bbox pair judged
non-intersecting here is non-intersecting on paper too.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

GEOMETRY = Path(__file__).with_name("geometry.json")

ASC = 0.78            # em above the baseline a glyph may reach
DESC = 0.28           # em below the baseline a glyph may reach
BAND_PAD = 2.0        # keep drawn ink this far inside a box band
FRAME_INSET = 0.9     # keep drawn ink this far inside a printed rule
ROW_HEAD_ROOM = 2.2   # gap between a row's top rule and the first baseline
EPS = 0.05

# characters reportlab's base-14 Helvetica cannot draw
_BAD_CHARS = {
    "\u2192": "->", "\u2190": "<-", "\u2264": "<=", "\u2265": ">=",
    "\u00d7": "x", "\u2610": "", "\u2611": "", "\u2713": "", "\u2714": "",
    "\u2011": "-", "\u2013": "\u2013", "\u2014": "\u2014",
}


class GeometryError(RuntimeError):
    pass


def sanitize(text: str) -> str:
    out = []
    for ch in text:
        if ch in _BAD_CHARS:
            out.append(_BAD_CHARS[ch])
            continue
        try:
            ch.encode("cp1252")
        except UnicodeEncodeError as exc:  # never draw a glyph we cannot measure
            raise GeometryError(f"un-drawable character {ch!r} in {text!r}") from exc
        out.append(ch)
    return "".join(out)


class Rect(tuple):
    """(x0, y0, x1, y1) with y0 < y1."""

    __slots__ = ()

    def __new__(cls, x0, y0, x1, y1):
        return super().__new__(cls, (round(min(x0, x1), 3), round(min(y0, y1), 3),
                                    round(max(x0, x1), 3), round(max(y0, y1), 3)))

    @property
    def x0(self): return self[0]
    @property
    def y0(self): return self[1]
    @property
    def x1(self): return self[2]
    @property
    def y1(self): return self[3]
    @property
    def cx(self): return (self[0] + self[2]) / 2.0
    @property
    def cy(self): return (self[1] + self[3]) / 2.0
    @property
    def w(self): return self[2] - self[0]
    @property
    def h(self): return self[3] - self[1]

    def intersects(self, other, slack: float = 0.0) -> bool:
        return not (self.x1 <= other.x0 + slack or other.x1 <= self.x0 + slack
                    or self.y1 <= other.y0 + slack or other.y1 <= self.y0 + slack)

    def contains(self, other, slack: float = 0.0) -> bool:
        return (self.x0 - slack <= other.x0 and other.x1 <= self.x1 + slack
                and self.y0 - slack <= other.y0 and other.y1 <= self.y1 + slack)

    def to_list(self):
        return [self.x0, self.y0, self.x1, self.y1]


def envelope(baseline: float, size: float) -> tuple[float, float]:
    return baseline - DESC * size, baseline + ASC * size


# --------------------------------------------------------------------- model
class Run:
    __slots__ = ("raw", "text", "x0", "x1", "baseline", "size", "top", "bottom", "page")

    def __init__(self, d: dict, page: int):
        self.raw = d["text"]
        # text used for matching: the template's runs are compared loose (dashes,
        # the Word bullet glyph, and pypdf's substitution chars differ per font)
        self.text = re.sub(r"\s+", " ", self.raw).strip()
        self.x0, self.x1 = float(d["x0"]), float(d["x1"])
        self.baseline = float(d["baseline"])
        self.size = float(d["size"])
        self.page = page
        self.bottom, self.top = envelope(self.baseline, self.size)

    @property
    def rect(self) -> Rect:
        return Rect(self.x0, self.bottom, self.x1, self.top)

    def row_of(self, tol: float = 1.2) -> tuple[float, float]:
        return self.baseline - tol, self.baseline + self.size + tol

    def __repr__(self):
        return f"<Run p{self.page} b{self.baseline} x{self.x0}-{self.x1} {self.text[:28]!r}>"


class Rule:
    __slots__ = ("orient", "at", "a", "b")

    def __init__(self, orient, at, a, b):
        self.orient, self.at, self.a, self.b = orient, at, a, b

    @property
    def span(self): return abs(self.b - self.a)


def _group(values, tol=0.7):
    """Cluster coordinates that are the same printed line, return centres."""
    out = []
    for v in sorted(values):
        if out and v - out[-1][-1] <= tol:
            out[-1].append(v)
        else:
            out.append([v])
    return [round(sum(g) / len(g), 3) for g in out]


class Page:
    def __init__(self, d: dict):
        self.number = int(d["page"])
        self.width = float(d["width"])
        self.height = float(d["height"])
        self.runs = [Run(r, self.number) for r in d["printed"]]
        self.hrules = [Rule("h", r["y"], r["x0"], r["x1"]) for r in d["h_rules"]]
        self.vrules = [Rule("v", r["x"], r["y0"], r["y1"]) for r in d["v_rules"]]
        # a box band is delimited by rule lines that run the full table width
        self.seps = sorted({r.at for r in self.hrules if r.a <= 56.0 and r.b >= 556.0}, reverse=True)
        self.boxes = {}
        for b in d["boxes"]:
            band = self.band_for(b["letter"], float(b["header_y"]))
            self.boxes[b["letter"]] = {
                "letter": b["letter"],
                "header_row": b["header_row"],
                "limits": list(b["limits"]),
                "header_y": float(b["header_y"]),
                "band_top": band[0],
                "band_bottom": band[1],
            }

    # -- bands -------------------------------------------------------------
    def band_for(self, letter: str, header_y: float) -> tuple[float, float]:
        above = [s for s in self.seps if s >= header_y - EPS]
        below = [s for s in self.seps if s <= header_y + EPS]
        top = min(above) if above else self.height - 20.0
        bottom = max(below) if below else 40.0
        return round(top, 2), round(bottom, 2)

    # -- rule lookups ------------------------------------------------------
    def hrule_lines(self, y0: float, y1: float, x0: float | None = None,
                    x1: float | None = None) -> list[float]:
        """y of every printed horizontal line whose span covers [x0, x1]."""
        out = defaultdict(list)
        for r in self.hrules:
            if not (y0 - 0.8 <= r.at <= y1 + 0.8):
                continue
            if x0 is not None and (r.a > x0 + 1.5 or r.b < x1 - 1.5):
                # accept a line built from fragments that jointly cover the range
                pass
            out[round(r.at, 1)].append((r.a, r.b))
        lines = []
        for y, segs in out.items():
            if x0 is None:
                lines.append(y)
                continue
            segs = sorted(segs)
            acc_lo, acc_hi = segs[0]
            covered = []
            for a, b in segs[1:]:
                if a <= acc_hi + 1.5:
                    acc_hi = max(acc_hi, b)
                else:
                    covered.append((acc_lo, acc_hi))
                    acc_lo, acc_hi = a, b
            covered.append((acc_lo, acc_hi))
            if any(a <= x0 + 1.5 and b >= x1 - 1.5 for a, b in covered):
                lines.append(y)
        return sorted(set(lines), reverse=True)

    def vrule_lines(self, x0: float, x1: float, y0: float | None = None,
                    y1: float | None = None) -> list[float]:
        out = []
        for r in self.vrules:
            if y0 is not None and (r.a > y0 + 1.5 or r.b < y1 - 1.5):
                continue
            if x0 - 1.5 <= r.at <= x1 + 1.5:
                out.append(r.at)
        return sorted(set(_group(out, 0.7)))

    # -- printed lookups ---------------------------------------------------
    def find_run(self, needle: str, box: str | None = None, page_box=None) -> Run | None:
        needle = re.sub(r"\s+", " ", needle).strip().lower()
        cands = []
        for r in self.runs:
            if box and page_box and not (page_box["band_bottom"] - 0.5 <= r.baseline <= page_box["band_top"] + 0.5):
                continue
            if needle in re.sub(r"\s+", " ", r.raw).strip().lower():
                cands.append(r)
        return sorted(cands, key=lambda r: (-r.baseline, r.x0))[0] if cands else None

    def row_blockers(self, rect: Rect, skip: set[int] = frozenset()) -> list[Run]:
        """printed runs that share rect's visual row (used to cap line width)."""
        return [r for r in self.runs
                if id(r) not in skip
                and r.bottom < rect.y1 and r.top > rect.y0
                and r.x1 > rect.x0 and r.x0 < rect.x1]

    def runs_in(self, rect: Rect) -> list[Run]:
        return [r for r in self.runs if rect.intersects(r.rect)]

    def tick_rows(self) -> list[tuple[Run, str, list[Run]]]:
        """(square, label text, label runs) for every printed checkbox on the page.

        Word fragments the label across runs, so the label is rebuilt from the runs
        that sit between one square and the next on the same printed line.
        """
        out = []
        for sq in sorted(self.tick_squares_of(self), key=lambda r: (-r.baseline, r.x0)):
            line = sorted((r for r in self.runs
                           if abs(r.baseline - sq.baseline) < 1.6 and r.x0 > sq.x1 - 0.5),
                          key=lambda r: r.x0)
            peers = [r for r in self.tick_squares_of(self)
                     if abs(r.baseline - sq.baseline) < 1.6 and r.x0 > sq.x1 + 1.0]
            stop = min((r.x0 for r in peers), default=1e9)
            label_runs = [r for r in line if r.x0 < stop]
            text = re.sub(r"\s+", " ", " ".join(r.text for r in label_runs)).strip()
            out.append((sq, text, label_runs))
        return out

    def tick_squares_of(self, pg=None) -> list[Run]:
        return [r for r in self.runs if "\u2610" in r.raw or "\u2611" in r.raw]


class Model:
    def __init__(self, path: Path = GEOMETRY):
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
        self.template = doc["template"]
        self.pages = {p["page"]: Page(p) for p in doc["pages"]}

    def page(self, n: int) -> Page:
        try:
            return self.pages[n]
        except KeyError:
            raise GeometryError(f"page {n} missing from geometry.json") from None

    def box(self, page_no: int, letter: str) -> dict:
        pg = self.page(page_no)
        if letter not in pg.boxes:
            raise GeometryError(f"box {letter} not measured on page {page_no}")
        return pg.boxes[letter]

    # -- clipping rectangles ------------------------------------------------
    def band_rect(self, page_no: int, letter: str) -> Rect:
        """Interior of a lettered box band: the outer frame rules, inset.

        A continuation sheet (page 5) carries no lettered box; anything drawn there
        belongs to box L and is bounded by the landing band instead.
        """
        pg = self.page(page_no)
        if letter not in pg.boxes:
            return self.landing_band(page_no)
        band = pg.boxes[letter]
        frame = [r.at for r in pg.vrules
                 if r.span >= (band["band_top"] - band["band_bottom"]) * 0.5]
        lo = min(frame) if frame else 54.02
        hi = max(frame) if frame else 558.23
        return Rect(lo + 0.6, band["band_bottom"] + 0.6, hi - 0.6, band["band_top"] - 0.6)

    def landing_band(self, page_no: int) -> Rect:
        """A continuation sheet (page 5) has no lettered box: everything from the
        page frame's top rule down to the foot margin is writable."""
        pg = self.page(page_no)
        top = max(pg.seps) - 1.0 if pg.seps else pg.height - 60.0
        return Rect(54.02 + 0.6, 40.0, 558.23 - 0.6, top)

    # -- derived layout areas ---------------------------------------------
    def table_left_right(self, pg: Page, band: dict) -> tuple[float, float]:
        """the table's inner frame inside a band, from the rules that span it."""
        h = band["band_top"] - band["band_bottom"]
        cands = [r for r in pg.vrules if r.span >= h * 0.5 and 55.0 < r.at < 555.0]
        xs = sorted(set(round(r.at, 1) for r in cands))
        if len(xs) >= 2:
            return xs[0], xs[-1]
        return 60.77, 549.98

    def table_grid(self, page_no: int, letter: str) -> dict:
        """rows (y bands) + columns (x bands, with the printed text x of each)."""
        pg, band = self.page(page_no), self.box(page_no, letter)
        top, bot = band["band_top"], band["band_bottom"]
        header_bottom = max([y for y in pg.hrule_lines(bot, top) if bot + 1.0 < y < top - 1.0] or [top])
        # header block bottom = the first rule below the header baseline
        block = [y for y in pg.hrule_lines(bot, header_bottom) if y < band["header_y"] - 0.5]
        header_block_bottom = max(block) if block else header_bottom

        lines = [y for y in pg.hrule_lines(bot, header_block_bottom) if bot + 0.5 <= y <= header_block_bottom + 0.5]
        # keep only lines that cross the whole table (row separators)
        row_lines = []
        for y in lines:
            segs = [(r.a, r.b) for r in pg.hrules if abs(r.at - y) <= 0.8]
            lo = min(s[0] for s in segs)
            hi = max(s[1] for s in segs)
            if hi - lo < 400:      # a short rule is a tick box, not a row line
                continue
            row_lines.append(y)
        row_lines = sorted(set(_group(row_lines, 0.7)), reverse=True)
        if not row_lines:
            raise GeometryError(f"box {letter} p{page_no}: no row lines derived")

        # column edges: endpoints that repeat across the row lines
        edge_count = defaultdict(int)
        for y in row_lines:
            for r in pg.hrules:
                if abs(r.at - y) <= 0.8:
                    edge_count[round(r.a, 1)] += 1
                    edge_count[round(r.b, 1)] += 1
        thresh = max(2, int(len(row_lines) * 0.6))
        edges = sorted(e for e, n in edge_count.items() if n >= thresh)
        edges = [e for e in edges if edges[0] - 1 <= e <= edges[-1] + 1]
        cols = []
        for i in range(len(edges) - 1):
            x0, x1 = edges[i], edges[i + 1]
            if x1 - x0 < 12:      # fragment, not a column
                continue
            cols.append({"x0": x0, "x1": x1})
        if not cols:
            raise GeometryError(f"box {letter} p{page_no}: no columns derived")

        # header row = topmost band that carries printed text
        bands = [(row_lines[i], row_lines[i + 1]) for i in range(len(row_lines) - 1)]
        header_index = None
        for i, (ytop, ybot) in enumerate(bands):
            in_band = [r for r in pg.runs if ybot - 0.5 < r.baseline < ytop + 0.5]
            if in_band and all(re.search(r"[A-Z]", r.text) for r in in_band) and \
               max(r.x0 for r in in_band) > cols[0]["x0"] + 3:
                header_index = i
                break
        data_bands = bands[header_index + 1:] if header_index is not None else bands

        # printed x a column's text starts at (from the header row itself)
        hdr = bands[header_index] if header_index is not None else None
        for c in cols:
            start = None
            if hdr:
                for r in pg.runs:
                    if hdr[1] - 0.5 < r.baseline < hdr[0] + 0.5 and c["x0"] - 2 <= r.x0 <= c["x1"]:
                        start = r.x0 if start is None else min(start, r.x0)
            c["text_x"] = round(start, 2) if start is not None else round(c["x0"] + 6.7, 2)

        return {"rows": [{"top": t, "bottom": b} for t, b in data_bands],
                "all_rows": [{"top": t, "bottom": b} for t, b in bands],
                "cols": cols,
                "header_block_bottom": header_block_bottom,
                "table_top": row_lines[0], "table_bottom": row_lines[-1]}

    def prose_area(self, page_no: int, letter: str, *, top_below: Run | None = None) -> Rect:
        """free writing space: below the lowest printed prompt line, above the band."""
        pg, band = self.page(page_no), self.box(page_no, letter)
        grid_top = band["band_top"]
        rows = [r for r in pg.runs
                if band["band_bottom"] - 0.5 < r.baseline < grid_top - 0.5
                and r.baseline < band["header_y"] - 3.0]
        lowest = min(r.bottom for r in rows) if rows else band["header_y"] - 14.0
        top = (top_below.top if top_below else lowest) - 2.0
        return Rect(60.77 + FRAME_INSET, band["band_bottom"] + BAND_PAD,
                    549.98 - FRAME_INSET, top)

    def tick_squares(self, page_no: int) -> list[Run]:
        """the printed empty-box glyphs on a page (the template draws them as text)."""
        pg = self.page(page_no)
        return [r for r in pg.runs if "\u2610" in r.raw or "\u2611" in r.raw]


# ------------------------------------------------------------------ wrapping
def string_width(text: str, font: str, size: float) -> float:
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.pdfmetrics import stringWidth
    pdfmetrics.getFont(font)
    return stringWidth(text, font, size)


def wrap(text: str, font: str, size: float, width: float) -> list[str] | None:
    """greedy wrap; None when a single word cannot fit."""
    words = text.split()
    if not words:
        return []
    lines, cur = [], words[0]
    for w in words[1:]:
        trial = f"{cur} {w}"
        if string_width(trial, font, size) <= width + EPS:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    for line in lines:
        if string_width(line, font, size) > width + EPS:
            return None
    return lines


def word_count(text: str) -> int:
    return len([w for w in re.split(r"\s+", sanitize(text).strip()) if w])
