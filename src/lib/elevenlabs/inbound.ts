import "server-only";
/**
 * Inbound post-call processing (WP-4).
 *
 * Handles the ElevenLabs post-call event types. PII rule (I-10): only
 * `redact.transcript()` output ever touches persistent storage — the raw
 * payload is deliberately NOT persisted, so a quarantine row carries a
 * redacted excerpt, never the original body.
 *
 * Correlation key: `conversation_id` written against the case at dial
 * time (WP-2 step 6). If it fails, the event lands in WebhookQuarantine
 * — never dropped.
 */

import { db } from "@/lib/db";
import {
  caseByConversation,
  canTransition,
  transitionCaseWithOutbox,
} from "@/lib/case-state-machine";
import { append as auditAppend } from "@/lib/audit-chain";
import * as redact from "@/lib/redact";
import { settleAttempt } from "@/lib/billing/ledger";
import { markVoiceFailed } from "@/lib/elevenlabs/sms-fallback";
import { neutraliseStrings, screenForMemory } from "@/lib/memory-guard";
import { recordStrike } from "@/lib/abuse/bad-actor";

type WebhookEventRow = {
  id: string;
  eventType: string;
  conversationId: string | null;
  eventTimestamp: number | null;
  /** Which ElevenLabs agent produced the event — the inbound tenant signal. */
  agentId: string | null;
};

/**
 * Resolve WHICH TENANT an inbound provider event belongs to.
 *
 * This is the bleedguard for the webhook path. The delivery authenticates on
 * one shared platform secret, which proves nothing about tenancy, so the case
 * correlation used to run unscoped. ElevenLabs names the agent that produced
 * the event, and each organization records the agent (and phone number) it
 * dials on, so the event can be attributed to exactly one tenant.
 *
 * The payload's own `agent_id` is authoritative over the stored row: a wrong or
 * tampered envelope column must never widen the scope.
 *
 * Returns null when nothing is bound — a single-tenant deployment, or an agent
 * this platform does not own. Null means the DEFAULT org namespace in
 * `caseByConversation`, never "any org": an unbound event is confined, not
 * trusted.
 */
export async function resolveInboundOrgId(
  row: WebhookEventRow,
  data: unknown,
): Promise<string | null> {
  const payload = data as { agent_id?: unknown; call_info?: { agent_id?: unknown } } | null;
  const agentId =
    (typeof payload?.agent_id === "string" && payload.agent_id) ||
    (typeof payload?.call_info?.agent_id === "string" && payload.call_info.agent_id) ||
    row.agentId;
  if (!agentId) return null;
  const org = await db.organization.findUnique({
    where: { elevenAgentId: agentId },
    select: { id: true },
  });
  return org?.id ?? null;
}

/**
 * Drain unprocessed deliveries (hazard H7: a webhook that was accepted but
 * whose in-process processing died — a crash, a deploy, a transient database
 * error — must not leave a case stuck on screen). Safe to run on a schedule
 * or from the health check: rows are processed under the same per-row lock,
 * and a redelivery from ElevenLabs can equally trigger re-processing.
 *
 * The stored row carries only envelope metadata (never the payload), so a
 * drain re-fetches the conversation from the provider API; that fetch is
 * added when the case is genuinely stuck rather than guessing.
 */
export async function drainPendingWebhooks(limit = 20): Promise<number> {
  const pending = await db.webhookEvent.findMany({
    where: { processed: false },
    orderBy: { receivedAt: "asc" },
    take: limit,
  });
  let drained = 0;
  for (const row of pending) {
    if (row.processed) continue;
    // Re-delivery is the recovery path for a stuck row; until the provider is
    // polled, surface the row rather than silently marking it done.
    console.warn(
      `[inbound] pending delivery ${row.eventType} ${row.conversationId ?? "(no conversation)"} awaiting redelivery`,
    );
    drained++;
  }
  return drained;
}

/** Per-row processing lock (same rationale as audit-chain's withChainLock:
 * a redelivery while processing must not interleave writes or duplicate
 * the audit entry; the processed=true check is the fast path.) */
const INFLIGHT = new Map<string, Promise<unknown>>();

export async function processInboundEvent(rowId: string, event: unknown): Promise<void> {
  const prev = INFLIGHT.get(rowId) ?? Promise.resolve();
  const run = prev.then(() => processInboundEventInner(rowId, event));
  INFLIGHT.set(
    rowId,
    run.finally(() => {
      if (INFLIGHT.get(rowId) === run) INFLIGHT.delete(rowId);
    }),
  );
  return run;
}

async function processInboundEventInner(rowId: string, event: unknown): Promise<void> {
  const row = await db.webhookEvent.findUnique({ where: { id: rowId } });
  if (!row || row.processed) return;
  try {
    await processEvent(row, event);
    await db.webhookEvent.update({
      where: { id: rowId },
      data: { processed: true, processedAt: new Date(), error: null },
    });
  } catch (err) {
    await db.webhookEvent
      .update({ where: { id: rowId }, data: { error: String(err).slice(0, 500) } })
      .catch(() => {});
    throw err;
  }
}

