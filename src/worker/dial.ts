/**
 * Dial worker — the runnable loop around src/lib/scale/queue.ts.
 *
 * The queue module owns the semantics (SKIP LOCKED claiming, lease expiry,
 * bounded attempts, the dead-letter state). This file owns only the loop and
 * the side effect: turning a claimed job into a call.
 *
 * It runs as its own compose service rather than inside the web app, so a hung
 * carrier call never occupies an HTTP request and killing the web tier does not
 * stop fraud interventions. Scaling out is safe by construction — claiming uses
 * FOR UPDATE SKIP LOCKED — so `--scale dial-worker=3` needs no coordination.
 *
 * One-shot drain (useful in CI and for an operator flushing after an incident):
 *   bun src/worker/dial.ts --once
 */
// NOTE: deliberately NO `import "server-only"` here. That marker exists so the
// Next bundler fails loudly if a client component reaches server code; this file
// is a standalone Bun process outside any bundle, where the package only throws
// and prevents the worker from starting at all. The imports below are all
// server-only modules and are never reachable from a client bundle.

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

import { drainDialQueue, type DialJob, type DialOutcome } from "@/lib/scale/queue";
import { placeOutboundCall } from "@/lib/elevenlabs/outbound-call";
import { placeInterventionCall } from "@/lib/twilio";
import { append as auditAppend } from "@/lib/audit-chain";
import { db } from "@/lib/db";
import { transitionCase } from "@/lib/case-state-machine";
import { markVoiceFailed } from "@/lib/elevenlabs/sms-fallback";
import { getInstitutionContext, getTelecomIdentity } from "@/lib/institution";
import { recordTelecomEvent } from "@/lib/telecom-outbox";
import { asCallCategory } from "@/lib/call-categories";
import { isAfterHours, nextBusinessHoursStart } from "@/lib/abuse/velocity";
import { sweepExpiredSmsCases } from "@/lib/sms-verdict";
import { logError, logInfo, logWarn } from "@/lib/validation/safe-log";
import { flag } from "@/lib/flags";
import { SUPPORTED_LANGS } from "@/lib/languages";
import type { DeliveryLang } from "@/lib/twilio";

