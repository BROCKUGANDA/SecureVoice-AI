/**
 * The agent snapshot is a COMMITTED evidence artifact whose whole purpose is to
 * be published as proof of which configuration was live. That makes a secret in
 * it worse than a secret in a build log: it is in git history, on the default
 * branch, described as a credential.
 *
 * The ElevenLabs API returns an agent's outbound tool auth headers verbatim, so
 * `x-agent-tool-secret` — the value our own endpoints check to decide whether an
 * agent tool call is genuine — was being written straight to
 * evidence/agent/snapshot.json. This asserts the file cannot carry one.
 *
 * Presence is still configuration a judge should see (was the header set?), so
 * the assertion is about the VALUE, not the key.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const snap = readFileSync(new URL("../../evidence/agent/snapshot.json", import.meta.url), "utf8");

test("no live tool secret is present in the committed snapshot", () => {
  // Read .env defensively — and it has to be REALLY defensive. A CI checkout
  // has no .env at all (it is gitignored), and `readFileSync` on a missing file
  // THROWS rather than returning undefined, so the unguarded read this test
  // used to do failed the whole case on a clean runner while passing on any
  // developer machine that happened to have one. The comment claimed a
  // no-.env machine still ran these; the code did not.
  const envPath = new URL("../../.env", import.meta.url);
  let secret = "";
  if (existsSync(envPath)) {
    const envLine = readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .find((l) => l.includes("TOOL_SECRET"));
    secret = envLine?.split("=")[1]?.replace(/"/g, "").trim() ?? "";
  }
  // A short value means we found nothing usable; skip rather than assert on "".
  if (secret.length >= 16) {
    expect(snap, "the live AGENT_TOOL_SECRET is in a committed evidence file").not.toContain(
      secret,
    );
  }
  // Belt and braces: nothing that looks like a long hex secret either. This
  // catches a ROTATED secret that is no longer in .env but is still in git.
  const hexSecrets = snap.match(/"[a-f0-9]{32,}"/g) ?? [];
  expect(hexSecrets, "a long hex value looks like an unredacted secret").toEqual([]);
});

test("the header is present but redacted, so the config is still provable", () => {
  expect(snap).toContain('"x-agent-tool-secret":"[REDACTED]"');
  // And the redaction must not be so broad that it erases the tools themselves.
  expect(snap).toContain('"name":"card_freeze"');
  expect(snap).toContain('"name":"human_handoff"');
});

test("the redactor is suffix-based, so a renamed header cannot slip past", () => {
  const src = readFileSync(new URL("../../scripts/agent-snapshot.ts", import.meta.url), "utf8");
  // The header name is configurable per tool, so an exact-match list would be
  // a list that goes stale the first time someone renames it.
  expect(src).toContain("isSecretKey");
  expect(src).toMatch(/secret\|token\|password/);
});
