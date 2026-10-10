import "server-only";
/**
 * Evaluation evidence reader — surfaces the Stage-2 Agent-Testing artifacts on
 * the dashboard, read from the committed evidence files rather than a second
 * in-app database of results.
 *
 * The agent-testing harness (scripts/run-agent-tests.ts) writes
 * `evidence/guardrails/redteam.json` (+ per-language arms) as the source of
 * truth for multi-run pass rates, the tool-call criterion, and which scenarios
 * were proven offline. The dashboard must not restate those numbers — it reads
 * the same artifact the evidence pack cites, so the panel and the evidence pack
 * can never disagree.
 *
 * NO SECRETS. These files are pass/fail telemetry: rates, scenario ids, and the
 * vendor endpoint. No transcript, no key, no customer data is returned.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

type RawEval = {
  languages?: string[];
  runs_per_scenario?: number;
  generated_at?: string;
  agent_id?: string;
  endpoint?: string;
  coverage?: {
    scored_agent_layer?: string[];
    proven_offline_instead?: string[];
    structural_runs_observed?: number;
    executed_here?: number;
    unverified?: number;
  };
  summary?: { scored?: number; passed?: number; pass_rate?: number; errors?: number };
  tool_call_criterion?: {
    runs?: number;
    executed?: number;
    unverified?: number;
    pass_rate?: number;
    criterion_met?: boolean;
    by_scenario?: Array<{
      id: string;
      title: string;
      kind?: string;
      runs?: number;
      executed?: number;
      unverified?: number;
      pass_rate?: number;
      tool_was_available?: boolean;
    }>;
  };
};

export type EvalLanguage = {
  language: string;
  runs_per_scenario: number;
  generated_at: string | null;
  agent_layer: { scored: number; passed: number; pass_rate: number };
  tool_call: { executed: number; pass_rate: number; criterion_met: boolean; unverified: number };
  coverage: { proven_offline: string[]; unverified: number };
  tool_scenarios: Array<{ id: string; title: string; kind: string | null; pass_rate: number }>;
};

export type EvaluationSummary = {
  ok: true;
  agent_id: string | null;
  endpoint: string | null;
  languages: EvalLanguage[];
  integrity_note: string;
};

/** Language code → evidence file (cwd-relative). An arm that has not run yet is simply omitted. */
const ARMS: ReadonlyArray<{ code: string; file: string }> = [
  { code: "en", file: "evidence/guardrails/redteam.json" },
  { code: "ar", file: "evidence/guardrails/redteam-ar.json" },
];

function readRaw(rel: string): RawEval | null {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), rel), "utf8")) as RawEval;
  } catch {
    return null; // that arm has not been run on this checkout — omit, do not fabricate
  }
}

export function readEvaluationSummary(): EvaluationSummary {
  const languages: EvalLanguage[] = [];
  let agentId: string | null = null;
  let endpoint: string | null = null;

  for (const { code, file } of ARMS) {
    const raw = readRaw(file);
    if (!raw) continue;
    agentId ??= raw.agent_id ?? null;
    endpoint ??= raw.endpoint ?? null;
    languages.push({
      language: code,
      runs_per_scenario: raw.runs_per_scenario ?? 0,
      generated_at: raw.generated_at ?? null,
      agent_layer: {
        scored: raw.summary?.scored ?? 0,
        passed: raw.summary?.passed ?? 0,
        pass_rate: raw.summary?.pass_rate ?? 0,
      },
      tool_call: {
        executed: raw.tool_call_criterion?.executed ?? 0,
        pass_rate: raw.tool_call_criterion?.pass_rate ?? 0,
        criterion_met: raw.tool_call_criterion?.criterion_met ?? false,
        unverified: raw.tool_call_criterion?.unverified ?? 0,
      },
      coverage: {
        proven_offline: raw.coverage?.proven_offline_instead ?? [],
        unverified: raw.coverage?.unverified ?? 0,
      },
      tool_scenarios: (raw.tool_call_criterion?.by_scenario ?? []).map((s) => ({
        id: s.id,
        title: s.title,
        kind: s.kind ?? null,
        pass_rate: s.pass_rate ?? 0,
      })),
    });
  }

  return {
    ok: true,
    agent_id: agentId,
    endpoint: endpoint,
    languages,
    integrity_note:
      "Pass rates count only runs that executed and were judged. A run that could not execute is UNVERIFIED, never passed — so the number is honest, not inflated.",
  };
}