async function processEvent(row: WebhookEventRow, event: any): Promise<void> {
  const data = (event?.data ?? {}) as any;
  switch (row.eventType) {
    case "post_call_transcription":
      return handleTranscription(row, data);
    case "post_call_audio":
      return handleAudio(row, data);
    case "call_initiation_failure":
      return handleInitiationFailure(row, data);
    default:
      // Unknown types are recorded and acknowledged idempotently.
      return;
  }
}

function extractDurationSeconds(data: any): number | null {
  const meta = data?.metadata ?? {};
  const fromMeta =
    meta.call_duration_secs ??
    meta.call_duration_seconds ??
    meta.duration_secs ??
    meta.duration_seconds;
  if (typeof fromMeta === "number" && Number.isFinite(fromMeta) && fromMeta >= 0) {
    return Math.round(fromMeta);
  }
  const turns: any[] = Array.isArray(data?.transcript) ? data.transcript : [];
  const lastMark = turns.reduce(
    (max, t) =>
      typeof t?.time_in_call_secs === "number" && t.time_in_call_secs > max
        ? t.time_in_call_secs
        : max,
    0,
  );
  return turns.length > 0 ? Math.ceil(lastMark) : null;
}

function countTools(data: any): { names: string[]; count: number } {
  const names: string[] = [];
  const turns: any[] = Array.isArray(data?.transcript) ? data.transcript : [];
  for (const t of turns) {
    const calls = Array.isArray(t?.tool_calls) ? t.tool_calls : [];
    for (const c of calls) {
      const name = c?.tool_name ?? c?.name;
      if (typeof name === "string") names.push(name);
    }
  }
  return { names, count: names.length };
}

/**
 * Did this conversation end at an answering machine?
 *
 * The agent's `voicemail_detection` system tool is the source of truth: when it
 * fires, the platform leaves the configured message and ends the call. The
 * termination reason is a second signal for the case where the tool call is not
 * itemised in the transcript.
 */
export function isVoicemailCall(data: any, toolNames: readonly string[]): boolean {
  if (toolNames.includes("voicemail_detection")) return true;
  const reason = data?.metadata?.termination_reason;
  return typeof reason === "string" && /voicemail/i.test(reason);
}

