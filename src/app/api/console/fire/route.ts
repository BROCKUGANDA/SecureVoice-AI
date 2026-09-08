import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "crypto";
import { z } from "zod";
import { requireOperator, deductCredit } from "@/lib/credits";
import { consume as consumeRateLimit } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/**
 * Operator Console — fire a risk signal through the REAL production path.
 *
 * Gates, in order:
 *   1. Clerk session (signed in) + operator role          → 401 / 403
 *   2. Prepaid credits wallet: 1 credit per intervention  → 402 when empty
 *   3. Rate limit per operator                            → 429
 *
 * The WEBHOOK_SECRET never reaches a browser: this handler signs the exact
 * bytes a bank's fraud engine would send and forwards to /api/interventions
 * on the same origin — the identical flow, provably end-to-end.
 */

const schema = z.object({
  riskScore: z.number().min(0.5).max(0.99),
  channel: z.enum(["card", "login", "payment", "transfer", "remittance"]).default("card"),
  lang: z.enum(["en", "ar", "hi", "ur"]).default("en"),
  amountAed: z.number().min(0).max(1_000_000).optional(),
  merchant: z.string().trim().max(120).optional(),
});

function selfCustomerRef(email: string): string {
  return `SELF-${email.split("@")[0].replace(/\W/g, "").slice(0, 24) || "operator"}`;
}

export async function POST(req: NextRequest) {
  const guard = await requireOperator();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const profile = guard.profile;

  // Prepaid wallet — block BEFORE any upstream cost is incurred
  if (profile.credits <= 0) {
    return NextResponse.json(
      { error: "Insufficient credits — your wallet is empty. Email otemaach@gmail.com to top up.", credits: 0 },
      { status: 402, headers: { "X-Credits-Balance": "0" } }
    );
  }

  const rl = consumeRateLimit("console-fire", profile.clerkUserId);
  if (!rl.ok) {
    return NextResponse.json({ error: "Rate limit exceeded; retry later." }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json({ error: `Invalid signal: ${first?.path.join(".")} ${first?.message ?? ""}`.trim() }, { status: 422 });
  }

  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "WEBHOOK_SECRET not configured — ingest is unarmed (see /api/status)." }, { status: 503 });
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
    },
  };
  const rawBody = JSON.stringify(signal);
  const t = Math.floor(Date.now() / 1000).toString();
  const v1 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");

  // Forward over the exact same wire a bank producer uses — same signature
  // scheme, same endpoint, same validation, same audit trail.
  const upstream = await fetch(`${req.nextUrl.origin}/api/interventions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "SV-Signature": `t=${t},v1=${v1}`,
      "x-caller-id": `console:${profile.clerkUserId.slice(0, 40)}`,
    },
    body: rawBody,
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await upstream.json().catch(() => ({ error: "unparseable upstream response" }))) as Record<string, unknown>;

  // Metered deduction only on an accepted intervention (202) — a failed
  // upstream attempt costs the operator nothing.
  let credits = profile.credits;
  if (upstream.status === 202) {
    credits = await deductCredit(profile.clerkUserId);
  }

  return NextResponse.json(
    { ...data, creditsRemaining: credits, signedSignal: signal.signal },
    { status: upstream.status }
  );
}
