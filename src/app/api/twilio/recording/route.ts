import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { append as auditAppend } from "@/lib/audit-chain";
import { consume as consumeRateLimit, rateLimitId } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { storeRecording } from "@/lib/storage/recordings";
import { storageConfigured } from "@/lib/storage/s3";
import { downloadRecording, twilioSignedUrl, verifyTwilioSignature } from "@/lib/twilio";
import { logError } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

const EMPTY = `<?xml version="1.0" encoding="UTF-8"?><Response/>`;

function accepted(): NextResponse {
  return new NextResponse(EMPTY, { headers: { "Content-Type": "text/xml; charset=utf-8" } });
}

/**
 * POST /api/twilio/recording — the completed-recording callback for the
 * media-stream plane.
 *
 * `placeInterventionCall` sets `Record`, `RecordingStatusCallback` and
 * `RecordingStatusCallbackEvent=completed` only when object storage is
 * configured. This route verifies Twilio's signature, correlates the call leg
 * to its case, downloads the provider's MP3 with the platform's own
 * credentials, and stores it under the tenant-scoped recording key. Every
 * outcome is written to the audit chain; audio bytes are never logged.
 *
 * The callback is intentionally idempotent at the storage layer: a redelivery
 * writes the same key, so a retry cannot create a second tenant object. The
 * audit row for a replay is still appended, because "Twilio retried" is an
 * operational fact a reviewer may need.
 */
export async function POST(req: NextRequest) {
  let params: Record<string, string>;
  try {
    const form = await req.formData();
    params = {};
    form.forEach((v, k) => {
      params[k] = String(v);
    });
  } catch {
    return new NextResponse(EMPTY, { status: 400 });
  }

  if (
    verifyTwilioSignature(twilioSignedUrl(req), params, req.headers.get("x-twilio-signature")) !==
    true
  ) {
    return new NextResponse(EMPTY, { status: 403 });
  }

  const rl = await consumeRateLimit(
    "twilio-recording",
    rateLimitId(req, "twilio-recording"),
    1,
    30,
  );
  if (!rl.ok) return accepted();

  const callSid = params.CallSid?.trim() ?? "";
  const recordingUrl = params.RecordingUrl?.trim() ?? "";
  const status = params.RecordingStatus?.trim() ?? "";
  // Twilio may send in-progress callbacks if a deployment adds them; only a
  // completed recording is a durable object worth fetching.
  if (status !== "completed" || !callSid || !recordingUrl) return accepted();

  let caseRow: { caseRef: string; orgId: string | null; conversationId: string | null } | null =
    null;
  try {
    caseRow = await db.case.findFirst({
      where: { callSid },
      select: { caseRef: true, orgId: true, conversationId: true },
    });
  } catch (err) {
    logError("[twilio-recording] case lookup failed", {
      callSid,
      error: err instanceof Error ? err.message : String(err),
    });
    return accepted();
  }

  if (!caseRow?.orgId) {
    await auditAppend({
      callRef: caseRow?.caseRef ?? `TWILIO-REC-${callSid}`,
      action: "handoff",
      intent: "recording_not_stored",
      callerId: "twilio-recording",
      meta: { reason: "case_or_org_unresolved", callSid },
      ...(caseRow?.orgId ? { orgId: caseRow.orgId } : {}),
    }).catch(() => {});
    return accepted();
  }

  if (!storageConfigured()) {
    await auditAppend({
      callRef: caseRow.caseRef,
      action: "handoff",
      intent: "recording_not_stored",
      callerId: "twilio-recording",
      meta: { reason: "storage_not_configured", callSid },
      orgId: caseRow.orgId,
    }).catch(() => {});
    return accepted();
  }

  const downloaded = await downloadRecording(recordingUrl);
  if (!downloaded.ok) {
    await auditAppend({
      callRef: caseRow.caseRef,
      action: "handoff",
      intent: "recording_download_failed",
      callerId: "twilio-recording",
      meta: { reason: downloaded.error, callSid },
      orgId: caseRow.orgId,
    }).catch(() => {});
    return accepted();
  }

  const stored = await storeRecording({
    orgId: caseRow.orgId,
    conversationId: caseRow.conversationId ?? caseRow.caseRef,
    audio: downloaded.audio,
    contentType: downloaded.contentType,
  });

  await auditAppend({
    callRef: caseRow.caseRef,
    action: "handoff",
    intent: stored.ok ? "recording_archived" : "recording_store_failed",
    callerId: "twilio-recording",
    meta: {
      callSid,
      bytes: downloaded.audio.length,
      ...(stored.ok ? { key: stored.key } : { reason: stored.error }),
    },
    orgId: caseRow.orgId,
  }).catch(() => {});

  return accepted();
}
