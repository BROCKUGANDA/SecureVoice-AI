"""Fill the ElevenLabs Stage 1 Idea Canvas: the only writer of the submission PDF.

    python render-canvas.py            # -> docs/idea-canvas-submission.pdf
                                       #    + docs/canvas-build/draw-list.json

Reads docs/canvas-build/content.json (every A-Q answer) and geometry.json (measured
from the untouched template), merges the overlay onto a COPY of the template with
pypdf, and never writes to the template itself.

Placement model - the previous attempt hand-guessed rectangles and printed over the
form, so here:
  * a box band comes from the full-width rule lines the template draws between boxes;
  * a table's row/column grid is re-derived from the short rule segments inside a band;
  * an answer's first baseline is the baseline of the printed label it belongs to
    (row-anchored, exactly like a human filling the form), and its right edge is capped
    by the next printed run on that row or the column's own rule, whichever is nearer;
  * text is wrapped with reportlab's real font metrics and auto-shrinks 7.5pt -> 6.0pt.
    If it still will not fit, the build fails and names the box: it never spills and it
    never draws below 6pt;
  * every drawn glyph (text line, tick stroke, pill, arrow, dot) is recorded with its
    bbox in draw-list.json, which verify-canvas.py re-checks independently.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from reportlab.pdfgen import canvas as rl_canvas
from pypdf import PdfReader, PdfWriter

sys.path.insert(0, str(Path(__file__).parent))

import canvas_geom as G                                   # noqa: E402
from canvas_geom import ASC, DESC, EPS, Rect, GeometryError  # noqa: E402

CONTENT = Path(__file__).with_name("content.json")
DRAWS = Path(__file__).with_name("draw-list.json")
OUT = Path(__file__).parents[1] / "idea-canvas-submission.pdf"
TEMPLATE_FALLBACK = Path(r"C:/Users/HP/Downloads/ElevenLabs_Idea_Canvas.pdf")

INK = (0.06, 0.07, 0.13)
LINE = (0.30, 0.32, 0.38)


class BuildError(RuntimeError):
    """Content cannot be placed inside the template's own geometry."""


