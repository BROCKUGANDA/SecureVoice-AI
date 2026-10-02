/**
 * Docs accuracy gate.
 *
 * The README is a graded artifact and it is read for contradictions, so the
 * claims it makes about the repository are assertions here, derived from the
 * source files rather than restated. Every one of these assertions corresponds
 * to a contradiction that was actually shipped in README.md / MODEL_CARD.md and
 * had to be corrected by hand:
 *
 *   1. the Configuration table claimed a `file:` URL works for SQLite, while two
 *      other sections correctly said there is no SQLite mode
 *   2. Features and the LLM section quoted different language sets for the same
 *      plane, and neither matched the source of truth per path
 *   3. the ElevenLabs agent was positioned as an optional extra rather than the
 *      primary conversation plane
 *   4. the default Groq model was named with no disclosure that it is preview
 *      tier, and the model card claimed a model had been retired that had not
 *   5. the latency table had no separation between measurements and targets
 *
 * No network, no database.
 *
 *   bun test tests/docs/docs-accuracy.test.ts
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const readme = read("README.md");
const card = read("MODEL_CARD.md");
const agentYaml = read("agent/securevoice.agent.yaml");
const configTs = read("src/lib/config.ts");
const schema = read("prisma/schema.prisma");

const lines = (doc: string) => doc.split(/\r?\n/);

/** The `languages:` block of the ElevenLabs agent — top-level keys, 2-space indent. */
function agentLanguages(): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of agentYaml.split(/\r?\n/)) {
    if (/^languages:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (/^\S/.test(line)) break; // the next top-level key ends the block
    const key = /^ {2}([a-z]{2}):\s*$/.exec(line);
    if (key) out.push(key[1]);
  }
  return out;
}

/** `SUPPORTED_LANGS` as declared in the built-in continuity pipeline's config. */
function pipelineLanguages(): string[] {
  const m = /export const SUPPORTED_LANGS = \[([^\]]*)\]/.exec(configTs);
  if (!m) throw new Error("SUPPORTED_LANGS not found in src/lib/config.ts");
  return m[1]!.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

const asSet = (langs: string[]) => `\`${langs.join(" / ")}\``;

// ── 1 · SQLite ─────────────────────────────────────────────────────────────

test("docs: no source file claims a `file:` URL works for SQLite", () => {
  expect(schema).toMatch(/provider\s*=\s*"postgresql"/);

  for (const [name, doc] of [["README.md", readme], ["MODEL_CARD.md", card]] as const) {
    for (const [i, line] of lines(doc).entries()) {
      if (!/file:/.test(line)) continue;
      // Any mention of a `file:` URL must be a denial, not a permission.
      expect(
        { name, line: i + 1, text: line.trim(), negated: /\b(no|not|never|rejects)\b/i.test(line) },
      ).toEqual({ name, line: i + 1, text: line.trim(), negated: true });
    }
  }
});

test("docs: the README states the Postgres-only datasource the schema actually declares", () => {
  expect(readme).toMatch(/no SQLite mode/i);
  expect(readme).toMatch(/provider = "postgresql"/);
});

// ── 2 · Languages, per path ────────────────────────────────────────────────

test("docs: the per-path language sets match their sources of truth", () => {
  expect(agentLanguages()).toEqual(["en", "ar", "hi"]);
  expect(pipelineLanguages()).toEqual(["en", "ar", "hi", "ur", "fr", "sw"]);

  // Each set must appear attributed to the file it comes from. Written as two
  // separate assertions so a swapped attribution fails with a readable diff.
  const agentClaim = lines(readme).find((l) => l.includes(asSet(agentLanguages())));
  expect(agentClaim).toBeDefined();
  expect(agentClaim).toMatch(/agent\/securevoice\.agent\.yaml/);

  const pipelineClaim = lines(readme).find(
    (l) => l.includes(asSet(pipelineLanguages().filter((l) => !agentLanguages().includes(l)))),
  );
  expect(pipelineClaim).toBeDefined();
  expect(pipelineClaim).toMatch(/src\/lib\/config\.ts/);
});