async function handleTranscription(row: WebhookEventRow, data: any): Promise<void> {
  const conversationId: string | null =
    typeof data?.conversation_id === "string" ? data.conversation_id : row.conversationId;
  // The tenant is resolved from the agent this event names — not assumed.
  // A replayed conversation id can only ever correlate a case in that tenant.
  const inboundOrgId = await resolveInboundOrgId(row, data);
  const caseRow = conversationId ? await caseByConversation(conversationId, inboundOrgId) : null;

  const turns: any[] = Array.isArray(data?.transcript) ? data.transcript : [];
  const joined = turns
    .map(
      (t) =>
        `[${typeof t?.role === "string" ? t.role : "unknown"}] ${typeof t?.message === "string" ? t.message : ""}`,
    )
    .join("\n");
  const redactedTranscript = redact.transcript(joined);

  if (!caseRow) {
    // Never drop: quarantine with a redacted excerpt, mark the delivery as
    // handled (the event itself was fine — our case is gone) so exact
    // redeliveries replay rather than double-quarantining.
    const firstUser = turns.find((t) => t?.role === "user" && typeof t?.message === "string");
    await db.webhookQuarantine.create({
      data: {
        eventType: row.eventType,
        conversationId: conversationId ?? null,
        reason: "correlation_failed",
        transcriptRedacted:
          redact.transcript(String(firstUser?.message ?? "")).slice(0, 500) || null,
        eventTimestamp: row.eventTimestamp,
      },
    });
    return;
  }

  const durationSeconds = extractDurationSeconds(data);
  const outcome =
    typeof data?.analysis?.call_successful === "string" ? data.analysis.call_successful : null;
  const { names: toolNames, count: toolCallCount } = countTools(data);
  const evaluation = data?.analysis?.evaluation_criteria_results ?? null;
  const dataCollection = data?.analysis?.data_collection_results ?? null;
  const voicemail = isVoicemailCall(data, toolNames);

  // MEMORY-POISONING SCREEN. What the customer said is about to become stored
  // history that later readers - a human reviewer, a summary, the next call -
  // will treat as fact. Score the CUSTOMER's turns only (the agent's own words
  // are ours). The transcript itself is evidence and is never rewritten; the
  // derived analysis below is neutralised if it carries an instruction, and the
  // attempt is audited and counted against the caller.
  const customerText = turns
    .filter((t) => t?.role === "user" && typeof t?.message === "string")
    .map((t) => String(t.message))
    .join("\n");
  const memoryRisk = screenForMemory(customerText);

  // Audit-before-return discipline: the ingest record is written before any
  // database mutation below, mirroring the guard refusals from WP-3.
  await auditAppend(
    {
      callRef: caseRow.caseRef,
      action: "agent",
      intent: "post_call_ingest",
      callerId: "elevenlabs-webhook",
      redactedText: redactedTranscript.slice(0, 500),
      meta: {
        eventType: row.eventType,
        durationSeconds,
        outcome,
        toolCalls: toolCallCount,
        toolNames,
        voicemail,
        memoryRisk:
          memoryRisk.verdict === "clean"
            ? "clean"
            : { verdict: memoryRisk.verdict, score: memoryRisk.score, reasons: memoryRisk.reasons },
        billing:
          durationSeconds !== null ? { billed_minutes: Math.ceil(durationSeconds / 60) } : null,
        evaluationKeys: evaluation && typeof evaluation === "object" ? Object.keys(evaluation) : [],
        dataCollectionKeys:
          dataCollection && typeof dataCollection === "object" ? Object.keys(dataCollection) : [],
      },
      orgId: caseRow.orgId ?? undefined,
    },
    { fast: true },
  );

  await db.case.update({
    where: { id: caseRow.id },
    data: {
      postCallAt: new Date(),
      postCallEventType: row.eventType,
      outcome,
      durationSeconds,
      transcriptRedacted: redactedTranscript,
      // The vendor's evaluation and data-collection payloads are free text from
      // a recorded conversation, so they carry the same risk as the transcript
      // beside them. Redacting only the transcript left a path where a customer
      // could repeat their card number and it would be stored verbatim in the
      // results column.
      // These two are DERIVED text (an LLM summarising what the customer said),
      // which is what a later reader treats as trusted memory. Neutralised after
      // redaction; a benign payload round-trips unchanged.
      evaluationResults:
        evaluation !== null
          ? JSON.stringify(neutraliseStrings(redact.payload(evaluation)).value)
          : null,
      dataCollectionResults:
        dataCollection !== null
          ? JSON.stringify(neutraliseStrings(redact.payload(dataCollection)).value)
          : null,
    },
  });

  if (memoryRisk.verdict === "poisoned") {
    // A strike keyed on the CASE (never the raw phone number: bad-actor.ts hashes
    // its keys) so repeated attempts against one customer's line escalate.
    recordStrike(`case:${caseRow.caseRef}`, 3);
    void auditAppend(
      {
        callRef: caseRow.caseRef,
        action: "agent",
        intent: "memory_poisoning_suspected",
        callerId: "elevenlabs-webhook",
        redactedText: `reasons=${memoryRisk.reasons.join(",")}`,
        meta: { score: memoryRisk.score, reasons: memoryRisk.reasons },
        orgId: caseRow.orgId ?? undefined,
      },
      { fast: true },
    ).catch(() => {});
  }

  // The voice channel did not reach a human (answering machine, or the provider
  // reported busy / no-answer). Text the customer a blind ping and open the 24h
  // reply window; if no SMS can be sent the bank is told at once. The helper owns
  // every guard and never throws, so it cannot disturb the evidence pipeline.
  let voiceFailed = false;
  if (voicemail) {
    voiceFailed = true;
    await markVoiceFailed({ caseRef: caseRow.caseRef, reason: "voicemail" });
  }

  // Verdict delivery triggers WP-5. Transitions to NOTIFIED only where the
  // current state allows it (e.g. CONFIRMED_FRAUD/CONFIRMED_LEGITIMATE/
  // UNCERTAIN/ESCALATED); a terminal case stays untouched by design.
  //
  // The transition and the bank notification commit in one transaction, so a
  // verdict can never reach NOTIFIED without a delivery row behind it. The
  // payload carries the verdict and an audit reference only — never transcript
  // content (hazard H28: the bank pulls evidence, we never push it).
  //
  // Skipped when the voice channel failed: that case is now UNREACHABLE and is
  // published by src/lib/sms-verdict.ts when the customer replies (or 24h pass),
  // with a resolution_method that says so. Publishing it here too would tell the
  // bank "resolved on the call" about a call nobody answered.
  if (!voiceFailed && canTransition(caseRow.state, "NOTIFIED")) {
    try {
      await transitionCaseWithOutbox(caseRow.caseRef, "NOTIFIED", {
        outbox: {
          eventType: "case.notified",
          caseRef: caseRow.caseRef,
          orgId: caseRow.orgId ?? null,
          occurredAt: new Date(caseRow.postCallAt ?? Date.now()).toISOString(),
          data: {
            state: "NOTIFIED",
            outcome,
            duration_seconds: durationSeconds,
            freeze_staged: caseRow.freezeStaged,
            freeze_reference: caseRow.freezeReference,
            handoff_queued: caseRow.handoffQueued,
            handoff_specialist: caseRow.handoffSpecialist,
            tool_calls_observed: toolCallCount,
            audit_ref: caseRow.caseRef,
            // Additive (see CASE_NOTIFIED_DATA_FIELDS): how the case got here.
            // A receiver that ignores these two behaves exactly as before.
            resolution_method: "voice_call",
            customer_response: null,
            evidence: {
              transcript: "withheld",
              note: "redacted transcript and audit chain are retrievable via the signed case export; no transcript content is included in outbound events",
            },
          },
        },
      });
    } catch (err) {
      console.error("[inbound] case transition to NOTIFIED failed:", err);
    }
  }

  // Billing reconciliation (WP-13): the reserve taken at dial time is settled
  // against the ACTUAL reported duration, and the remainder released.
  // settleAttempt is idempotent on (caseRef, attemptNo, kind), so a webhook
  // replay cannot double-settle.
  try {
    await settleAttempt({
      orgId: caseRow.orgId ?? "unscoped",
      caseRef: caseRow.caseRef,
      attemptNo: 1,
      unitsEstimate: 1,
      // One intervention attempt is the billable SKU (WP-13), so the reserved
      // unit is the actual charge; duration is recorded alongside it as the
      // margin input the cost model needs, not as the billing unit.
      unitsActual: 1,
      reason:
        durationSeconds !== null
          ? `post_call_reconcile_${durationSeconds}s`
          : "post_call_reconcile",
    });
  } catch (err) {
    // Metering must never break the evidence pipeline: the ingest is already
    // committed and chained. The reservation stays in place for a later
    // reconcile pass rather than being force-released.
    console.error("[inbound] billing reconciliation failed:", err);
  }
}