# ------------------------------------------------------------------- sheet
class Sheet:
    """Collects drawn items (with bboxes) and later renders them."""

    def __init__(self, model: G.Model, cfg: dict):
        self.m = model
        self.font = cfg.get("font", "Helvetica")
        self.bold = cfg.get("font_bold", "Helvetica-Bold")
        self.smax = float(cfg.get("size_max", 7.5))
        self.smin = float(cfg.get("size_min", 6.0))
        self.lead = float(cfg.get("leading", 1.18))
        self.items: list[dict] = []
        self.errors: list[str] = []

    def add(self, *, kind, page, box, bbox, clip, role, text=None, font=None,
            size=None, baseline=None, inside_run=None, crosses_rule=False, style=None):
        self.items.append({
            "kind": kind, "page": page, "box": box, "role": role,
            "bbox": [round(bbox.x0, 2), round(bbox.y0, 2), round(bbox.x1, 2), round(bbox.y1, 2)],
            "clip": [round(clip.x0, 2), round(clip.y0, 2), round(clip.x1, 2), round(clip.y1, 2)],
            "text": text, "font": font,
            "size": None if size is None else round(size, 3),
            "baseline": None if baseline is None else round(baseline, 2),
            "inside_run": inside_run, "crosses_rule": bool(crosses_rule), "style": style,
        })

    def fit(self, text, area: Rect, *, font, size_max, size_min, anchor):
        """(size, lines, baselines) that fits area.

        The block starts on `anchor` - the baseline of the printed label it answers -
        and grows downward.  A multi-line answer is shifted up inside its own row when
        the row's lower rule would cut it off, which is what a person filling the form
        does; it is never allowed past either rule.
        """
        size = size_max
        tries = []
        while size > size_min + EPS:
            tries.append(round(size, 3))
            size = round(size - 0.25, 3)
        tries.append(round(size_min, 3))
        for size in tries:
            lines = G.wrap(text, font, size, area.w)
            if lines is not None:
                step = size * self.lead
                need = (ASC + DESC) * size + step * (len(lines) - 1)
                if need <= area.h + 2 * EPS:
                    first = area.y1 - ASC * size - 0.3
                    if anchor is not None:
                        first = min(first, anchor)
                    last_bottom = first - step * (len(lines) - 1) - DESC * size
                    if last_bottom < area.y0:
                        first += area.y0 - last_bottom
                    if first + ASC * size <= area.y1 + EPS:
                        return size, lines, [first - step * i for i in range(len(lines))]
        return None

    def flow(self, text, area: Rect, *, page, box, clip=None, role="prose", font=None,
             size_max=None, size_min=None, anchor=None, x_start=None, width_cap=None,
             name=None, inside_run=None, crosses_rule=False):
        """Draw a wrapped block inside `area`; returns the size actually used."""
        text = G.sanitize(text)
        font = font or self.font
        size_max = min(size_max or self.smax, 9.0)
        # hard 6pt floor: nothing on this submission is drawn smaller (brief rule 3)
        size_min = max(self.smin, min(size_min or self.smin, 6.0))
        clip = clip or self.m.band_rect(page, box)
        x0 = area.x0 if x_start is None else max(area.x0, x_start)
        right = area.x1 if width_cap is None else min(area.x1, width_cap)
        box_area = Rect(x0, area.y0, right, area.y1)
        got = self.fit(text, box_area, font=font, size_max=size_max, size_min=size_min,
                       anchor=anchor)
        if got is None:
            size = size_min
            room = int((box_area.h - (ASC + DESC) * size) // (size * self.lead)) + 1
            per_line = int(box_area.w / (size * 0.485))
            self.errors.append(
                f"{name or ('box ' + str(box))} p{page}: {len(text)} chars "
                f"({G.word_count(text)} words) do not fit {box_area.w:.0f}x{box_area.h:.1f}pt "
                f"at >= {size}pt - capacity is {room} lines x {per_line} chars = {room * per_line}")
            return size, box_area.y0_min
        size, lines, bases = got
        for ln, b in zip(lines, bases):
            self.add(kind="text", page=page, box=box, role=role, clip=clip, font=font,
                     size=size, baseline=b, text=ln, inside_run=inside_run,
                     crosses_rule=crosses_rule,
                     bbox=Rect(box_area.x0, b - DESC * size,
                               box_area.x0 + G.string_width(ln, font, size), b + ASC * size))
        return size, bases[-1] - DESC * size

    # -- vector helpers ----------------------------------------------------
    def tick(self, page, box, run: G.Run, clip):
        """A vector check stroke inside the template's own printed square."""
        w, h = run.x1 - run.x0, run.top - run.bottom
        pts = [[run.x0 + w * 0.13, run.bottom + h * 0.46],
               [run.x0 + w * 0.42, run.bottom + h * 0.16],
               [run.x1 - w * 0.08, run.top - h * 0.14]]
        pad = 0.3
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        self.add(kind="tick", page=page, box=box, role="tick", clip=clip,
                 inside_run={"page": page, "raw": run.raw, "x0": run.x0, "x1": run.x1,
                             "baseline": run.baseline, "size": run.size},
                 bbox=Rect(min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad),
                 style={"path": pts, "width": 1.15})

    def polyline(self, page, box, pts, *, clip, width=0.8, arrow=None, role="flow"):
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        pad = width / 2 + (3.0 if arrow else 0.2)
        self.add(kind="polyline", page=page, box=box, role=role, clip=clip, crosses_rule=True,
                 bbox=Rect(min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad),
                 style={"pts": [[round(x, 2), round(y, 2)] for x, y in pts],
                        "width": width, "arrow": arrow, "color": list(LINE)})

    def dot(self, page, box, x, y, clip, r=1.8):
        self.add(kind="dot", page=page, box=box, role="pii", clip=clip, crosses_rule=True,
                 bbox=Rect(x - r, y - r, x + r, y + r), style={"x": round(x, 2), "y": round(y, 2), "r": r})

    def pill(self, page, box, rect: Rect, clip):
        self.add(kind="rect", page=page, box=box, role="node", clip=clip, bbox=rect,
                 style={"width": 0.7, "radius": 2.0, "color": list(LINE)})


# -------------------------------------------------------------- lookups
def row_cap(pg: G.Page, baseline: float, size: float, x_from: float, hard: float) -> float:
    """Right edge for a line: nearest printed run further right on the same row."""
    lo, hi = G.envelope(baseline, size)
    limit = hard
    for r in pg.runs:
        if r.bottom < hi and r.top > lo and r.x0 > x_from + 10 and r.x0 < limit:
            limit = r.x0 - 3.0
    return limit


def row_anchor(pg: G.Page, col_x0: float, row: dict):
    """The printed run (if any) that owns this row, left of the answer column."""
    cands = [r for r in pg.runs
             if row["bottom"] - 0.6 < r.baseline < row["top"] + 0.6 and r.x1 <= col_x0 + 1.0]
    return max(cands, key=lambda r: r.baseline) if cands else None


def column_map(pg: G.Page, grid: dict, names: list[str], box: str) -> list[int]:
    """Match each content column name to a derived column by its printed header."""
    hdr = grid["all_rows"][0]
    heads = []
    for c in grid["cols"]:
        txt = " ".join(r.text for r in pg.runs
                       if hdr["bottom"] - 1.5 < r.baseline < hdr["top"] + 1.5
                       and c["x0"] - 3 <= r.x0 <= c["x1"]).lower()
        heads.append(txt)
    idx = []
    for i, name in enumerate(names):
        want = name.split("(")[0].strip().lower().split()[0] if name.split() else ""
        hit = next((j for j, t in enumerate(heads) if want and want in t and j not in idx), None)
        if hit is None:
            if len(grid["cols"]) - len(names) > i - 0 and len(names) == 1:
                hit = len(grid["cols"]) - 1
            else:
                hit = i + (len(grid["cols"]) - len(names))
        idx.append(hit)
    if len(set(idx)) != len(idx):
        raise BuildError(f"box {box}: columns {names} map to duplicates {idx} (headers {heads})")
    return idx


# --------------------------------------------------------------- fillers
def fill_fields(sh: Sheet, m: G.Model, spec: dict):
    """Box A: label/answer pairs, anchored on the printed field label."""
    page, box = spec["page"], "A"
    pg = m.page(page)
    grid = m.table_grid(page, box)
    band_clip = m.band_rect(page, box)
    which = {"left": 1, "right": 3}
    for f in spec["fields"]:
        col = grid["cols"][which[f["col"]]]
        row = grid["rows"][f["row"]]
        label = pg.find_run(f["label"])
        if label is None or not row["bottom"] - 2 < label.baseline < row["top"] + 2:
            raise BuildError(f"box A row {f['row']}: printed field {f['label']!r} "
                             f"not found inside that row band")
        cap = row_cap(pg, label.baseline, sh.smax, col["text_x"], col["x1"] - G.FRAME_INSET)
        sh.flow(f["text"], Rect(col["text_x"], row["bottom"] + 0.6, col["x1"] - G.FRAME_INSET,
                                row["top"] - 0.6),
                page=page, box=box, clip=band_clip, role="answer", anchor=label.baseline,
                width_cap=cap, name=f"A/{f['label']}")


def fill_table(sh: Sheet, m: G.Model, box: str, spec: dict):
    """A ruled table: content rows x named columns mapped onto the derived grid."""
    page = spec["page"]
    pg = m.page(page)
    grid = m.table_grid(page, box)
    band_clip = m.band_rect(page, box)
    if len(grid["rows"]) < len(spec["rows"]):
        raise BuildError(f"box {box} p{page}: template has {len(grid['rows'])} rows, "
                         f"content brings {len(spec['rows'])}")
    idx = column_map(pg, grid, spec["columns"], box)
    for ri, vals in enumerate(spec["rows"]):
        row = grid["rows"][ri]
        for ci, val in enumerate(vals):
            col = grid["cols"][idx[ci]]
            area = Rect(col["text_x"], row["bottom"] + 0.6, col["x1"] - G.FRAME_INSET,
                        row["top"] - 0.6)
            # the template prints some cells for us (row numbers, the Box K requirement
            # column): start after that ink instead of on top of it
            lab = row_anchor(pg, col["x1"] - 2.0, row)
            start = None
            if lab is not None and lab.x0 >= col["x0"] - 1.0 and lab.x1 > col["text_x"]:
                start = lab.x1 + 3.0
            anchor = lab.baseline if lab is not None else None
            cap = row_cap(pg, anchor if anchor else row["top"] - 8, sh.smax,
                          start or area.x0, area.x1)
            sh.flow(str(val), area, page=page, box=box, clip=band_clip, role="cell",
                    anchor=anchor, x_start=start, width_cap=cap,
                    name=f"{box} row{ri + 1} col{ci + 1}")


def fill_prose(sh: Sheet, m: G.Model, box: str, spec: dict):
    page = spec["page"]
    area = m.prose_area(page, box)
    sh.flow(spec["text"], area, page=page, box=box, clip=m.band_rect(page, box),
            role="prose", name=f"box {box}")


def _norm(s: str) -> str:
    return "".join(ch for ch in s.lower() if ch.isalnum() or ch == " ").strip()


def fill_ticks(sh: Sheet, m: G.Model, box: str, spec: dict):
    """Vector checks inside the template's own printed squares.

    The label of a square is rebuilt from the runs between it and the next square, so
    a Word line that splits "Each institution system by name" over two runs still
    resolves to its square.
    """
    want_norm = {_norm(t["label"]) for t in spec["items"]}
    done: set[str] = set()
    for page in sorted({t["page"] for t in spec["items"]}):
        pg = m.page(page)
        clip = m.band_rect(page, box)
        by_row = {}
        for sq, text, _runs in pg.tick_rows():
            by_row.setdefault(_norm(text), []).append(sq)
        for item in [t for t in spec["items"] if t["page"] == page]:
            key = _norm(item["label"])
            squares = by_row.get(key)
            if not squares:
                near = sorted(k for k in by_row if key[:14] in k or k[:14] in key)
                raise BuildError(f"{spec.get('where', box)} p{page}: no printed square for "
                                 f"{item['label']!r} (closest: {near[:3]})")
            sh.tick(page, box, squares[0], clip)
            done.add(key)
    if want_norm - done:
        raise BuildError(f"{spec.get('where', box)}: unticked items {sorted(want_norm - done)}")
    return sorted(done)


def fill_lane_grid(sh: Sheet, m: G.Model, box: str, spec: dict):
    """Box H: printed lane label anchors each row, printed STAGE headers each column."""
    page = spec["page"]
    pg = m.page(page)
    grid = m.table_grid(page, box)
    band_clip = m.band_rect(page, box)
    if len(grid["cols"]) < 7:
        raise BuildError(f"box H: derived {len(grid['cols'])} columns, need 7")
    for lane in spec["lanes"]:
        lab = pg.find_run(lane["anchor"])
        if lab is None:
            raise BuildError(f"box H: printed lane {lane['anchor']!r} not found")
        row = next((r for r in grid["rows"] if r["bottom"] - 2 <= lab.baseline <= r["top"] + 2), None)
        if row is None:
            raise BuildError(f"box H: lane {lane['anchor']!r} has no derived row band")
        for stage, cell in enumerate(lane["cells"]):
            col = grid["cols"][stage + 1]
            sh.flow(cell, Rect(col["text_x"], row["bottom"] + 0.6, col["x1"] - 1.2, row["top"] - 0.6),
                    page=page, box=box, clip=band_clip, role="cell", anchor=lab.baseline,
                    size_max=6.5, size_min=6.0, name=f"H/{lane['anchor'][:14]} stage{stage + 1}")


# ------------------------------------------------------------- diagrams
def zone_areas(m: G.Model, spec: dict) -> list[tuple[dict, Rect]]:
    """Every printed zone label in box L selects the rule band it is drawn in.

    The gutter labels sit at x~65.5; two of them wrap, so the anchor is matched on the
    label's first word and only against runs inside the left gutter.
    """
    page = spec["page"]
    pg = m.page(page)
    band = m.box(page, "L")
    lines = pg.hrule_lines(band["band_bottom"], band["band_top"], 61.27, 549.98)
    out = []
    for z in spec["zones"]:
        first = z["anchor"].split()[0].lower()
        cands = [r for r in pg.runs
                 if r.text.lower().startswith(first) and r.x0 < 145.0
                 and band["band_bottom"] < r.baseline < band["band_top"]]
        if not cands:
            raise BuildError(f"box L: printed zone label {z['anchor']!r} not found")
        lab = max(cands, key=lambda r: r.baseline)
        above = [y for y in lines if y >= lab.top]
        below = [y for y in lines if y <= lab.bottom]
        if not above or not below:
            raise BuildError(f"box L: zone {z['anchor']!r} is not bounded by rules")
        out.append((z, Rect(144.55 + G.FRAME_INSET, max(below) + G.FRAME_INSET,
                            549.98 - G.FRAME_INSET, min(above) - G.FRAME_INSET)))
    out.sort(key=lambda t: -t[1].y1)
    return out


def lay_out_pills(sh: Sheet, m: G.Model, spec: dict, zones) -> dict:
    rects = {}
    page = spec["page"]
    for z, area in zones:
        rows = z["rows"]
        corridor = float(z.get("corridor", 0.0))
        top_gap = float(z.get("top_gap", 0.0))
        usable = (area.y1 - top_gap) - (area.y0 + corridor)
        gap = 8.0
        row_h = (usable - gap * (len(rows) - 1)) / len(rows)
        if row_h < 18:
            raise BuildError(f"box L zone {z['id']}: only {row_h:.1f}pt per component row")
        for ri, row in enumerate(rows):
            y_top = area.y1 - top_gap - ri * (row_h + gap)
            col_gap = 26.0 if len(row) > 1 else 0.0
            w = (area.w - col_gap * (len(row) - 1)) / len(row)
            for pi, pill in enumerate(row):
                x0 = area.x0 + pi * (w + col_gap)
                rect = Rect(x0, y_top - row_h, x0 + w, y_top)
                sh.pill(page, "L", rect, rect)
                inner = Rect(rect.x0 + 3.0, rect.y0 + 1.5, rect.x1 - 3.0, rect.y1 - 2.0)
                lines_spec = [(f"{pill.get('n', '')}. {pill['label']}".strip(". "), sh.bold, 6.6)]
                subs = pill.get("sub")
                if subs:
                    lines_spec += [(s, sh.font, 6.2) for s in (subs if isinstance(subs, list) else [subs])]
                for txt, fnt, smax in lines_spec:
                    size, bottom = sh.flow(txt, inner, page=page, box="L", clip=rect,
                                           role="node", font=fnt, size_max=smax, size_min=6.0,
                                           name=f"L/{z['id']}/{pill['id']}")
                    inner = Rect(inner.x0, inner.y0, inner.x1, bottom - 1.5)
                    if inner.h < 5:
                        break
                rects[pill["id"]] = rect
    return rects


def draw_flows(sh: Sheet, m: G.Model, spec: dict, rects: dict, zones):
    """Labelled vertical arrows through a zone's reserved corridor.

    Each arrow's shaft sits at its source component's x (clamped into its corridor
    slot), so the stroke never jogs across another slot and never touches a pill:
    down arrows leave the source's bottom edge, up arrows leave the source's top edge.
    """
    page = spec["page"]
    by_id = {z["id"]: area for z, area in zones}
    band = m.band_rect(page, "L")
    slots = {}
    for a in spec["arrows"]:
        slots.setdefault(a["zone"], []).append(a)
    drawn = []
    for zone_id, arrows in slots.items():
        if zone_id not in by_id:
            raise BuildError(f"box L: arrow zone {zone_id!r} is not a measured zone")
        area = by_id[zone_id]
        corridor = float(next(z.get("corridor", 0.0) for z, _ in zones if z["id"] == zone_id))
        if corridor < 16:
            raise BuildError(f"box L: zone {zone_id} corridor is {corridor}pt, arrows need 16pt")
        cw = area.w / len(arrows)
        for i, a in enumerate(arrows):
            src = rects.get(a["from"])
            dst = rects.get(a["to"])
            if src is None or dst is None:
                raise BuildError(f"box L: arrow {a['from']}->{a['to']} names no component")
            down = dst.y1 < src.y1
            slot = Rect(area.x0 + i * cw, area.y0, area.x0 + (i + 1) * cw, area.y0 + corridor)
            x = min(max(src.cx, slot.x0 + 6.0), slot.x1 - 6.0)
            rule_y = area.y0 - G.FRAME_INSET
            # 1.9pt stand-off so the stroke never touches the component box it leaves;
            # if another component sits in the way, the stroke lives in the corridor
            # alone and its label carries both endpoint names.
            if down:
                y_from, y_to = src.y0 - 1.9, rule_y - 5.5
                path = Rect(x - 2.5, y_to, x + 2.5, src.y0)
            else:
                y_from, y_to = src.y1 + 1.9, rule_y + 5.5
                path = Rect(x - 2.5, src.y1, x + 2.5, y_to)
            if any(r.intersects(path, 1.0) for _oid, r in rects.items() if r is not src):
                y_from = (area.y0 + corridor - 1.5) if down else (rule_y - 5.5)
            sh.polyline(page, "L", [(x, y_from), (x, y_to)], clip=band,
                        arrow="down" if down else "up", width=0.85)
            label_x0 = x + 5.0 if x + 60.0 < slot.x1 - 2.0 else slot.x0 + 2.0
            label_x1 = slot.x1 - 2.5 if label_x0 == x + 5.0 else x - 5.0
            if label_x1 - label_x0 < 55:
                raise BuildError(f"box L: no label room in corridor slot {i} of zone {zone_id}")
            txt = a["label"] + ("  (PD)" if a.get("pii") else "")
            sh.flow(txt, Rect(label_x0, slot.y0 + 1.0, max(label_x0 + 55, label_x1), slot.y1 - 1.0),
                    page=page, box="L", clip=slot, role="flowlabel", size_max=6.6, size_min=6.0,
                    name=f"L/flow {a['from']}->{a['to']}")
            if a.get("pii"):
                # the filled dot marks the boundary the data crosses, sitting on the
                # rule beside its arrow rather than on top of the stroke
                sh.dot(page, "L", x - 6.5, rule_y, band)
            drawn.append(a)
    return drawn


def fill_zone_diagram(sh: Sheet, m: G.Model, spec: dict):
    zones = zone_areas(m, spec)
    rects = lay_out_pills(sh, m, spec, zones)
    draw_flows(sh, m, spec, rects, zones)


def fill_continuation(sh: Sheet, m: G.Model, spec: dict):
    """Page 5, the box L continuation: human approval gate + dependency failures."""
    page = 5
    outer = m.landing_band(page)
    pg = m.page(page)
    writable = Rect(61.67, 40.0, 549.08, min(pg.seps) - 2.0)
    sh.flow(spec["heading"], Rect(writable.x0, writable.y1 - 26.0, writable.x1, writable.y1),
            page=page, box="L", clip=outer, role="h1", font=sh.bold, size_max=8.2,
            size_min=7.0, name="L5/heading")
    y = writable.y1 - 34.0
    gate = spec["gate"]
    n = len(gate)
    gap = 26.0
    w = (writable.w - gap * (n - 1)) / n
    h = 34.0
    pills = []
    for i, g in enumerate(gate):
        rect = Rect(writable.x0 + i * (w + gap), y - h, writable.x0 + i * (w + gap) + w, y)
        sh.pill(page, "L", rect, rect)
        inner = Rect(rect.x0 + 2.5, rect.y0 + 2.0, rect.x1 - 2.5, rect.y1 - 2.0)
        _size, bottom = sh.flow(f"{i + 1}. {g['label']}", inner, page=page, box="L", clip=rect,
                                role="node", font=sh.bold, size_max=6.6, size_min=6.0,
                                name=f"L5/gate{i + 1}")
        if g.get("sub"):
            sh.flow(g["sub"], Rect(inner.x0, inner.y0, inner.x1, bottom - 1.5),
                    page=page, box="L", clip=rect, role="node", size_max=6.4, size_min=6.0,
                    name=f"L5/gate{i + 1} sub")
        pills.append(rect)
    for i in range(n - 1):
        a, b = pills[i], pills[i + 1]
        midy = a.cy
        sh.polyline(page, "L", [(a.x1 + 2.6, midy), (b.x0 - 5.2, midy)], clip=outer,
                    arrow="right", width=0.8)
    y -= h + 26.0
    sh.flow(spec["failures_heading"], Rect(writable.x0, y - 12.0, writable.x1, y),
            page=page, box="L", clip=outer, role="h2", font=sh.bold, size_max=7.5,
            size_min=6.5, name="L5/failures heading")
    y -= 16.0
    rh = 34.0
    for i, f in enumerate(spec["failures"]):
        top = y - i * (rh + 6.0)
        left = Rect(writable.x0, top - rh, 190.0, top)
        sh.pill(page, "L", left, left)
        sh.flow(f["label"], Rect(left.x0 + 2.5, left.y0 + 2.0, left.x1 - 2.5, left.y1 - 2.0),
                page=page, box="L", clip=left, role="node", font=sh.bold, size_max=6.6,
                size_min=6.0, name=f"L5/fail{i + 1}")
        sh.polyline(page, "L", [(left.x1 + 2.0, top - rh / 2), (left.x1 + 9.0, top - rh / 2)],
                    clip=outer, arrow="right", width=0.8)
        sh.flow(f["value"], Rect(left.x1 + 13.0, top - rh, writable.x1, top - 1.0),
                page=page, box="L", clip=outer, role="cell", size_max=6.8, size_min=6.0,
                name=f"L5/fail{i + 1} detail")


def fill_links(sh: Sheet, m: G.Model, box: str, spec: dict):
    """Box Q: its band holds no free line, so the links ride the printed prompt's
    own last baseline, immediately right of where that line ends."""
    page = spec["page"]
    pg = m.page(page)
    band = m.box(page, box)
    lab = pg.find_run(spec["after"])
    if lab is None:
        raise BuildError(f"box {box}: printed anchor {spec['after']!r} not found")
    area = Rect(lab.x1 + 4.0, band["band_bottom"] + G.BAND_PAD,
                549.98 - G.FRAME_INSET, lab.top)
    x = area.x0
    for link in spec["links"]:
        size, _bottom = sh.flow(link, area, page=page, box=box, clip=m.band_rect(page, box),
                       role="answer", anchor=lab.baseline, x_start=x, size_max=6.8,
                       size_min=6.0, name=f"box {box} link")
        x += G.string_width(link, sh.font, size) + 10.0


# ------------------------------------------------------------------ build
def build(model: G.Model, content: dict) -> Sheet:
    sh = Sheet(model, content["meta"])
    fill_fields(sh, model, {**content["A"], "page": 1})
    for letter, page in (("B", 1), ("C", 1), ("E", 1), ("G", 2), ("O", 6)):
        fill_prose(sh, model, letter, {**content[letter], "page": page})
    for letter, page in (("D", 1), ("F", 2), ("K", 3), ("M", 6), ("N", 6), ("P", 6)):
        fill_table(sh, model, letter, {**content[letter], "page": page})
    fill_table(sh, model, "I", {"page": 3, "columns": content["I"]["columns"],
                                "rows": content["I"]["rows"]})
    # J: vector ticks, then the "why these two" block riding the printed label's line
    j = content["J"]
    fill_ticks(sh, model, "J", {"where": "box J", "items": [{"page": 3, "label": t} for t in j["ticks"]]})
    pg = model.page(3)
    lab = pg.find_run(j["why_label"])
    if lab is None:
        raise BuildError("box J: printed 'Why these two:' label not found")
    band = model.box(3, "J")
    # the whole "why" strip is one printed line tall: the text rides the label's own
    # baseline, immediately right of "Why these two:"
    sh.flow(j["why"], Rect(lab.x1 + 3.0, band["band_bottom"] + G.BAND_PAD,
                           549.98 - G.FRAME_INSET, lab.top),
            page=3, box="J", clip=model.band_rect(3, "J"), role="prose", anchor=lab.baseline,
            name="box J why")
    fill_lane_grid(sh, model, "H", {**content["H"], "page": 2})
    ck = content["CHECKLISTS"]
    fill_ticks(sh, model, "H", {"where": "box H checklist",
                                "items": [{"page": 2, "label": t} for t in ck["page2"]]})
    fill_ticks(sh, model, "L", {"where": "box L checklist",
                                "items": [{"page": 4, "label": t} for t in ck["page4"]]})
    fill_continuation(sh, model, {**content["PAGE5"], "page": 5})
    fill_ticks(sh, model, "L", {"where": "page 5 checklist", "box": "L",
                                "items": [{"page": 5, "label": t} for t in content["PAGE5"]["ticks"]]})
    fill_zone_diagram(sh, model, {**content["L"], "page": 4})
    fill_links(sh, model, "Q", {**content["Q"], "page": 6})
    return sh


# ----------------------------------------------------------------- writer
def render(c: rl_canvas.Canvas, it: dict):
    st = it.get("style") or {}
    if it["kind"] == "text":
        c.setFillColorRGB(*INK)
        c.setFont(it["font"], it["size"])
        c.drawString(it["bbox"][0], it["baseline"], it["text"])
        return
    colour = tuple(st.get("color") or INK)
    if it["kind"] == "dot":
        c.setFillColorRGB(*INK)
        c.circle(st["x"], st["y"], st["r"], stroke=0, fill=1)
        return
    if it["kind"] == "tick":
        pts = st["path"]
        c.setStrokeColorRGB(*INK)
        c.setLineWidth(st["width"])
        c.setLineCap(1)
        c.setLineJoin(1)
        p = c.beginPath()
        p.moveTo(*pts[0])
        for q in pts[1:]:
            p.lineTo(*q)
        c.drawPath(p, stroke=1, fill=0)
        return
    c.setStrokeColorRGB(*colour)
    c.setLineWidth(st.get("width", 0.8))
    if it["kind"] == "rect":
        x0, y0, x1, y1 = it["bbox"]
        c.roundRect(x0, y0, x1 - x0, y1 - y0, st["radius"], stroke=1, fill=0)
        return
    pts = st["pts"]
    p = c.beginPath()
    p.moveTo(*pts[0])
    for q in pts[1:]:
        p.lineTo(*q)
    c.drawPath(p, stroke=1, fill=0)
    head = st.get("arrow")
    if head:
        x, y = pts[-1]
        tri = {"down": [(x - 2.2, y + 3.2), (x + 2.2, y + 3.2)],
               "up": [(x - 2.2, y - 3.2), (x + 2.2, y - 3.2)],
               "right": [(x - 3.2, y - 2.2), (x - 3.2, y + 2.2)],
               "left": [(x + 3.2, y - 2.2), (x + 3.2, y + 2.2)]}[head]
        hp = c.beginPath()
        hp.moveTo(x, y)
        for q in tri:
            hp.lineTo(*q)
        hp.close()
        c.setFillColorRGB(*colour)
        c.drawPath(hp, stroke=0, fill=1)


def emit_pdf(model: G.Model, sh: Sheet, out: Path, template: Path):
    tmp = out.with_name("_overlay.pdf")
    c = rl_canvas.Canvas(str(tmp), pagesize=(612, 792))
    for pno in sorted(model.pages):
        for it in sh.items:
            if it["page"] == pno:
                render(c, it)
        c.showPage()
    c.save()
    writer = PdfWriter()
    writer.append(PdfReader(str(template)))
    over = PdfReader(str(tmp))
    for i, page in enumerate(writer.pages):
        if i < len(over.pages):
            page.merge_page(over.pages[i])
    writer.add_metadata({"/Title": "SecureVoice AI - ElevenLabs Idea Canvas, Stage 1",
                         "/Author": "Aaron Otema (SecureVoice AI)",
                         "/Subject": "Track 1 / Use Case 1 - Real-Time Fraud Intervention",
                         "/Creator": "docs/canvas-build/render-canvas.py"})
    with open(out, "wb") as fh:
        writer.write(fh)
    tmp.unlink(missing_ok=True)


def main() -> int:
    content = json.loads(Path(CONTENT).read_text(encoding="utf-8"))
    model = G.Model()
    template = Path(model.template)
    if not template.exists():
        template = TEMPLATE_FALLBACK
    if not template.exists():
        print(f"BUILD FAILED: template not found ({model.template})", file=sys.stderr)
        return 2
    try:
        sh = build(model, content)
    except (BuildError, GeometryError) as exc:
        Path(DRAWS).write_text(json.dumps({"error": str(exc)}, indent=1), encoding="utf-8")
        print(f"BUILD FAILED: {exc}", file=sys.stderr)
        return 3
    if sh.errors:
        Path(DRAWS).write_text(json.dumps({"errors": sh.errors}, indent=1), encoding="utf-8")
        print(f"BUILD FAILED: {len(sh.errors)} block(s) do not fit the template's own boxes:",
              file=sys.stderr)
        for e in sh.errors:
            print("  - " + e, file=sys.stderr)
        return 3
    emit_pdf(model, sh, OUT, template)
    Path(DRAWS).write_text(json.dumps({"template": str(template), "output": str(OUT),
                                       "items": sh.items}, indent=1), encoding="utf-8")
    per_page: dict[int, int] = {}
    sizes = []
    for it in sh.items:
        per_page[it["page"]] = per_page.get(it["page"], 0) + 1
        if it["kind"] == "text":
            sizes.append(it["size"])
    print(f"drew {len(sh.items)} items; text sizes {min(sizes):.2f}-{max(sizes):.2f}pt")
    print("per page:", " ".join(f"p{k}={v}" for k, v in sorted(per_page.items())))
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
