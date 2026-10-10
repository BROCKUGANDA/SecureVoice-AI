import { NextResponse } from "next/server";
import { z } from "zod";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { verifyProducerKey } from "@/lib/producer-keys";
import { isE164 } from "@/lib/twilio";
import { isAfterHours } from "@/lib/abuse/velocity";
import { createCase, transitionCase } from "@/lib/case-state-machine";
import { enqueueDialJob } from "@/lib/scale/queue";
import { db } from "@/lib/db";
import { preNotificationLeadMs } from "@/lib/prenotify";
import { logInfo, logWarn } from "@/lib/validation/safe-log";
import { SUPPORTED_LANGS, resolveDeliveryLang } from "@/lib/languages";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/campaigns — batch (outbound campaign) ingest.
 *
 * An institution that wants to reach a LIST (a governed-collections week, a
 * customer-awareness drive) posts the list once instead of N risk signals. This
 * route is deliberately NOT a second dial path: for every recipient it runs the
 * same two primitives the single-signal ingest uses — `createCase` +
 * `enqueueDialJob` — so each campaign member joins the SAME durable queue and the
 * SAME dial worker that enforces do-not-call, the calling window and the retry
 * ladder. Enforcement stays in one place.
 *
 * The only campaign-specific work is the summary: a producer wants to know how
 * many recipients were accepted, skipped for do-not-call, refused as malformed,
 * or deferred to the calling window — before it spends the batch.
 */
const CATEGORIES = [
  "fact_finding",
  "sensitive_case",
  "b2b",
  "routine",
  "time_critical_fraud",
] as const;

const recipientSchema = z.object({
  phone: z.string(),
});

const bodySchema = z.object({
  // The documented contract is the six supported codes. An unsupported string
  // used to be accepted here, stored on the case, and then ignored by the dial
  // worker (which defaults to English) — the case row and the call disagreed.
  // Rejected at the boundary instead, exactly like the GET documents.
  lang: z.enum(SUPPORTED_LANGS).optional(),
  callCategory: z.enum(CATEGORIES).optional(),
  institution: z.enum(["bank", "insurer"]).optional(),
  /** 1..500 campaigns per call; a larger list is chunked by the caller. */
  recipients: z.array(recipientSchema).min(1).max(500),
});

type Outcome =
  "accepted" | "invalid_phone" | "skipped_do_not_call" | "deferred_calling_hours" | "failed";

export async function POST(req: Request) {
  const rl = consumeRateLimit("campaigns", rateLimitId(req, "campaigns"), 1, 20);
  if (!rl.ok) return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });

  const bearer = req.headers.get("authorization")?.replace(/^Bearer /i, "") ?? null;
  const producer = await verifyProducerKey(bearer);
  if (!producer.ok) {
    return NextResponse.json(
      { ok: false, error: "Invalid or revoked producer key" },
      { status: 401 },
    );
  }
  const orgId = producer.orgId ?? null;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "recipients required (1..500)", code: "invalid" },
      { status: 422 },
    );
  }
  const { recipients } = parsed.data;
  // resolveDeliveryLang is the single-signal ingest's normaliser: the schema
  // has already rejected anything outside the supported set, and this keeps
  // the stored language and the spoken language the same value.
  const lang = resolveDeliveryLang(parsed.data.lang);
  const callCategory = parsed.data.callCategory ?? "routine";
  const institution = parsed.data.institution ?? "bank";
  const leadMs = preNotificationLeadMs();

  const results: Array<{ phone: string; outcome: Outcome; caseRef?: string }> = [];
  const counts: Record<Outcome, number> = {
    accepted: 0,
    invalid_phone: 0,
    skipped_do_not_call: 0,
    deferred_calling_hours: 0,
    failed: 0,
  };

  for (const r of recipients) {
    const phone = r.phone?.trim() ?? "";
    if (!isE164(phone)) {
      counts.invalid_phone++;
      results.push({ phone, outcome: "invalid_phone" });
      continue;
    }

    // Do-not-call pre-skip so a campaign does not enqueue cases it will never
    // dial. Time-critical fraud is consent-backed and deliberately NOT gated on
    // the registry, matching the dial worker (dial.ts). The worker re-checks at
    // claim time regardless — this is the summary, not a replacement.
    if (callCategory !== "time_critical_fraud") {
      const dnc = await db.doNotCall.findUnique({ where: { phone } }).catch(() => null);
      if (dnc) {
        counts.skipped_do_not_call++;
        results.push({ phone, outcome: "skipped_do_not_call" });
        continue;
      }
    }

    const afterHours = callCategory === "routine" && isAfterHours(Date.now());
    const caseRef = `SV-CAMP-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    try {
      const { id } = await createCase({
        caseRef,
        orgId,
        language: lang,
        phone,
        callCategory,
      });
      // RECEIVED → SCREENED through the single writer, exactly as the
      // single-signal ingest does before enqueueing. Without this the case
      // stays in RECEIVED and the dial worker's SCREENED → DIALING transition
      // is illegal, so the job retries and the recipient is called twice.
      await transitionCase(caseRef, "SCREENED");
      await enqueueDialJob({
        caseId: id,
        caseRef,
        orgId,
        attemptNo: 1,
        // The language travels with the job: the worker resolves the ASR, the
        // voice and every spoken line from it, and an absent language is an
        // English call whatever the case row says.
        payload: { phone, institution, campaign: true, language: lang },
        // Hold the dial so a pre-notification SMS lands first, exactly as the
        // single-signal ingest does.
        availableInMs: leadMs,
      });
      // Routine + after-hours is still enqueued (the worker PARKS it until the
      // window opens, consuming no attempt); the campaign just reports it.
      if (afterHours) {
        counts.deferred_calling_hours++;
        results.push({ phone, outcome: "deferred_calling_hours", caseRef });
      } else {
        counts.accepted++;
        results.push({ phone, outcome: "accepted", caseRef });
      }
    } catch (err) {
      counts.failed++;
      results.push({ phone, outcome: "failed" });
      logWarn("[campaigns] recipient enqueue failed", {
        caseRef,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logInfo("[campaigns] batch enqueued", { orgId, callCategory, ...counts });
  return NextResponse.json({ ok: true, count: recipients.length, ...counts, results });
}

export async function GET() {
  return NextResponse.json({
    endpoint: "POST /api/v1/campaigns",
    purpose:
      "Batch outbound campaign ingest: enqueue a recipient list through the same durable dial queue as single-signal ingest",
    auth: "Authorization: Bearer svb_… (per-org producer key)",
    body: {
      lang: "en|ar|hi|ur|fr|sw (optional, default en)",
      callCategory: `${CATEGORIES.join(" | ")} (optional, default routine)`,
      institution: "bank | insurer (optional, default bank)",
      recipients: [{ phone: "+971… (E.164, 1..500)" }],
    },
    note: "Dial worker enforces do-not-call, calling window and the retry ladder at claim time; this route only enqueues and reports the summary.",
  });
}