const WORKER_ID =
  process.env.DIAL_WORKER_ID ?? `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const POLL_MS = Number(process.env.DIAL_WORKER_POLL_MS ?? 1_000);
const BATCH = Number(process.env.DIAL_WORKER_BATCH ?? 5);
const LEASE_MS = Number(process.env.DIAL_WORKER_LEASE_MS ?? 60_000);
const ONCE = process.argv.includes("--once");

type JobPayload = {
  to?: string;
  phone?: string;
  language?: string;
  merchant?: string;
  amount?: number;
  currency?: string;
  transaction_ref?: string;
};

/**
 * Resolve whatever the bank sent (`en`, `ar-AE`, `es_MX`) to a language the
 * voice tables actually have.
 *
 * The dialect subtag is deliberately honoured: `ar-AE` must speak Arabic. It is
 * better to answer a Gulf customer in MSA than in English, and the previous
 * cast let an unknown-but-Arabic tag fall through to an English script without
 * a word of complaint. An unresolvable tag is logged, because the customer
 * cannot tell which language they were dialled in but the audit record can.
 */
export function resolveDeliveryLang(requested?: string | null): DeliveryLang {
  const raw = (requested ?? "").trim().toLowerCase();
  if (!raw) return "en";
  const exact = (SUPPORTED_LANGS as readonly string[]).includes(raw);
  if (exact) return raw as DeliveryLang;
  const base = raw.split(/[-_]/)[0] ?? "";
  if ((SUPPORTED_LANGS as readonly string[]).includes(base)) return base as DeliveryLang;
  logWarn("[dial-worker] no voice for requested language, dialling in en", {
    requested: raw.slice(0, 20),
  });
  return "en";
}

function parsePayload(job: DialJob): JobPayload {
  try {
    const v = JSON.parse(job.payload) as unknown;
    return v && typeof v === "object" ? (v as JobPayload) : {};
  } catch {
    return {};
  }
}

/**
 * Place one call.
 *
 * The recovery check comes first and is the part that matters: if the case
 * already carries a conversation id, a previous worker placed this call and died
 * before recording it. Dialling again would call a customer who is already on
 * the phone with us — the one failure the queue's unique index cannot prevent
 * on its own, because the provider accepted the call outside our transaction.
 */
async function handle(job: DialJob): Promise<DialOutcome> {
  const payload = parsePayload(job);

  const existing = await db.case.findFirst({
    where: { caseRef: job.case_ref },
    select: {
      id: true,
      conversationId: true,
      state: true,
      phone: true,
      signalKind: true,
      callCategory: true,
    },
  });
  if (existing?.conversationId) {
    // Already placed by a worker that died before writing it down.
    return { ok: true };
  }

  // The destination comes from the Case row, never from the job payload.
  //
  // The payload's `to` is written as `redactText(signal.phone)` on the ingest
  // path, so it reads "[REDACTED]" — correct for an audit/display field and
  // fatal for a dial instruction. Trusting it sends "[REDACTED]" to the
  // telephony provider, which dry-run mode cannot detect because
  // `placeOutboundCall` returns a synthetic conversation id without ever
  // looking at the number. The plaintext destination already lives on the case
  // row, which is the one place it is legitimately stored.
  const to = existing?.phone ?? payload.phone;
  if (!to) {
    return { ok: false, error: "case row has no destination phone", retryable: false };
  }
  if (!/^\+[1-9]\d{6,14}$/.test(to)) {
    // Fail closed rather than dial a redaction placeholder or a mangled number:
    // a wrong destination here means an unrelated customer gets a fraud call.
    return {
      ok: false,
      error: `destination is not a valid E.164 number: ${to.slice(0, 4)}`,
      retryable: false,
    };
  }

  try {
    // Category preconditions run HERE, at the authoritative dial moment — not
    // only at ingest — because a job accepted at 19:59 with a lead delay can
    // lawfully claim at 20:01. The case row's category is the one source of
    // truth; nothing in the job payload can re-declare it.
    const category = asCallCategory(existing?.callCategory);

    // Do-not-call registry: blocks every non-critical category. Time-critical
    // fraud verification is consent-record-backed and in the customer's
    // interest, so it is deliberately not gated on the registry (the ingest
    // consent gate still applies to it).
    if (category !== "time_critical_fraud") {
      const dnc = await db.doNotCall.findUnique({ where: { phone: to } });
      if (dnc) {
        void auditAppend({
          callRef: job.case_ref,
          action: "freeze",
          intent: "dial_refused_do_not_call",
          callerId: WORKER_ID,
          meta: { jobId: job.id, reason: dnc.reason, category },
          orgId: job.org_id ?? undefined,
        }).catch(() => {});
        return { ok: false, error: "destination is on the do-not-call registry", retryable: false };
      }
    }

    // Routine calls are lawful only inside the permitted calling window. The
    // job is PARKED until the window opens (no attempt consumed) instead of
    // climbing the retry ladder into the middle of the night.
    if (category === "routine" && isAfterHours(Date.now())) {
      const wakeAt = nextBusinessHoursStart(Date.now());
      void auditAppend({
        callRef: job.case_ref,
        action: "handoff",
        intent: "dial_deferred_calling_hours",
        callerId: WORKER_ID,
        meta: { jobId: job.id, category, wakeAt: new Date(wakeAt).toISOString() },
        orgId: job.org_id ?? undefined,
      }).catch(() => {});
      return {
        ok: false,
        error: "outside permitted calling hours; deferred",
        retryable: true,
        retryAfterMs: wakeAt - Date.now(),
      };
    }

    // A bank says "your card", an insurer says "your policy". Resolved per tenant,
    // and a lookup fault falls back to the default rather than blocking the call.
    const institution = await getInstitutionContext(job.org_id);

    // The tenant's OWN telecom surface, resolved strictly. A fault fails the job
    // for retry instead of dialling on the platform's line: "we cannot read whose
    // number this is" must never be answered by guessing, because the customer
    // cannot tell the difference and the bank can.
    let telecom;
    try {
      telecom = await getTelecomIdentity(job.org_id);
    } catch {
      return {
        ok: false,
        error: "tenant telecom identity lookup failed — refusing to dial on the platform number",
        retryable: true,
      };
    }

    // Both planes must report the truth about the carrier. `placeOutboundCall`
    // throws on failure; `placeInterventionCall` RETURNS one, so the ok flag has
    // to be read here or a refused call becomes a recorded successful dial.
    let result: {
      conversationId: string | null;
      callSid?: string | null;
      dryRun: boolean;
      phoneNumberId?: string | null;
      fromPhone: string;
      providerSid?: string | null;
      // True when the send path already wrote the telecom outbox row itself.
      outboxWritten: boolean;
    };
    if (flag("twilioMediaStreams")) {
      const host = process.env.SITE_ADDRESS ?? "localhost";
      // Worker plane lives on a SIBLING prefix under /realtime, not under /api:
      // an edge matcher on /api/voice-websocket would shadow the app's own
      // Next.js route of that name out of its per-route rate limiting. Caddy
      // routes /realtime/media-stream here (see Caddyfile + Caddyfile.platform).
      const mediaStreamUrl = new URL(`wss://${host}/realtime/media-stream`);
      mediaStreamUrl.searchParams.set("callSid", job.case_ref);
      // The language travels on the stream URL. The voice worker needs it for
      // FOUR independent decisions — ASR model, TTS voice, TTS model, and the
      // wording of every line it speaks — and none of them can be inferred from
      // the audio before the first turn arrives.
      //
      // Omitting this silently produced an English agent calling an Urdu-speaking
      // customer: ASR pinned to English, answered with an English voice, and
      // English script read aloud on a call the bank asked to run in the
      // customer's own language. `resolveDeliveryLang` is used rather than the
      // raw payload so an unsupported code degrades to `en` HERE too, matching
      // what the voice worker would do — two different fallbacks for the same
      // field is how a call ends up with English ASR and an Urdu voice.
      mediaStreamUrl.searchParams.set("lang", resolveDeliveryLang(payload.language));
      const dial = await placeInterventionCall({
        to,
        lang: resolveDeliveryLang(payload.language),
        amount: payload.amount?.toString(),
        merchant: payload.merchant,
        callRef: job.case_ref,
        orgId: job.org_id,
        caseId: existing?.id ?? null,
        mediaStreamUrl: mediaStreamUrl.toString(),
        // The tenant's own declaration decides whether Islamic terminology is
        // substituted. Resolved here, at the layer that already reads the
        // organisation, rather than inside the transport.
        speech: { shariahCompliant: institution.shariahCompliant },
      });
      if (!dial.ok) {
        throw new Error(`twilio dial refused (status ${dial.status}): ${dial.error}`);
      }
      result = {
        // The app-side conversation key is the case ref — the same value the
        // media-stream socket is opened with. `callSid` is the carrier's call
        // leg, which is what warm_transfer rewrites. They are not the same
        // thing and one cannot stand in for the other.
        conversationId: job.case_ref,
        callSid: dial.sid,
        dryRun: false,
        // The caller ID on the customer's handset is the Twilio DID, not an
        // ElevenLabs phone id.
        phoneNumberId: null,
        providerSid: dial.sid,
        fromPhone: dial.from ?? "platform_default",
        outboxWritten: true,
      };
    } else {
      const outbound = await placeOutboundCall({
        toNumber: to,
        language: payload.language ?? "en",
        merchant: payload.merchant ?? undefined,
        amount: payload.amount ?? undefined,
        currency: payload.currency ?? undefined,
        caseRef: job.case_ref,
        institution: institution.type,
        institutionName: institution.name,
        callCategory: category,
        // The tenant's bound DID when it has one — the caller ID on the customer's
        // handset. Null means the tenant has brought no number and the deployment
        // default speaks, which is an explicitly configured state, not a fallback.
        phoneNumberId: telecom.elevenPhoneNumberId,
        dynamicVariables: {
          case_id: job.case_id,
          case_ref: job.case_ref,
          merchant: payload.merchant ?? "",
          amount: payload.amount ?? 0,
          currency: payload.currency ?? "",
          transaction_ref: payload.transaction_ref ?? "",
          signal_kind: existing?.signalKind ?? "",
        },
      });
      result = {
        conversationId: outbound.conversationId,
        callSid: outbound.callSid,
        dryRun: outbound.dryRun,
        phoneNumberId: outbound.phoneNumberId,
        providerSid: outbound.callSid ?? outbound.conversationId ?? null,
        fromPhone: outbound.phoneNumberId
          ? `elevenlabs_phone:${outbound.phoneNumberId}`
          : "platform_default",
        outboxWritten: false,
      };
    }

    // The case state machine is the SINGLE WRITER for case state. This used to
    // be a raw `db.case.updateMany`, which bypassed the writer, skipped the
    // legality check (SCREENED -> DIALING and RETRY_SCHEDULED -> DIALING are
    // the only legal ways in) and wrote NO transition audit row — so a case
    // could reach DIALING with nothing in the chain saying it did.
    // transitionCase writes the row, the legality check and the audit entry
    // together, and throws IllegalTransitionError rather than forcing a state
    // the table forbids. The Twilio call-leg sid rides along: it is what the
    // warm_transfer tool rewrites to bridge the customer to a live human.
    await transitionCase(job.case_ref, "DIALING", {
      conversationId: result.conversationId,
      callSid: result.callSid,
    });

    // The telecom outbox: the dial happened, so it is recorded with the number
    // identity the customer's handset showed. Skipped in dry-run — a simulated
    // provider round-trip must not put a delivery fact in a compliance table.
    // Skipped when the send path already wrote its own row: the Twilio plane
    // records with the real call-leg sid, and a second row would put two
    // conflicting delivery facts in the table for one call.
    if (!result.dryRun && !result.outboxWritten) {
      void recordTelecomEvent({
        orgId: job.org_id,
        caseId: existing?.id ?? null,
        channel: "voice",
        toPhone: to,
        fromPhone: result.fromPhone,
        providerSid: result.providerSid ?? null,
        status: "queued",
        payload: {
          caseRef: job.case_ref,
          plane: "elevenlabs_agent",
          category,
          language: payload.language ?? "en",
        },
      }).catch((err: unknown) =>
        logError("[dial-worker] telecom outbox write failed", { error: String(err) }),
      );
    }

    void auditAppend({
      callRef: job.case_ref,
      action: "handoff",
      intent: "dial_placed",
      callerId: WORKER_ID,
      redactedText: `attempt ${job.attempt_no}`,
      meta: {
        jobId: job.id,
        attemptNo: job.attempt_no,
        retries: job.retries,
        conversationId: result.conversationId,
        dryRun: result.dryRun,
      },
      orgId: job.org_id ?? undefined,
    }).catch(() => {});

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void auditAppend({
      callRef: job.case_ref,
      action: "handoff",
      intent: "dial_failed",
      callerId: WORKER_ID,
      redactedText: message.slice(0, 120),
      meta: { jobId: job.id, attemptNo: job.attempt_no, retries: job.retries },
      orgId: job.org_id ?? undefined,
    }).catch(() => {});
    // Retryable: a busy signal or a transient provider error is worth another
    // attempt; a rejected number is not, and retrying it wastes quota.
    const permanent = /not a valid|invalid|not.*reachable|permission/i.test(message);
    return { ok: false, error: message.slice(0, 300), retryable: !permanent };
  }
}