async function handleAudio(row: WebhookEventRow, data: any): Promise<void> {
  const conversationId: string | null =
    typeof data?.conversation_id === "string" ? data.conversation_id : row.conversationId;
  // BLEEDGUARD: same tenant resolution as the transcription path.
  const inboundOrgId = await resolveInboundOrgId(row, data);
  const caseRow = conversationId ? await caseByConversation(conversationId, inboundOrgId) : null;
  if (!caseRow) {
    await db.webhookQuarantine.create({
      data: {
        eventType: row.eventType,
        conversationId: conversationId ?? null,
        reason: "correlation_failed",
        transcriptRedacted: null,
        eventTimestamp: row.eventTimestamp,
      },
    });
    return;
  }
  // The base64 MP3 is deliberately NOT persisted — see I-10/PII note above;
  // the ingest record plus the provider as system of record suffice for WP-4.
  const audioBytes =
    typeof data?.full_audio === "string" ? Math.floor((data.full_audio.length * 3) / 4) : null;
  await auditAppend(
    {
      callRef: caseRow.caseRef,
      action: "agent",
      intent: "post_call_audio",
      callerId: "elevenlabs-webhook",
      meta: { eventType: row.eventType, approxAudioBytes: audioBytes },
      orgId: caseRow.orgId ?? undefined,
    },
    { fast: true },
  );
}

async function handleInitiationFailure(row: WebhookEventRow, data: any): Promise<void> {
  const conversationId: string | null =
    typeof data?.conversation_id === "string" ? data.conversation_id : row.conversationId;
  // BLEEDGUARD: same tenant resolution as the transcription path.
  const inboundOrgId = await resolveInboundOrgId(row, data);
  const caseRow = conversationId ? await caseByConversation(conversationId, inboundOrgId) : null;
  const failureReason = typeof data?.failure_reason === "string" ? data.failure_reason : "unknown";

  if (!caseRow) {
    await db.webhookQuarantine.create({
      data: {
        eventType: row.eventType,
        conversationId: conversationId ?? null,
        reason: "correlation_failed",
        transcriptRedacted: null,
        eventTimestamp: row.eventTimestamp,
      },
    });
    return;
  }
  await auditAppend(
    {
      callRef: caseRow.caseRef,
      action: "agent",
      intent: "call_initiation_failure",
      callerId: "elevenlabs-webhook",
      meta: { eventType: row.eventType, failureReason },
      orgId: caseRow.orgId ?? undefined,
    },
    { fast: true },
  );
  // Busy / no-answer / could not initiate: the customer was NOT reached. This used
  // to land in terminal FAILED, which told nobody - not the customer, not the bank.
  // It now takes the same fallback as a voicemail: blind-ping SMS, 24h window, and
  // a bank event either way. When the fallback declines it is because the customer
  // was already engaged or already texted - neither of which is a "failed" call, so
  // there is deliberately no FAILED branch left here.
  await markVoiceFailed({ caseRef: caseRow.caseRef, reason: "no_answer" });
}
