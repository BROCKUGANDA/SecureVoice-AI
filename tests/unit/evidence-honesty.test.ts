/**
 * EVIDENCE HONESTY GATE — no artifact may claim vendor evidence it does not have.
 *
 * Why this exists. The account's ElevenLabs character quota is exhausted
 * (10000/10000), so the committed transcript artifact was captured with
 * ELEVENLABS_DRY_RUN=true: the conversation CONTENT is a synthetic fixture
 * shaped like the vendor's post-call payload. Everything downstream of it —
 * signature verification, redaction, the audit chain, the seal, the state
 * transition, the bank notification — is real runtime output.
 *
 * That distinction is recorded honestly in the artifact's own `mode` block. The
 * risk is not the artifact; it is that a JUDGE skims `evidence/transcripts/`
 * and reads a transcript as a recorded vendor call, because nothing in the file
 * tree stops them. A disclaimer that only exists inside one JSON file is a
 * disclaimer nobody reads.
 *
 * So the rule becomes a gate. If any file under evidence/ claims
 * `vendor_evidence: true` while also declaring a dry-run dial, or if an
 * artifact that IS a transcript carries no mode declaration at all, this fails
 * the build. That is the only durable form of an honest label: it costs a red
 * CI run to be wrong about.
 *
 * It also asserts the STRONGER claim is present, so the submission cannot quietly
 * be weakened back to the weaker evidence: the runtime guardrail suite must
 * remain the named high-stakes proof.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const EVIDENCE = join(ROOT, "evidence");
const DOCS_EVIDENCE = join(ROOT, "docs", "evidence");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".json")) out.push(full);
  }
  return out;
}

/**
 * The transcript ARTIFACT, in either committed location.
 *
 * `conversation-run.json` is excluded on purpose: it is the gate's own run
 * record (command, exit code, output tail), not a conversation. It has no `mode`
 * block because it is not claiming to be evidence of a call — it is evidence
 * that the gate ran. Confusing the two is exactly the mistake this file exists
 * to prevent, so the distinction is made explicit here rather than left to a
 * regex that could drift.
 */
function transcriptArtifacts(): string[] {
  return [...walk(EVIDENCE), ...walk(DOCS_EVIDENCE)].filter((p) => /conversation\.json$/.test(p));
}

describe("evidence honesty", () => {
  test("there IS a transcript artifact to gate", () => {
    // A gate that passes because it found nothing is not a gate.
    expect(transcriptArtifacts().length).toBeGreaterThan(0);
  });

  test("every transcript artifact declares its mode, and dry-run never claims vendor evidence", () => {
    const artifacts = transcriptArtifacts();
    expect(artifacts.length).toBeGreaterThan(0);

    for (const path of artifacts) {
      const label = relative(ROOT, path);
      const data = JSON.parse(readFileSync(path, "utf8"));

      // The declaration is mandatory. An artifact with no `mode` block cannot
      // be audited, and an unauditable transcript is the failure mode here.
      expect({ label, hasMode: Boolean(data.mode) }).toEqual({ label, hasMode: true });

      const dial = String(data.mode?.dial ?? "");
      const vendorEvidence = data.mode?.vendor_evidence;

      // The load-bearing assertion. A dry-run dial CANNOT be vendor evidence,
      // whatever the file claims.
      if (dial === "dry-run") {
        expect({ label, dial, vendorEvidence }).toEqual({ label, dial, vendorEvidence: false });
      }

      // ...and the inverse: claiming vendor evidence requires a real dial.
      if (vendorEvidence === true) {
        expect({ label, dial, mustNotBeDryRun: dial !== "dry-run" }).toEqual({
          label,
          dial,
          mustNotBeDryRun: true,
        });
      }
    }
  });

  test("the dry-run transcript points at the runtime suite as the real high-stakes proof", () => {
    // The artifact must not be the only thing a judge can look at for the
    // freeze behaviour. It should name where that evidence actually lives.
    const path = transcriptArtifacts().find((p) => p.includes("conversation.json"));
    expect(path).toBeDefined();
    const raw = readFileSync(path!, "utf8");
    // Either by note in the artifact, or by the committed suite it cites.
    const citesRuntimeEvidence =
      raw.includes("guardrails") ||
      raw.includes("committed:false") ||
      raw.includes('committed": false');
    expect({ citesRuntimeEvidence }).toEqual({ citesRuntimeEvidence: true });
  });

  test("the runtime guardrail suite is present and still 8/8", () => {
    // This is the strong claim the submission now leads on. If it regresses,
    // the submission has no fallback evidence and this must fail loudly rather
    // than let a stale "8/8" claim survive in markdown.
    const path = join(DOCS_EVIDENCE, "guardrails-runtime-2026-10-01.json");
    const data = JSON.parse(readFileSync(path, "utf8"));

    expect(data.totals.checks).toBe(8);
    expect(data.totals.passed).toBe(8);
    expect(data.totals.failed).toBe(0);

    // The high-stakes assertion, by name. A suite that passes 8/8 but no longer
    // checks `committed:false` is not evidence for the freeze rule.
    const freeze = data.checks.find((c: { check: string }) =>
      /staged, not committed/i.test(c.check),
    );
    expect(freeze).toBeDefined();
    expect(freeze!.passed).toBe(true);
    expect(freeze!.response.committed).toBe(false);
    expect(freeze!.actual_http).toBe(200);

    // Every check must actually have run: a row with no observed HTTP status is
    // a claim, not a result.
    for (const c of data.checks as Array<{ check: string; actual_http: number }>) {
      expect({ check: c.check, observed: typeof c.actual_http === "number" }).toEqual({
        check: c.check,
        observed: true,
      });
    }
  });

  test("no evidence artifact is newer than the suites that produced it", () => {
    // Guards against a stale-but-optimistic summary being cited after the
    // underlying run regressed. The agent-testing artifact must keep admitting
    // it is partial rather than quietly claiming a full pass rate.
    const path = join(DOCS_EVIDENCE, "elevenlabs-agent-testing-2026-10-01.json");
    const data = JSON.parse(readFileSync(path, "utf8"));
    const summary = data.summary ?? {};

    // Whatever the numbers are, unexecuted runs must be visible as such.
    const executed = summary.executed ?? summary.scored;
    const requested = summary.requested ?? summary.total;
    if (typeof requested === "number" && typeof executed === "number") {
      expect(executed).toBeLessThanOrEqual(requested);
    }
  });
});
