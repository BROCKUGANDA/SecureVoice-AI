import { NextResponse } from "next/server";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { readModelLayer } from "@/lib/operator/model-layer";

export const dynamic = "force-dynamic";

/**
 * GET /api/operator/model-layer — which models answer the voice, and in what
 * fallback order, as JSON for the dashboard's Model-layer panel.
 *
 * ## What is and is not in here
 *
 *   IN: the agent-plane LLM, the continuity-plane fallback cascade order, and
 *       which provider is currently active BY NAME. LLM-agnostic made visible.
 *
 *   OUT: every credential. `provider()` resolves the active fallback with its
 *       key and base URL, but only its NAME is read out — no key, no endpoint.
 *       Rate-limited because it is a scrape target, exactly like the sibling
 *       /api/operator/* metadata routes.
 */
export async function GET(req: Request) {
  const rl = consumeRateLimit(
    "operator-model-layer",
    rateLimitId(req as never, "operator-model-layer"),
    1,
    60,
  );
  if (!rl.ok) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  return NextResponse.json(readModelLayer());
}