/**
 * The voice channel has definitively failed for this case (every attempt spent,
 * or the number was undiallable). The customer is reachable only by SMS now, and
 * the bank must still hear what happened. Every rule - blind-ping wording, dry-run,
 * opt-out, once per case, bank event when SMS is impossible - lives in
 * `markVoiceFailed`.
 */
async function onDead(job: DialJob): Promise<void> {
  await markVoiceFailed({ caseRef: job.case_ref, reason: "dial_exhausted" });
}

/** How often to look for SMS windows that have closed with no reply. */
const SWEEP_EVERY_MS = Number(process.env.SMS_SWEEP_EVERY_MS ?? 60_000);
let lastSweepAt = 0;

async function maybeSweep(): Promise<void> {
  if (Date.now() - lastSweepAt < SWEEP_EVERY_MS) return;
  lastSweepAt = Date.now();
  try {
    const n = await sweepExpiredSmsCases();
    if (n > 0) logInfo("[dial-worker] resolved unanswered SMS cases", { count: n });
  } catch (err) {
    logError("[dial-worker] sms sweep failed", { error: err instanceof Error ? err.message : err });
  }
}

async function tick(): Promise<number> {
  await maybeSweep();
  const result = await drainDialQueue({
    workerId: WORKER_ID,
    handler: handle,
    onDead,
    limit: BATCH,
    leaseMs: LEASE_MS,
  });
  return result.claimed;
}

