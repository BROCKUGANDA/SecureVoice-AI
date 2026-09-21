"""Hard gate for the Idea Canvas submission.  Exits non-zero on ANY violation.

    python verify-canvas.py [--verbose]

It re-derives the template's geometry from geometry.json (it does not trust the
renderer's arithmetic beyond the bboxes it is handed), recomputes every printed glyph
envelope, and then proves:

  1. no drawn ink intersects a printed run of the template  (ticks excepted, and only
     when the tick is proven to sit INSIDE the square it ticks)
  2. no drawn ink intersects other drawn ink
  3. no text ink crosses one of the template's own rule lines
  4. every drawn item lies inside the band of the box it claims, and inside its
     declared clip rectangle
  5. no box's word limit from the printed header is exceeded
  6. every required field is filled, and nothing is drawn under 6pt
  7. Box M's baselines are exactly Box D's
  8. every component ticked in Box J appears in the Box L diagram
  9. the template's own text survived the merge (nothing was erased or whited out)

Overlap is tested on INK, not on bounding boxes: a text run's ink is its conservative
glyph envelope, a stroke's ink is one thin rect per segment plus its arrowhead, and a
component box's ink is its four border strips.  Using bboxes alone would report every
label inside a component box as an overlap.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import canvas_geom as G                                    # noqa: E402
from canvas_geom import ASC, DESC, Rect, GeometryError     # noqa: E402

DRAWS = Path(__file__).with_name("draw-list.json")
CONTENT = Path(__file__).with_name("content.json")
GEOM = Path(__file__).with_name("geometry.json")
SLACK = 0.06
RULE_CLEAR = 0.35
LIMIT_RE = re.compile(r"(\d+) words? (max|per step|per row)", re.I)


class Report:
    def __init__(self):
        self.failures: list[str] = []
        self.checks: dict[str, list[str]] = {}

    def note(self, check, msg):
        self.checks.setdefault(check, []).append(msg)

    def fail(self, check, msg):
        self.failures.append(f"[{check}] {msg}")
        self.note(check, msg)


# ------------------------------------------------------------------- ink model
def ink_rects(it: dict) -> list[Rect]:
    kind = it["kind"]
    if kind in ("text", "dot"):
        return [Rect(*it["bbox"])]
    st = it.get("style") or {}
    if kind == "rect":
        x0, y0, x1, y1 = it["bbox"]
        t = float(st.get("width", 0.7)) / 2 + 0.05
        return [Rect(x0 - t, y0 - t, x1 + t, y0 + t), Rect(x0 - t, y1 - t, x1 + t, y1 + t),
                Rect(x0 - t, y0 - t, x0 + t, y1 + t), Rect(x1 - t, y0 - t, x1 + t, y1 + t)]
    if kind in ("polyline", "tick"):
        pts = st.get("pts") or st.get("path") or []
        t = float(st.get("width", 0.8)) / 2 + 0.05
        out = []
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            out.append(Rect(min(ax, bx) - t, min(ay, by) - t, max(ax, bx) + t, max(ay, by) + t))
        head = st.get("arrow")
        if head and pts:
            hx, hy = pts[-1]
            out.append(Rect(hx - 2.6, hy - 3.4, hx + 2.6, hy + 3.4))
        return out
    return [Rect(*it["bbox"])]


def locate_run(model: G.Model, ref: dict):
    """Find the printed square a tick claims to sit inside."""
    pg = model.page(ref["page"])
    for r in pg.runs:
        if abs(r.baseline - ref["baseline"]) < 0.05 and abs(r.x0 - ref["x0"]) < 0.05 \
           and abs(r.x1 - ref["x1"]) < 0.05:
            return r
    return None


# --------------------------------------------------------------------- checks
def check_ink_consistency(rep: Report, items: list[dict]):
    """The bbox a run recorded must cover the ink it recorded, or one of the two is a lie.

    Strokes are drawn half their width outside the path, so that much halo is allowed.
    """
    for it in items:
        st = it.get("style") or {}
        halo = float(st.get("width", 0.0)) / 2 + (3.4 if st.get("arrow") else 0.1)
        box = Rect(*it["bbox"])
        for r in ink_rects(it):
            if not box.contains(r, halo):
                rep.fail("ink-consistency",
                         f"p{it['page']} {it['kind']} {(it.get('text') or it.get('role'))!r} "
                         f"ink {r.to_list()} is outside its own bbox {box.to_list()}")
    rep.note("ink-consistency", f"{len(items)} items: recorded bbox vs recorded stroke path")


def check_overlap_with_printed(rep: Report, model: G.Model, items: list[dict]):
    n = 0
    for it in items:
        pg = model.page(it["page"])
        ink = ink_rects(it)
        if it["kind"] == "tick":
            run = locate_run(model, it["inside_run"]) if it.get("inside_run") else None
            if run is None:
                rep.fail("ticks", f"p{it['page']} tick does not name a printed square")
                continue
            box = Rect(run.x0, run.bottom, run.x1, run.top)
            for r in ink:
                if not box.contains(r, 0.5):
                    rep.fail("ticks", f"p{it['page']} tick ink {r.to_list()} is not inside "
                                      f"its printed square {box.to_list()}")
            n += 1
            continue
        for r in ink:
            for pr in pg.runs:
                if r.intersects(pr.rect, SLACK):
                    rep.fail("overlap-printed",
                             f"p{it['page']} {it['kind']} {it.get('text') or it.get('role')!r} "
                             f"bbox {r.to_list()} intersects printed {pr.text!r} "
                             f"{pr.rect.to_list()}")
    rep.note("overlap-printed", f"{len(items)} drawn items vs printed runs "
                                f"({n} ticks placed inside their own squares)")


def check_overlap_between_drawn(rep: Report, items: list[dict]):
    by_page: dict[int, list[dict]] = {}
    for it in items:
        by_page.setdefault(it["page"], []).append(it)
    pairs = 0
    for page, group in sorted(by_page.items()):
        flat = []
        for it in group:
            for r in ink_rects(it):
                flat.append((it, r))
        for i in range(len(flat)):
            for j in range(i + 1, len(flat)):
                ai, ri = flat[i]
                aj, rj = flat[j]
                if ai is aj:
                    continue
                pairs += 1
                if ri.intersects(rj, SLACK):
                    rep.fail("overlap-drawn",
                             f"p{page} {ai['kind']}/{ai.get('text') or ai.get('role')!r} ink "
                             f"{ri.to_list()} overlaps {aj['kind']}/"
                             f"{aj.get('text') or aj.get('role')!r} ink {rj.to_list()}")
    rep.note("overlap-drawn", f"{pairs} ink-rect pairs tested per page")


def check_text_vs_rules(rep: Report, model: G.Model, items: list[dict]):
    hits = 0
    for it in items:
        if it["kind"] != "text":
            continue
        pg = model.page(it["page"])
        r = Rect(*it["bbox"])
        for rule in pg.hrules:
            band = Rect(rule.a, rule.at - 0.45, rule.b, rule.at + 0.45)
            if r.intersects(band, RULE_CLEAR):
                rep.fail("text-on-rule", f"p{it['page']} text {it['text']!r} {r.to_list()} "
                                         f"crosses the template's rule at y={rule.at}")
                break
        for rule in pg.vrules:
            band = Rect(rule.at - 0.45, rule.a, rule.at + 0.45, rule.b)
            if r.intersects(band, RULE_CLEAR):
                rep.fail("text-on-rule", f"p{it['page']} text {it['text']!r} {r.to_list()} "
                                         f"crosses the template's rule at x={rule.at}")
                break
        hits += 1
    rep.note("text-on-rule", f"{hits} text lines tested against every rule segment")


def check_bands(rep: Report, model: G.Model, items: list[dict]):
    for it in items:
        try:
            band = model.band_rect(it["page"], it["box"])
        except GeometryError as exc:
            rep.fail("bands", f"p{it['page']} item claims unknown box {it['box']}: {exc}")
            continue
        r = Rect(*it["bbox"])
        if not band.contains(r, SLACK):
            rep.fail("bands", f"p{it['page']} box {it['box']} {it['kind']} "
                              f"{(it.get('text') or it.get('role'))!r} bbox {r.to_list()} "
                              f"leaves its band {band.to_list()}")
        if it.get("clip"):
            clip = Rect(*it["clip"])
            if not band.contains(clip, 0.6):
                rep.fail("bands", f"p{it['page']} box {it['box']} clip {clip.to_list()} "
                                  f"is itself outside the band {band.to_list()}")
            if not clip.contains(r, SLACK):
                rep.fail("bands", f"p{it['page']} box {it['box']} {it['kind']} "
                                  f"{(it.get('text') or it.get('role'))!r} "
                                  f"{r.to_list()} outside its assigned cell {clip.to_list()}")
    rep.note("bands", f"{len(items)} items checked against band + cell clip")


def check_limits(rep: Report, model: G.Model, content: dict):
    limits = {}
    for pg_no, pg in model.pages.items():
        for b in pg.boxes.values():
            for lim in b["limits"]:
                limits[b["letter"]] = lim
    def wordcount(s):
        return G.word_count(s)

    per_box_words = {
        "B": [content["B"]["text"]],
        "C": [content["C"]["text"]],
        "E": [content["E"]["text"]],
        "G": [content["G"]["text"]],
        "O": [content["O"]["text"]],
        "J": [content["J"]["why"]],
    }
    per_row = {
        "I": [[r[0]] for r in content["I"]["rows"]],
        "K": [r for r in content["K"]["rows"]],
        "N": [r for r in content["N"]["rows"]],
    }
    for box, texts in per_box_words.items():
        lim = LIMIT_RE.search(limits.get(box, ""))
        cap = int(lim.group(1)) if lim else None
        total = sum(wordcount(t) for t in texts)
        if cap and total > cap:
            rep.fail("word-limits", f"box {box}: {total} words > printed '{cap} words max'")
        rep.note("word-limits", f"box {box}: {total} / {cap or '-'} words")
    for box, rows in per_row.items():
        lim = LIMIT_RE.search(limits.get(box, ""))
        cap = int(lim.group(1)) if lim else None
        for i, vals in enumerate(rows):
            used = sum(wordcount(v) for v in vals)
            if cap and used > cap:
                rep.fail("word-limits", f"box {box} row {i + 1}: {used} words > "
                                        f"printed '{cap} words per row'")
        rep.note("word-limits", f"box {box}: {len(rows)} rows, max "
                                f"{max(sum(wordcount(v) for v in r) for r in rows)} words/row "
                                f"(limit {cap})")
    if limits.get("M", "").startswith("max"):
        cap = int(re.search(r"(\d+)", limits["M"]).group(1))
        if len(content["M"]["rows"]) > cap:
            rep.fail("word-limits", f"box M: {len(content['M']['rows'])} KPIs > printed max {cap}")
        else:
            rep.note("word-limits", f"box M: {len(content['M']['rows'])} KPIs (max {cap})")
    if "two links" in limits.get("Q", "").lower():
        if len(content["Q"]["links"]) != 2:
            rep.fail("word-limits", f"box Q: {len(content['Q']['links'])} links, template "
                                    f"prints 'Two links'")
        else:
            rep.note("word-limits", "box Q: exactly 2 links")
    if "numbers only" in limits.get("D", "").lower():
        for i, row in enumerate(content["D"]["rows"]):
            val = row[1]
            if not re.search(r"\d", val) or re.search(r"[a-z]{4,}", val):
                rep.fail("word-limits", f"box D row {i + 1}: {val!r} is not a number "
                                        f"(template prints 'Numbers only')")
        rep.note("word-limits", f"box D: {len(content['D']['rows'])} numeric baselines")


def check_required(rep: Report, model: G.Model, content: dict, items: list[dict]):
    drawn = {}
    for it in items:
        drawn.setdefault((it["page"], it["box"]), 0)
        drawn[(it["page"], it["box"])] += 1
    for pg_no, pg in model.pages.items():
        for letter in pg.boxes:
            if not drawn.get((pg_no, letter)):
                rep.fail("required", f"box {letter} (p{pg_no}) is empty")
    if not drawn.get((5, "L")):
        rep.fail("required", "page 5 (box L continuation) is empty - the dependency "
                             "failure answers belong there")
    fields = content["A"]["fields"]
    if len(fields) != 10:
        rep.fail("required", f"box A: {len(fields)} answers; the template prints 5 rows x "
                             f"2 answer columns and says 'Complete every field'")
    for f in fields:
        if not str(f["text"]).strip():
            rep.fail("required", f"box A field {f['label']!r} is empty")
    rows_needed = {"D": 3, "F": 3, "I": 5, "K": 6, "M": 3, "N": 3, "H": 5}
    for box, want in rows_needed.items():
        got = len(content[box]["rows"]) if box != "H" else len(content["H"]["lanes"])
        if got != want:
            rep.fail("required", f"box {box}: {got} rows of content, template prints {want}")
    for lane in content["H"]["lanes"]:
        empties = [i for i, c in enumerate(lane["cells"], 1) if not str(c).strip()]
        if empties:
            rep.fail("required", f"box H lane {lane['anchor']!r}: empty stage cells {empties}")
    if len(content["J"]["ticks"]) < 2:
        rep.fail("required", "box J: fewer than two components ticked")
    for page, want in ((2, 6), (4, 4), (5, 2)):
        got = len([i for i in items if i["page"] == page and i["kind"] == "tick"])
        if got != want:
            rep.fail("required", f"page {page}: {got} ticks drawn, {want} checklist items "
                                 f"must be shown")
    sizes = [i["size"] for i in items if i["kind"] == "text"]
    if min(sizes) < 6.0 - 1e-6:
        rep.fail("required", f"text drawn at {min(sizes)}pt; the floor is 6pt")
    rep.note("required", f"boxes filled: {len(drawn)}; smallest text {min(sizes):.2f}pt; "
                         f"{len([i for i in items if i['kind'] == 'tick'])} ticks")


def check_baselines(rep: Report, content: dict):
    d = [r[1] for r in content["D"]["rows"]]
    m = [r[1] for r in content["M"]["rows"]]
    if d != m:
        rep.fail("baselines", f"box D baselines {d} != box M baselines {m} - the template "
                              f"prints 'these exact numbers must reappear in box M'")
    else:
        rep.note("baselines", f"D == M == {d}")


def check_ticks_vs_architecture(rep: Report, model: G.Model, content: dict, items: list[dict]):
    ticks = [t.lower() for t in content["J"]["ticks"]]
    labels = []
    for it in items:
        if it["page"] in (4, 5) and it["kind"] == "text" and it["role"] == "node":
            labels.append((it["text"] or "").lower())
    blob = " ".join(labels)
    keys = {"scribe v2 stt": ["scribe"], "eleven v3 tts": ["tts"], "agents platform": ["agent"],
            "server / client tools": ["tool"], "telephony (twilio / sip)": ["twilio"],
            "web / mobile sdks": ["sdk"]}
    for t in ticks:
        needle = keys.get(t, [t.split()[0]])
        if not any(n in blob for n in needle):
            rep.fail("j-vs-l", f"box J ticks {t!r} but the box L diagram never names it "
                               f"(looked for {needle})")
    if not ticks:
        rep.fail("j-vs-l", "box J has no ticks to cross-check")
    rep.note("j-vs-l", f"{len(ticks)} J ticks cross-checked against {len(labels)} "
                       f"diagram labels on pages 4-5")


def check_template_intact(rep: Report, model: G.Model, out_path: Path):
    import pypdf
    template = Path(model.template)
    if not template.exists():
        rep.fail("template", f"template missing: {template}")
        return
    src = pypdf.PdfReader(str(template))
    dst = pypdf.PdfReader(str(out_path))
    if len(dst.pages) != len(src.pages):
        rep.fail("template", f"submission has {len(dst.pages)} pages, template has {len(src.pages)}")
        return
    root = dst.trailer["/Root"].get_object()
    if root.get("/AcroForm") is not None:
        rep.fail("template", "submission grew an AcroForm - the template has none")
    lost = 0
    for i, (a, b) in enumerate(zip(src.pages, dst.pages), 1):
        if (round(float(a.mediabox.width), 1), round(float(a.mediabox.height), 1)) != \
           (round(float(b.mediabox.width), 1), round(float(b.mediabox.height), 1)):
            rep.fail("template", f"page {i} size changed")
        norm = lambda t: re.sub(r"\s+", " ", t or "").lower()
        have = norm(b.extract_text())
        for run in model.page(i).runs:
            want = norm(run.raw)
            if len(want) > 2 and want not in have:
                lost += 1
                rep.fail("template", f"page {i}: printed text {run.raw!r} no longer "
                                     f"present - something erased the form")
    rep.note("template", f"6 pages, {sum(len(model.page(i).runs) for i in model.pages)} "
                         f"printed runs all still present ({lost} lost)")


# ---------------------------------------------------------------------- main
def main() -> int:
    argv = sys.argv[1:]
    def opt(name, default):
        return Path(argv[argv.index(name) + 1]) if name in argv else default
    verbose = "--verbose" in argv
    draws = opt("--draws", DRAWS)
    content_path = opt("--content", CONTENT)
    out_override = opt("--out", None)
    payload = json.loads(Path(draws).read_text(encoding="utf-8"))
    if "errors" in payload or "error" in payload:
        print("VERIFY FAILED: render-canvas.py did not produce a draw list - it reported:")
        for e in payload.get("errors", [payload.get("error", "")]):
            print("  - " + str(e))
        return 1
    model = G.Model()
    content = json.loads(Path(content_path).read_text(encoding="utf-8"))
    items = payload["items"]
    out = out_override or Path(payload["output"])
    if not out.exists():
        print(f"VERIFY FAILED: {out} does not exist")
        return 1

    rep = Report()
    check_ink_consistency(rep, items)
    check_overlap_with_printed(rep, model, items)
    check_overlap_between_drawn(rep, items)
    check_text_vs_rules(rep, model, items)
    check_bands(rep, model, items)
    check_limits(rep, model, content)
    check_required(rep, model, content, items)
    check_baselines(rep, content)
    check_ticks_vs_architecture(rep, model, content, items)
    check_template_intact(rep, model, out)

    order = ["ink-consistency", "ticks", "overlap-printed", "overlap-drawn", "text-on-rule", "bands", "word-limits",
             "required", "baselines", "j-vs-l", "template"]
    width = max(len(c) for c in order) + 2
    print("verify-canvas.py  " + str(out.name))
    print("-" * (width + 58))
    fails = 0
    for check in order:
        bad = [f for f in rep.failures if f.startswith(f"[{check}]")]
        fails += len(bad)
        print(f"{check:<{width}}  {'FAIL' if bad else 'PASS':<5} "
              f"{len(bad) and f'{len(bad)} violation(s)' or ''} "
              f"{'; '.join(rep.checks.get(check, []))[:52]}")
    print("-" * (width + 58))
    if rep.failures:
        print(f"{len(rep.failures)} violation(s):")
        for f in rep.failures[:40]:
            print("  - " + f)
        if len(rep.failures) > 40:
            print(f"  ... and {len(rep.failures) - 40} more")
        print("RESULT: FAIL")
        return 1
    print(f"RESULT: PASS - {len(items)} drawn items, 0 overlaps, 0 overflows, "
          f"0 limit breaches")
    if verbose:
        for check in order:
            for note in rep.checks.get(check, []):
                print(f"  {check}: {note}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