test("docs: the six-language set is never claimed without naming the path it belongs to", () => {
  const six = asSet(pipelineLanguages());
  for (const [i, line] of lines(readme).entries()) {
    if (!line.includes(six)) continue;
    expect({ line: i + 1, scoped: /continuity|pipeline|config\.ts/i.test(line) }).toEqual({
      line: i + 1,
      scoped: true,
    });
  }
});

test("docs: the recorded-conversation claim is stated, and it is narrow", () => {
  expect(readme).toMatch(/only English and Arabic have a recorded end-to-end conversation/i);
});

// ── 3 · Conversation plane positioning ─────────────────────────────────────

test("docs: no heading calls the ElevenLabs conversation plane optional", () => {
  for (const line of lines(readme)) {
    if (!/^#{1,6} /.test(line)) continue;
    expect({ heading: line, optional: /optional/i.test(line) }).toEqual({
      heading: line,
      optional: false,
    });
  }
});

test("docs: the README names the agent primary and the built-in pipeline the continuity path", () => {
  expect(readme).toMatch(/ElevenLabs conversation plane \(primary\)/i);
  expect(readme).toMatch(/continuity path/i);
  // The step-down trigger and the capability lost must both be named.
  const continuity = readme.slice(readme.search(/### Continuity path/i));
  expect(continuity).toMatch(/ELEVENLABS_DRY_RUN/);
  expect(continuity).toMatch(/FEATURE_ELEVEN_LABS_LIVE/);
  expect(continuity).toMatch(/lost/i);
});

// ── 4 · Groq preview tier ──────────────────────────────────────────────────

test("docs: every mention of the default Groq model discloses preview tier", () => {
  const mentions = [...readme.matchAll(/[^\n]*qwen\/qwen3\.8-27b[^\n]*/g)].map((m) => m[0]);
  expect(mentions.length).toBeGreaterThan(0);
  for (const mention of mentions) {
    expect({ mention: mention.trim(), disclosed: /preview/i.test(mention) }).toEqual({
      mention: mention.trim(),
      disclosed: true,
    });
  }
});

test("docs: the model card does not claim a live Groq model was retired", () => {
  expect(card).not.toMatch(/llama-3\.1-8b-instant[^\n]*retired/i);
  expect(card).not.toMatch(/retired[^\n]*llama-3\.1/i);
  expect(card).toMatch(/llama-3\.1-8b-instant[^\n]*production/i);
});

// ── 5 · Latency: measurement vs target ─────────────────────────────────────

/** Rows of the README's Measured latency table, minus header and separator. */
function latencyRows(): string[][] {
  const start = lines(readme).findIndex((l) => /^## Measured latency\s*$/.test(l));
  expect(start).toBeGreaterThan(-1);
  const rows: string[][] = [];
  for (const line of lines(readme).slice(start)) {
    if (rows.length > 0 && !/^\|/.test(line)) break; // table ended
    if (!/^\|/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.some((c) => /^-{3,}$/.test(c))) continue;
    if (/^Leg$/i.test(cells[0] ?? "")) continue;
    rows.push(cells);
  }
  return rows;
}

test("docs: the latency table labels every row measured or not yet measured", () => {
  const rows = latencyRows();
  expect(rows.length).toBeGreaterThanOrEqual(5);

  for (const [leg, target, measured, status] of rows) {
    const isMeasured = /measured/i.test(status!) && !/not yet measured/i.test(status!);
    // A number presented as a measurement must sit in a row labelled MEASURED,
    // and a row with no measurement must say so in as many words.
    const showsValue = /\d/.test(measured!);
    expect({ leg, isMeasured, showsValue, consistent: showsValue === isMeasured }).toEqual({
      leg,
      isMeasured,
      showsValue,
      consistent: true,
    });
    expect(target).toMatch(/\d/);
  }
});

test("docs: the model card does not present an observed range as a p95", () => {
  expect(card).not.toMatch(/p95[^\n|]*0\.4[–-]0\.9/);
  expect(card).toMatch(/not yet measured/i);
});

// ── Evidence link ─────────────────────────────────────────────────────────

test("docs: the README links the evidence index it ships with", () => {
  expect(readme).toMatch(/\]\(evidence\/INDEX\.md\)/);
});