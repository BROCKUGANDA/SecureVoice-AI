import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { verifyProducerKey } from "@/lib/producer-keys";
import { isE164 } from "@/lib/twilio";
import { isAfterHours } from "@/lib/abuse/velocity";
import { createCase, transitionCase } from "@/lib/case-state-machine";
import { enqueueDialJob } from "@/lib/scale/queue";
import { PilotRefusalError, runPilotGate } from "@/lib/pilot/gate";
import { isUniqueViolation } from "@/lib/idempotency";
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
 *
 * ── The pilot gate, and why a campaign is the wrong shape for a pilot ───────
 *
 * This route used to enqueue dial jobs with no reference to pilot mode at all,
 * which made it a door straight into a live pilot: it bypassed the volume cap
 * at ingest, it bypassed the one-alert-type charter, and it created cases with
 * NO `signalKind`, which is the value the charter check reads — so a campaign
 * could dial five hundred recipients under a charter that was supposed to
 * mean one alert type. In SHADOW mode it was worse than a bypass: it created
 * cases and jobs in a phase that is defined by touching no customer, and those
 * parked jobs were dialled the moment the deployment switched to live.
 *
 * A campaign is a MARKETING shape — a list, a category, no per-recipient alert
 * type — so under a one-alert-type charter it is out of scope by
 * construction, and the gate refuses it. That is the correct answer, and it is
 * better to say so at the door than to admit a batch the pilot was not
 * chartered for.
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
  | "accepted"
  | "invalid_phone"
  | "skipped_do_not_call"
  | "deferred_calling_hours"
  | "pilot_refused"
  | "failed";

export async function POST(req: Request) {
  const rl = await consumeRateLimit("campaigns", rateLimitId(req, "campaigns"), 1, 20);
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

  // A campaign is a batch of side effects, so the retry boundary is the
  // request. Without a stable key, a client retry creates a new case and a new
  // dial job for every recipient — five hundred duplicate calls from one
  // timeout. The key is required for the same reason the single-signal ingest
  // requires one; it makes the derived case ref deterministic, and the Case
  // unique index is the race backstop behind that derivation.
  const idemKey = req.headers.get("idempotency-key")?.trim() ?? "";
  if (idemKey.length < 8) {
    return NextResponse.json(
      { ok: false, error: "Idempotency-Key header is required, min 8 characters", code: "invalid" },
      { status: 400 },
    );
  }

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
    pilot_refused: 0,
    failed: 0,
  };

  // THE PILOT GATE, before a single case is created.
  //
  // Checked ONCE for the whole batch rather than per recipient: the gate's
  // questions — "is this deployment running a pilot", "is this alert type in
  // scope", "is the day's volume spent" — are the same for every recipient on
  // the list, and a per-recipient check would issue the same database reads
  // five hundred times to learn the same answer.
  //
  // A campaign carries NO `signalKind`: it is a list, not a per-recipient
  // alert. Under a one-alert-type charter that is out of scope, and the gate
  // says so. In shadow mode the batch is accepted for RECORDING and no job is
  // created, because Phase 0 touches no customer.
  const pilot = await runPilotGate({ orgId, signalKind: null });
  if (!pilot.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: pilot.reason,
        code: pilot.code,
        stage: "pilot",
        accepted: 0,
        refused: recipients.length,
      },
      { status: 409 },
    );
  }
  if (pilot.shadow) {
    // Shadow mode: the batch is recorded for the readout and NO case, NO dial
    // job, NO SMS and NO admission slot are created. A campaign is a list, so
    // there is nothing to record per recipient either — the pilot's shadow
    // readout is about alerts, not about marketing lists.
    return NextResponse.json(
      {
        ok: true,
        count: recipients.length,
        ...counts,
        results: [],
        shadow: {
          mode: "shadow" as const,
          contacted: false,
          detail:
            "Recorded under the pilot's shadow mode. No call, no SMS, no case and no queue entry were created.",
        },
      },
      { status: 200 },
    );
  }

  // The do-not-call registry, resolved ONCE for the whole batch.
  //
  // This used to be `findUnique({ phone })` inside the loop, so a 500-recipient
  // campaign issued 500 sequential lookups on the schema's primary key — the
  // textbook N+1, invisible to review because every answer is still correct and
  // because the schema caps `recipients` at 500 rather than 5. One `IN` against
  // the same primary key is exact, not a near-miss: the column is the id, so
  // there is no scan and no row the per-recipient form would have found.
  //
  // Fail-soft, matching the per-recipient version it replaces: a registry read
  // that throws yields an empty set, and an empty set means "nothing is on the
  // registry". That is the pre-existing behaviour, and it is deliberately NOT
  // made stricter here — the dial worker re-checks at claim time regardless, so
  // this is the summary, not the control.
  let dncPhones: ReadonlySet<string> = new Set<string>();
  if (callCategory !== "time_critical_fraud") {
    const candidates = [...new Set(recipients.map((r) => r.phone?.trim() ?? "").filter(isE164))];
    if (candidates.length > 0) {
      const rows = await db.doNotCall
        .findMany({ where: { phone: { in: candidates } }, select: { phone: true } })
        .catch(() => []);
      dncPhones = new Set(rows.map((row) => row.phone));
    }
  }

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
    if (callCategory !== "time_critical_fraud" && dncPhones.has(phone)) {
      counts.skipped_do_not_call++;
      results.push({ phone, outcome: "skipped_do_not_call" });
      continue;
    }

    const afterHours = callCategory === "routine" && isAfterHours(Date.now());
    // Tenant + request + destination. Reordering the list, or a retry of the
    // same list, produces the same ref; two tenants can never collide because
    // the org is in the digest.
    const digest = createHash("sha256")
      .update(`${orgId ?? "platform"}|${idemKey}|${phone}`)
      .digest("hex")
      .slice(0, 12)
      .toUpperCase();
    const caseRef = `SV-CAMP-${digest}`;
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
        // A campaign is a list, not a per-recipient alert, so it carries no
        // signal kind. Under a one-alert-type charter that is out of scope and
        // the queue's own gate refuses it.
        signalKind: null,
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
      // The deterministic ref already exists: this recipient was accepted by
      // an earlier attempt of the SAME key. Its dial job is already durable
      // and idempotent on (case_id, attempt_no); report it as accepted rather
      // than creating a second call.
      if (isUniqueViolation(err)) {
        counts.accepted++;
        results.push({ phone, outcome: "accepted", caseRef });
        continue;
      }
      // A pilot refusal is not a failure and must not be reported as one. The
      // case may already exist (the gate at the queue refused the JOB, after
      // the case row was written) — the operator sees "pilot_refused", which
      // says the pilot said no, rather than "failed", which says something
      // broke.
      if (err instanceof PilotRefusalError) {
        counts.pilot_refused++;
        results.push({ phone, outcome: "pilot_refused", caseRef });
        logWarn("[campaigns] recipient refused by the pilot gate", {
          caseRef,
          code: err.code,
        });
        continue;
      }
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
    idempotency: "Idempotency-Key: <required, min 8 characters>",
    body: {
      lang: "en|ar|hi|ur|fr|sw (optional, default en)",
      callCategory: `${CATEGORIES.join(" | ")} (optional, default routine)`,
      institution: "bank | insurer (optional, default bank)",
      recipients: [{ phone: "+971… (E.164, 1..500)" }],
    },
    note: "Dial worker enforces do-not-call, calling window and the retry ladder at claim time; this route only enqueues and reports the summary.",
  });
}
