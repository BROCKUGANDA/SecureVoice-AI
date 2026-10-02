import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "crypto";
import { z } from "zod";
import { requireSignedIn, deductCredit, refundCredit } from "@/lib/credits";
import { consume as consumeRateLimit } from "@/lib/ratelimit";
import { env, SUPPORTED_LANGS } from "@/lib/config";
import { badRequest, paymentRequired, tooManyRequests, unprocessable, upstreamError, parseJson } from "@/lib/api-errors";

export const dynamic = "force-dynamic";

/**
 * Operator Console — fire a risk signal through the REAL production path.
 *
 * Gates, in order:
 *   1. Clerk session (signed in)                        → 401
 *   2. Prepaid credits wallet: 1 credit per intervention → 402 when empty
 *   3. Rate limit per operator                          → 429
 *
 * The WEBHOOK_SECRET never reaches a browser: this handler signs the exact
 * bytes a bank's fraud engine would send and forwards to /api/interventions
 * on the same origin — the identical flow, provably end-to-end.
 */

const schema = z.object({
  riskScore: z.number().min(0.5).max(0.99),
  channel: z.enum(["card", "login", "payment", "transfer", "remittance"]).default("card"),
  lang: z.enum(SUPPORTED_LANGS).default("en"),
  amountAed: z.number().min(0).max(1_000_000).optional(),
  merchant: z.string().trim().max(120).optional(),
});

function selfCustomerRef(email: string): string {
  return `SELF-${email.split("@")[0].replace(/\W/g, "").slice(0, 24) || "operator"}`;
}

export async function POST(req: NextRequest) {
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return guard.status === 401
      ? NextResponse.json({ error: guard.error }, { status: 401 })
      : NextResponse.json({ error: guard.error }, { status: 403 });
  }
  const profile = guard.profile;

  // Prepaid wallet — CLAIM the credit BEFORE any upstream cost is incurred.
  // A check-then-deduct-afterwards pair lets N concurrent fires all pass the
  // guard on a 1-credit wallet; deductCredit's atomic decrement makes the
  // claim itself the gate. It is refunded below if the intervention is not
  // accepted upstream.
  const claimed = await deductCredit(profile.clerkUserId);
  if (claimed < 0) {
    return paymentRequired(
      "Insufficient credits — your wallet is empty. Contact your administrator to top up.",
      { credits: 0 }
    );
  }

  const rl = consumeRateLimit("console-fire", profile.clerkUserId);
  if (!rl.ok) {
    return tooManyRequests();
  }

  const body = await parseJson(req);
  if (body === null) return badRequest("Invalid JSON body");

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return unprocessable(`Invalid signal: ${first?.path.join(".")} ${first?.message ?? ""}`.trim());
  }

  const secret = env.webhookSecret;
  if (!secret) {
    await refundCredit(profile.clerkUserId);
    return upstreamError("WEBHOOK_SECRET not configured — ingest is unarmed (see /api/status).", 503);
  }

  const d = parsed.data;
  const signal = {
    signal: {
      caseId: `SELF-${Date.now().toString(36).toUpperCase()}`,
      riskScore: d.riskScore,
      channel: d.channel,
      customer: { ref: selfCustomerRef(profile.email), lang: d.lang },
      transaction: {
        ...(d.amountAed != null ? { amountAed: d.amountAed } : {}),
        ...(d.merchant ? { merchant: d.merchant } : {}),
      },
      ...(profile.orgId ? { orgId: profile.orgId } : {}),
    },
  };
  const rawBody = JSON.stringify(signal);
  const t = Math.floor(Date.now() / 1000).toString();
  const v1 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");

  // Forward over the exact same wire a bank producer uses — same signature
  // scheme, same endpoint, same validation, same audit trail.
  let upstream: Response;
  try {
    upstream = await fetch(`${req.nextUrl.origin}/api/interventions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "SV-Signature": `t=${t},v1=${v1}`,
        "x-caller-id": `console:${profile.clerkUserId.slice(0, 40)}`,
      },
      body: rawBody,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    // Network/timeout before a verdict — the claimed credit is refunded.
    await refundCredit(profile.clerkUserId);
    console.error("[console-fire] upstream unreachable:", err instanceof Error ? err.message : err);
    return upstreamError("Intervention path unreachable — credit refunded, nothing was armed.", 503);
  }
  const data = (await upstream.json().catch(() => ({ error: "unparseable upstream response" }))) as Record<string, unknown>;

  // The credit was claimed before the upstream call; a non-accepted
  // intervention costs the operator nothing — refund it atomically.
  let credits = claimed;
  if (upstream.status !== 202) {
    credits = await refundCredit(profile.clerkUserId);
  }

  return NextResponse.json(
    { ...data, creditsRemaining: credits, signedSignal: signal.signal },
    { status: upstream.status }
  );
}
