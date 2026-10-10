/**
 * E2E — the operator evaluation evidence (Stage-2 Agent-Testing).
 *
 * Two properties, the second the one that matters:
 *
 *   1. The panel the dashboard renders is served from the SAME committed
 *      evidence artifact the evidence pack cites — so panel and evidence pack
 *      cannot disagree. Pass rates are in [0,1]; each arm carries its tool-call
 *      scenarios.
 *
 *   2. NO SECRET OR TRANSCRIPT LEAKS. This is pass/fail telemetry only — no API
 *      key, no secret name, no transcript text. The integrity sentence that
 *      frames unverified runs as "never passed" is asserted present, because
 *      that honesty is the point of the panel.
 *
 *   bun scripts/run-tests.mjs operator-evaluation
 */
import { expect, test } from "bun:test";
import { NextRequest } from "next/server";

test("operator evaluation surfaces agent-testing evidence and leaks no secrets", async () => {
  const { GET } = await import("@/app/api/operator/evaluation/route");
  const res = await GET(new NextRequest("http://localhost/api/operator/evaluation"));
  expect(res.status).toBe(200);

  const body = (await res.json()) as {
    ok: boolean;
    agent_id: string | null;
    endpoint: string | null;
    languages: Array<{
      language: string;
      runs_per_scenario: number;
      agent_layer: { scored: number; passed: number; pass_rate: number };
      tool_call: {
        executed: number;
        pass_rate: number;
        criterion_met: boolean;
        unverified: number;
      };
      coverage: { proven_offline: string[]; unverified: number };
      tool_scenarios: Array<{ id: string; pass_rate: number }>;
    }>;
    integrity_note: string;
  };

  expect(body.ok).toBe(true);
  expect(body.languages.length).toBeGreaterThan(0);

  for (const arm of body.languages) {
    expect(arm.runs_per_scenario).toBeGreaterThan(0);
    expect(arm.agent_layer.scored).toBeGreaterThan(0);
    expect(arm.agent_layer.pass_rate).toBeGreaterThanOrEqual(0);
    expect(arm.agent_layer.pass_rate).toBeLessThanOrEqual(1);
    // the tool-call criterion carries its per-scenario rows
    expect(arm.tool_scenarios.length).toBeGreaterThan(0);
    for (const s of arm.tool_scenarios) {
      expect(s.pass_rate).toBeGreaterThanOrEqual(0);
      expect(s.pass_rate).toBeLessThanOrEqual(1);
    }
  }

  // Telemetry only — no key, no secret name, no transcript.
  const raw = JSON.stringify(body);
  expect(raw).not.toMatch(/sk_[A-Za-z0-9]{8,}/);
  expect(raw).not.toContain("AGENT_TOOL_SECRET");
  expect(raw.toLowerCase()).not.toContain("secret");

  // The honesty framing is present.
  const note = body.integrity_note.toLowerCase();
  expect(note).toContain("unverified");
  expect(note).toContain("passed");
});
