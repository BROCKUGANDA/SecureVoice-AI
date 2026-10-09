import { NextResponse } from "next/server";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { agentManifest } from "@/lib/operator/manifest";

export const dynamic = "force-dynamic";

/**
 * GET /api/operator/manifest — what the agent KNOWS and can DO, as JSON.
 *
 * The operator dashboard's "Knowledge Base + RAG" and "Tools & Actions" panels
 * render this, so a human can see which documents ground the agent and which
 * tools it can reach — with the trust context that bounds privileged actions —
 * without a vendor call and without a second hardcoded copy in the UI.
 *
 * ## What is and is not in here
 *
 *   IN: KB document titles/languages/versions, RAG settings, the source-
 *       attribution flag, the five tool names with their backend, scoping and
 *       trust level, the backends they reach, and the MCP front door. All of it
 *       is integration CONFIGURATION — src/lib/operator/manifest.ts is the one
 *       source of truth.
 *
 *   OUT: every secret. No API key, no AGENT_TOOL_SECRET, no BYOK material. This
 *       is the same contract /api/operator/webhooks holds: it names capability,
 *       never credential. BYOK keys stay encrypted (src/lib/byok.ts) and masked
 *       in Settings; the tool secret never leaves the server.
 *
 * ## Why it is public-by-design
 *
 * The capability surface is discoverable from the published contract and docs;
 * gating it protects nothing. It is still rate-limited because it is a scrape
 * target and the cost of serving it should stay bounded.
 */
export async function GET(req: Request) {
  const rl = consumeRateLimit(
    "operator-manifest",
    rateLimitId(req as never, "operator-manifest"),
    1,
    60,
  );
  if (!rl.ok) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  return NextResponse.json(agentManifest());
}
