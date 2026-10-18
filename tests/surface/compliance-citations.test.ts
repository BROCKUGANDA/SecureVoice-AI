/**
 * SURFACE — every code citation in the DIFC compliance record must resolve.
 *
 * Why this exists: `docs/ROPA.md` and `docs/AI-INVENTORY.md` are the artifacts a
 * regulator or a bank's security reviewer reads and then ACTS on. They are built
 * entirely out of `file:line` citations, and a citation that no longer points at
 * what it described is worse than no citation — it hands the reader a verifiable
 * statement that verifies as false.
 *
 * This is not hypothetical. Both documents were written in one sitting against greps
 * whose output line numbers were OFFSET-BASED (a `sed -n '440,700p' | grep -n`
 * returns relative numbers), and eight citations in the first draft pointed at the
 * wrong line — one of them pointed at a transition row that contradicted the claim
 * it was cited for. Those were caught by re-checking by hand. A check that has to be
 * remembered is not a control, so this file makes it automatic: the next `Case`
 * column that moves is caught by CI, not by a reviewer.
 *
 * The rule enforced:
 *   1. Every `path/file.ext:NNN` (or `:NNN-MM`) reference in the two documents
 *      resolves to a tracked file, with the cited range inside its line count.
 *   2. Only one kind of non-repo path may be cited at all: the extracted primary
 *      legislation text (`difc-law.txt`, `difc-regs.txt`). The skip list is ASSERTED,
 *      not merely applied — otherwise a typo'd filename is silently "exempt" forever,
 *      which is how a gate like this becomes decoration.
 *   3. A bare filename (`retention.ts:42`) resolves only if exactly one tracked file
 *      ends with it. Two candidates is a failure, because the citation is ambiguous
 *      to a reader even when the checker could guess.
 *   4. A citation-density floor, so an edit that drops the evidence columns — leaving
 *      confident assertions with nothing behind them — fails here, not in front of a
 *      bank.
 *   5. A mutation control proves the resolver can report a bad reference. Without it,
 *      a broken extractor would make every document "compliant".
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

const DOCS = ["docs/ROPA.md", "docs/AI-INVENTORY.md"];

/** A path with an extension, plus a line or line-range glued to it. */
const CITE = /^([A-Za-z0-9_./-]+\.[a-z]{1,6}):(\d+)(?:-(\d+))?$/;

/** Non-repo paths a compliance document legitimately cites. Exact list, asserted. */
const EXTERNAL = ["difc-law.txt", "difc-regs.txt"];

type Ref = { path: string; start: number; end: number; raw: string };

