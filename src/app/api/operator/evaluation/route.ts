import { NextResponse } from "next/server";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { readEvaluationSummary } from "@/lib/operator/evaluation";

export const dynamic = "force-dynamic";

/**
 * GET /api/operator/evaluation — the Stage-2 Agent-Testing evidence the
 * dashboard renders.
 *
 * This is TELEMETRY, not a new database of results: it reads the committed
 * evidence artifacts the same way `scripts/run-agent-tests.ts` writes them, so
 * the dashboard panel and the evidence pack can never disagree.
 *
 * ## What is and is not in here
 *
 *   IN: per-language multi-run pass rates, the tool-call criterion and its
 *       pass rate, which scenarios were proven offline instead, the vendor
 *       agent-testing endpoint, and the honest unverified counts.
 *
 *   OUT: every secret and every transcript. Pass/fail telemetry only, exactly
 *       like /api/operator/manifest and /api/operator/webhooks name capability
 *       and never credential. Rate-limited because it is still a scrape target.
 */
export async function GET(req: Request) {
  const rl = consumeRateLimit(
    "operator-evaluation",
    rateLimitId(req as never, "operator-evaluation"),
    1,
    60,
  );
  if (!rl.ok) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  return NextResponse.json(readEvaluationSummary());
}