async function main(): Promise<void> {
  logInfo("[dial-worker] starting", {
    workerId: WORKER_ID,
    batch: BATCH,
    leaseMs: LEASE_MS,
    pollMs: POLL_MS,
  });

  if (ONCE) {
    const n = await tick();
    logInfo("[dial-worker] claimed jobs and exiting", { count: n, mode: "--once" });
    return;
  }

  let running = true;
  const stop = () => {
    running = false;
    logInfo("[dial-worker] draining — finishing in-flight work");
  };
  // Bun's typed process.on overload enumerates a narrow event union; SIGTERM
  // and SIGINT are valid at runtime and are exactly what compose sends.
  process.on("SIGTERM" as never, stop as never);
  process.on("SIGINT" as never, stop as never);

  while (running) {
    let claimed = 0;
    try {
      claimed = await tick();
    } catch (err) {
      logError("[dial-worker] tick failed", { error: err instanceof Error ? err.message : err });
    }
    // Only idle when there was nothing to do — a backlog drains flat out.
    if (claimed === 0) await new Promise((r) => setTimeout(r, POLL_MS));
  }
  logInfo("[dial-worker] stopped cleanly");
}

if (import.meta.main) {
  main().catch((err) => {
    logError("[dial-worker] fatal", { error: err instanceof Error ? err.message : err });
    process.exit(1);
  });
}

export { handle, tick, WORKER_ID };
