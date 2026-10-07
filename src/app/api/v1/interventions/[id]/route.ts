import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { verifyProducerKey } from "@/lib/producer-keys";
import { consume as consumeRateLimit } from "@/lib/ratelimit";
import { append as auditAppend } from "@/lib/audit-chain";
import { gatewayFailure, gatewayJson } from "@/lib/gateway";

export const dynamic = "force-dynamic";

/**
 * GET /v1/interventions/{caseRef} - the PULL half of the bank contract.
 *
 * Banks that cannot accept inbound webhooks (a firewall that drops them, a
 * receiver that is down for a weekend) poll here instead. It is also the
 * evidence channel: the outbound event deliberately carries no transcript
 * (`transcript: "withheld"`), so a bank that needs one pulls it, authenticated,
 * from here - which also leaves an audit row saying who asked.
 *
 *   Authorization: Bearer svb_...        (a producer key; the key names the tenant)
 *   GET /v1/interventions/SV-F-7K2M9Q
 *   GET /v1/interventions/SV-F-7K2M9Q?include=transcript
 *
 * TENANCY: the case is looked up by (caseRef, the KEY's org). A case that does
 * not exist and a case that belongs to another institution return the SAME 404,
 * so the endpoint cannot be used to learn which references exist elsewhere.
 *
 * Reachable publicly as /v1/interventions/{id}: Caddy's gateway block rewrites it
 * to this route.
 */

const CASE_REF = /^SV-F-[A-Z0-9]{6}$/;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const bearer = req.headers.get("authorization");
  const auth = await verifyProducerKey(
    bearer?.startsWith("Bearer ") ? bearer.slice("Bearer ".length) : null,
  );
  if (!auth.ok) {
    return gatewayFailure("unauthenticated", req, { detail: "producer key is invalid or revoked" });
  }

  // Per-key budget, so a polling loop cannot become the rate limiter of our
  // database. Generous: polling every 10s for a day is 8,640 requests.
  const rl = consumeRateLimit("pull", auth.callerId, 1, 10_000);
  if (!rl.ok)
    return gatewayFailure("rate_limited", req, {
      retryAfterSec: Math.ceil(rl.retryAfterMs / 1000),
    });

  const { id } = await ctx.params;
  if (!CASE_REF.test(id)) {
    // Same code as "not found": a malformed reference is not a different answer.
    return gatewayFailure("not_found", req);
  }

  const row = await db.case.findFirst({
    where: { caseRef: id, orgId: auth.orgId },
    select: {
      caseRef: true,
      state: true,
      signalKind: true,
      language: true,
      outcome: true,
      resolutionMethod: true,
      customerResponse: true,
      freezeStaged: true,
      freezeReference: true,
      handoffQueued: true,
      handoffSpecialist: true,
      smsSentAt: true,
      postCallAt: true,
      durationSeconds: true,
      createdAt: true,
      updatedAt: true,
      transcriptRedacted: true,
      erasedAt: true,
    },
  });
  if (!row) return gatewayFailure("not_found", req);

  const wantsTranscript = req.nextUrl.searchParams.get("include") === "transcript";

  const body: Record<string, unknown> = {
    case_ref: row.caseRef,
    state: row.state,
    // Same vocabulary as the outbound `case.notified` event, so a poller and a
    // webhook receiver can share one parser.
    resolution_method: row.resolutionMethod,
    customer_response: row.customerResponse,
    outcome: row.outcome,
    signal_kind: row.signalKind,
    language: row.language,
    freeze_staged: row.freezeStaged,
    freeze_reference: row.freezeReference,
    handoff_queued: row.handoffQueued,
    handoff_specialist: row.handoffSpecialist,
    duration_seconds: row.durationSeconds,
    sms_sent_at: row.smsSentAt?.toISOString() ?? null,
    post_call_at: row.postCallAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    // Terminal means "the bank has been told", i.e. a poller can stop.
    terminal: row.state === "NOTIFIED" || row.state === "CLOSED",
    evidence: {
      transcript: wantsTranscript ? "included" : "available_with_include=transcript",
    },
  };

  if (wantsTranscript) {
    // Stored REDACTED (PAN, phone, email, OTP stripped before storage), and an
    // erased case (right-to-erasure) has no transcript to give.
    body.transcript_redacted = row.erasedAt ? null : row.transcriptRedacted;
    body.erased = Boolean(row.erasedAt);
    // Evidence leaving the platform is an auditable event: who pulled what.
    await auditAppend(
      {
        callRef: row.caseRef,
        action: "agent",
        intent: "evidence_pulled",
        callerId: auth.callerId,
        redactedText: "transcript pulled via v1 API",
        meta: { keyId: auth.keyId, via: "GET /v1/interventions/{id}" },
        orgId: auth.orgId ?? undefined,
      },
      { fast: true },
    ).catch(() => {});
  }

  return gatewayJson(body, req);
}