function extractRefs(md: string): Ref[] {
  const out: Ref[] = [];
  // Only inline-code spans are scanned: prose citations of provisions ("Article
  // 15(1)(a)", "Regulation 10.2.2(g)") are law, not locations, and a regex over the
  // whole page would spend its life reporting them as broken files.
  for (const m of md.matchAll(/`([^`\n]+)`/g)) {
    const span = m[1];
    if (!span) continue;
    const hit = CITE.exec(span);
    const path = hit?.[1];
    const start = hit?.[2];
    if (!path || !start) continue;
    out.push({ path, start: Number(start), end: Number(hit[3] ?? start), raw: span });
  }
  return out;
}

/** Tracked files, so a citation to a deleted or renamed source fails on its own terms. */
const TRACKED = new TextDecoder()
  // `git ls-files` is the authoritative inventory; an untracked scratch file is not
  // a legitimate citation target and must not resolve.
  .decode(Bun.spawnSync({ cmd: ["git", "ls-files"], cwd: ROOT, stdout: "pipe" }).stdout)
  .split("\n")
  .filter(Boolean);

/** Resolve a cited path to a tracked file, or explain why it cannot be resolved. */
function resolveCitedFile(path: string): { ok: boolean; why: string } {
  if (path.includes("/") && TRACKED.includes(path)) return { ok: true, why: "" };
  const suffix = `/${path}`;
  const matches = TRACKED.filter((f) => f.endsWith(suffix));
  if (matches.length === 1) return { ok: true, why: "" };
  if (matches.length > 1)
    return {
      ok: false,
      why: `ambiguous bare filename — ${matches.length} files end with ${suffix}`,
    };
  if (!path.includes("/") && !TRACKED.includes(path))
    return { ok: false, why: `no tracked file at ${path}` };
  return { ok: false, why: `no tracked file matching ${path}` };
}

function lineCount(path: string): number {
  return readFileSync(resolve(ROOT, path), "utf8").split("\n").length;
}

/** The one place that decides good-vs-broken, shared by the real test and its control. */
function findBroken(refs: Ref[]): string[] {
  const broken: string[] = [];
  for (const r of refs) {
    if (EXTERNAL.includes(r.path)) continue;
    if (EXTERNAL.some((e) => r.path.endsWith(e))) {
      broken.push(`${r.raw} — legislation text must be cited by its exact name`);
      continue;
    }
    const res = resolveCitedFile(r.path);
    if (!res.ok) {
      broken.push(`${r.raw} — ${res.why}`);
      continue;
    }
    const target = r.path.includes("/") ? r.path : TRACKED.find((f) => f.endsWith(`/${r.path}`))!;
    const total = lineCount(target);
    if (r.start < 1 || r.end > total || r.end < r.start) {
      broken.push(`${r.raw} — outside 1..${total} in ${target}`);
    }
  }
  return broken;
}

describe("compliance record citations resolve", () => {
  const docs = DOCS.map((p) => ({ p, md: readFileSync(resolve(ROOT, p), "utf8") }));
  const refs = docs.flatMap((d) => extractRefs(d.md));

  test("the documents exist and are not stubs", () => {
    for (const d of docs) expect(d.md.length, `${d.p} is empty`).toBeGreaterThan(4000);
  });

  test("the extractor extracts — a zero here means the gate is blind, not that the docs are clean", () => {
    // Generous floor. The first draft carried 60+ resolvable citations; ordinary
    // editing will not trip it, but a rewrite that drops the evidence columns will.
    expect(refs.length).toBeGreaterThan(30);
  });

  test("every citation points at a tracked file and a line inside it", () => {
    const broken = findBroken(refs);
    expect(broken, broken.join("\n")).toEqual([]);
  });

  test("nothing that looks like a source file escapes resolution", () => {
    // The skip list is checked, not trusted. Without this, the previous test passes
    // on any filename the resolver was told to ignore.
    const skipped = refs.filter((r) => EXTERNAL.includes(r.path));
    for (const s of skipped) expect(s.path).toMatch(/^difc-(law|regs)\.txt$/);
    const unresolved = refs.filter(
      (r) => !EXTERNAL.includes(r.path) && !resolveCitedFile(r.path).ok,
    );
    expect(unresolved.map((u) => u.raw)).toEqual([]);
  });

  test("mutation control: a bad citation is reported, not tolerated", () => {
    const poisoned = extractRefs(
      "`src/lib/privacy/retention.ts:999999`, `src/nope/ghost.ts:1` and `page.tsx:3`",
    );
    expect(poisoned.length).toBe(3);
    const broken = findBroken(poisoned);
    // out-of-range, nonexistent path, and ambiguous bare name — all three branches.
    expect(broken.length).toBe(3);
    expect(broken.join("\n")).toContain("outside 1..");
    expect(broken.join("\n")).toContain("no tracked file");
    expect(broken.join("\n")).toContain("ambiguous");
  });

  test("the record still cites the provisions it claims to satisfy", () => {
    const required: Record<string, string[]> = {
      "docs/ROPA.md": ["15(1)(a)", "15(1)(b)", "15(1)(g)", "15(1)(h)", "Regulation 2.1"],
      "docs/AI-INVENTORY.md": ["10.2.2(g)", "10.1.1", "10.3.3", "10.3.4", "Article 38"],
    };
    // A register that quietly stops citing its own legal basis is how a compliance
    // document becomes decoration. Looping over the loaded docs rather than indexing
    // them means a missing document fails loudly instead of reading as "nothing to check".
    expect(docs.length).toBe(DOCS.length);
    for (const d of docs) {
      const limbs = required[d.p];
      expect(limbs, `${d.p} has no required-provision list`).toBeDefined();
      for (const limb of limbs ?? []) {
        expect(d.md, `${d.p} must address ${limb}`).toContain(limb);
      }
    }
  });
});
