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
import { createBreaker, type Breaker } from "@/lib/failures/breaker";
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
import {
  PRAYER_GATE_REGION,
  isWithinPrayerWindow,
  prayerDeferralMs,
} from "@/lib/compliance/prayer-times";
import { sweepExpiredSmsCases } from "@/lib/sms-verdict";
import { sweepExpiredFreezeWindows } from "@/lib/freeze-window";
import { advanceEscalations } from "@/lib/notifications";
import { resolveCasePhone } from "@/lib/compliance/pii-vault";
import { logError, logInfo, logWarn } from "@/lib/validation/safe-log";
import { flag } from "@/lib/flags";
import { resolveDeliveryLang } from "@/lib/languages";
import { installProcessCrashHandlers } from "@/lib/process-crash-handlers";

const WORKER_ID =
  process.env.DIAL_WORKER_ID ?? `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const POLL_MS = Number(process.env.DIAL_WORKER_POLL_MS ?? 1_000);
const BATCH = Number(process.env.DIAL_WORKER_BATCH ?? 5);
const LEASE_MS = Number(process.env.DIAL_WORKER_LEASE_MS ?? 60_000);
const ONCE = process.argv.includes("--once");

/**
 * The telephony breaker.
 *
 * `DEPENDENCIES` in src/lib/failures/breaker.ts has listed "telephony" since
 * that module was written, with a declared fallback ("telephony down → queue
 * and alert"), and nothing ever created it — a declared dependency whose
 * failure counter nobody increments can never open, so the guardrail was
 * decorative and a reviewer counting `DEPENDENCIES` would have believed a dead
 * carrier stops dispatch. This worker is the only carrier caller in the repo,
 * so the instance lives here: five consecutive carrier refusals stop the loop
 * from proving the carrier is down once per queued job, and the job is
 * deferred with the fallback's Retry-After instead — the "queue" leg of the
 * declared fallback, with the refusal audited rather than silent.
 */
const telephonyBreaker: Breaker = createBreaker("telephony", {
  failureThreshold: 5,
  openMs: 60_000,
  halfOpenProbes: 1,
});

/** Test seam, mirroring `_resetLlmBreakerForTest` in src/lib/llm.ts. */
export function _resetDialTelephonyBreakerForTest(): void {
  telephonyBreaker.reset();
}

/** The breaker's live view, for tests and for verification runs. */
export function dialTelephonyBreakerState(): ReturnType<Breaker["snapshot"]> {
  return telephonyBreaker.snapshot();
}

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
 * voice tables actually have — now owned by src/lib/languages.ts (the single
 * source of truth, shared with the `/api/twilio/turn` TwiML plane). Re-exported
 * here because the worker's call sites and its unit tests import it from this
 * path; the definition no longer lives in the worker.
 */
export { resolveDeliveryLang } from "@/lib/languages";

function parsePayload(job: DialJob): JobPayload {
  try {
    const v = JSON.parse(job.payload) as unknown;
    return v && typeof v === "object" ? (v as JobPayload) : {};
  } catch {
    return {};
  }
}

/** Loopback and `.local` hosts — the same list `src/lib/auth/origins.ts` refuses
 *  in production, duplicated rather than imported because that module is marked
 *  `server-only` and importing it from this standalone Bun process throws.
 *
 *  `.local` is a suffix test: `printer.local` resolves only via mDNS on the local
 *  segment, which is exactly the class of name a carrier cannot resolve. */
const UNREACHABLE_HOST =
  /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\[?::1\]?|.*\.local)$/i;

/**
 * The public hostname the carrier dials BACK for the media stream.
 *
 * This value is not an internal address. `placeInterventionCall` hands it to
 * Twilio, whose fleet resolves it from the public internet — so a loopback or
 * empty host produces a call the customer answers and hears nothing on, while
 * every log here records a successful dial. That is the worst outcome this
 * system can produce: a fraud intervention that reports success and reaches no
 * one.
 *
 * The predecessor of this function fell back to `"localhost"`. In production
 * that value is guaranteed wrong, `docker-compose.yml` did not pass
 * `SITE_ADDRESS` to this service at all, and the unit test could not tell: it
 * asserted only that the URL contained `wss://` and the path. So the fallback
 * is replaced by a refusal, and the caller (`handle`) turns it into a named,
 * audited `dial_failed` — the same shape as every other pre-dial refusal.
 *
 * `SITE_ADDRESS` (not `NEXT_PUBLIC_SITE_URL`) is the input because it is the
 * hostname Caddy's TLS certificate is issued for, and the one the tracked
 * Caddyfile's per-site blocks are built around.
 */
export function mediaStreamHost(env: NodeJS.ProcessEnv = process.env): string {
  const host = (env.SITE_ADDRESS ?? "").trim();
  if (host === "" || UNREACHABLE_HOST.test(host)) {
    throw new Error(
      `SITE_ADDRESS is ${host === "" ? "not set" : JSON.stringify(host)}, but the Twilio media-stream plane needs the public hostname the carrier can reach (wss://<SITE_ADDRESS>/realtime/media-stream). Refusing to dial rather than place a call the customer cannot hear. Set SITE_ADDRESS to the hostname Caddy serves, e.g. securevoiceai.me.`,
    );
  }
  return host;
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
      orgId: true,
      conversationId: true,
      state: true,
      phone: true,
      customerPhoneToken: true,
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
  // looking at the number. The plaintext destination is sealed in the PII vault
  // (org-scoped) and the case row carries only its token; rows created before
  // tokenization still carry the legacy raw column and resolve from it until
  // they age out.
  const to = (await resolveCasePhone(existing, existing?.orgId ?? job.org_id)) ?? payload.phone;
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

    // Prayer window, re-checked at the dial moment for the SAME reason calling
    // hours are re-checked here and not only at ingest: a routine job accepted at
    // 13:20 Gulf time can lawfully claim at 13:25, and the Jumu'ah window opens
    // across Friday Dhuhr for an hour. Until now the ingest gate had refused the
    // 13:20 signal, the queue had parked it, and nothing at the authoritative
    // moment looked at prayer at all — so the one job class the policy exists to
    // protect was the one that slipped through.
    //
    // Parked, not refused, and no attempt consumed: a deferred reminder is not a
    // failed call. Time-critical fraud verification stays exempt, which is the
    // same exemption `src/lib/compliance/gate.ts` applies at ingest — a prayer
    // window must never stand between a cardholder and a freeze.
    if (category !== "time_critical_fraud") {
      // The SAME region the ingest gate consults, shared as one constant rather
      // than repeated as a literal in two files: an assumption in two places is
      // two assumptions, and they diverge silently.
      if (await isWithinPrayerWindow(PRAYER_GATE_REGION)) {
        const waitMs = await prayerDeferralMs(PRAYER_GATE_REGION);
        // A floor of 60 s, because a zero-millisecond defer is a busy loop that
        // re-claims the same job on every drain, and `prayerDeferralMs` answers
        // null when a third-party lookup raced the window shut.
        const retryAfterMs = Math.max(60_000, waitMs ?? 5 * 60_000);
        void auditAppend({
          callRef: job.case_ref,
          action: "handoff",
          intent: "dial_deferred_prayer_window",
          callerId: WORKER_ID,
          meta: {
            jobId: job.id,
            category,
            wakeAt: new Date(Date.now() + retryAfterMs).toISOString(),
          },
          orgId: job.org_id ?? undefined,
        }).catch(() => {});
        return {
          ok: false,
          error: "inside the prayer window; deferred",
          retryable: true,
          retryAfterMs,
        };
      }
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

    // The carrier circuit breaker. An open breaker means the previous five
    // attempts failed AT the carrier and this one will too — asking again per
    // queued job is how a provider outage becomes a retry storm against a
    // vendor that is already refusing. The declared fallback for this
    // dependency is "queue and alert": the job is deferred with the fallback's
    // Retry-After (the queue preserves the intervention), and the refusal is
    // audited so an operator sees why calls stopped, not just that they did.
    const permit = telephonyBreaker.permit();
    if (!permit.allowed) {
      const retryAfterMs = (permit.fallback?.retryAfterSec ?? 60) * 1_000;
      void auditAppend({
        callRef: job.case_ref,
        action: "handoff",
        intent: "dial_deferred_carrier_breaker",
        callerId: WORKER_ID,
        redactedText: `telephony breaker ${permit.state}; retry in ${retryAfterMs / 1_000}s`,
        meta: {
          jobId: job.id,
          state: permit.state,
          consecutiveFailures: permit.consecutiveFailures,
          retryAfterMs,
        },
        orgId: job.org_id ?? undefined,
      }).catch(() => {});
      return {
        ok: false,
        error: `telephony circuit breaker open — carrier failing; job deferred ${retryAfterMs / 1_000}s`,
        retryable: true,
        retryAfterMs,
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
      const host = mediaStreamHost();
      // Worker plane lives on a SIBLING prefix under /realtime, not under /api:
      // Caddy terminates the websocket upgrade there, and a Next.js route handler
      // cannot upgrade a socket at all, so the stream is served by this worker and
      // not by an app route. (The old /api/voice-websocket route was deleted for
      // exactly that reason — its exported GET returned JSON and its server
      // factory had no caller; `src/worker/voice-stream.ts` is the same wiring,
      // reachable. Caddy routes /realtime/media-stream here — see Caddyfile +
      // Caddyfile.platform.)
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
        telephonyBreaker.recordFailure();
        throw new Error(`twilio dial refused (status ${dial.status}): ${dial.error}`);
      }
      telephonyBreaker.recordSuccess();
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
      }).catch((err: unknown) => {
        // `placeOutboundCall` throws on a carrier failure; count it against the
        // breaker before the worker's own catch turns it into a retry.
        telephonyBreaker.recordFailure();
        throw err;
      });
      telephonyBreaker.recordSuccess();
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

    // TRICK 1 — pre-warm the voice plane at the DIALING state, before the
    // customer answers.
    //
    // Between this line and the customer saying hello there are seconds of dead
    // air in which nothing needs the CPU — and the voice-stream worker, a
    // separate process with a separate cache, sits idle. Two things are warmed
    // there by this call: the audio cache for every fixed phrase the agent will
    // speak (so the call's first words are a memory read, not a vendor
    // round-trip) and a pooled Deepgram socket for the call's language (so the
    // ASR handshake is already done when Twilio opens the media stream).
    //
    // Fire-and-forget by design: the carrier does not wait for our warm-up,
    // and a warm-up that could fail a dial would be disabled the first time a
    // vendor was slow. A missed warm only costs a cold first call — the
    // voice-stream worker also warms at stream-connect, which is the fallback
    // for every path that does not come through this queue.
    if (flag("twilioMediaStreams")) {
      const prewarmBase =
        process.env.VOICE_STREAM_INTERNAL_URL ?? "http://voice-stream-worker:8080";
      const lang = resolveDeliveryLang(payload.language);
      const secret = process.env.VOICE_PREWARM_SECRET;
      void fetch(
        `${prewarmBase}/prewarm?lang=${encodeURIComponent(lang)}&callSid=${encodeURIComponent(job.case_ref)}`,
        {
          method: "POST",
          ...(secret ? { headers: { "x-prewarm-secret": secret } } : {}),
          signal: AbortSignal.timeout(1_500),
        },
      )
        .then((res) => {
          if (!res.ok) {
            logWarn("[dial-worker] voice pre-warm refused; the call proceeds cold", {
              status: res.status,
              caseRef: job.case_ref,
            });
          }
        })
        .catch(() => {
          /* the voice plane is optional; a cold first call is not a failed dial */
        });
    }

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

/**
 * How often the platform's own deadlines are checked.
 *
 * The interval was named for the one sweep that used to live here; it now paces
 * three. Each is a bounded pass over rows that only accumulate if nothing services
 * them, so running them on the worker's tick — rather than a cron that would have to
 * be installed on every deployment — is what makes "nobody answered" and "nobody
 * decided" reach a human instead of sitting in a table.
 */
const SWEEP_EVERY_MS = Number(process.env.SMS_SWEEP_EVERY_MS ?? 60_000);
let lastSweepAt = 0;

async function maybeSweep(): Promise<void> {
  if (Date.now() - lastSweepAt < SWEEP_EVERY_MS) return;
  lastSweepAt = Date.now();
  // Separate guards on purpose: an outage in the freeze sweep must not stop SMS
  // resolution, and neither may hold up the dial drain behind them.
  try {
    const n = await sweepExpiredSmsCases();
    if (n > 0) logInfo("[dial-worker] resolved unanswered SMS cases", { count: n });
  } catch (err) {
    logError("[dial-worker] sms sweep failed", { error: err instanceof Error ? err.message : err });
  }
  try {
    const lapsed = await sweepExpiredFreezeWindows();
    if (lapsed.length > 0)
      logInfo("[dial-worker] staged holds escalated on window expiry", {
        count: lapsed.length,
        caseRefs: lapsed.map((ref) => ref.slice(-6)),
      });
  } catch (err) {
    logError("[dial-worker] freeze-window sweep failed", {
      error: err instanceof Error ? err.message : err,
    });
  }
  try {
    const hops = await advanceEscalations();
    if (hops.length > 0)
      logInfo("[dial-worker] unacknowledged alerts advanced up the ladder", {
        hops: hops.length,
        exhausted: hops.filter((h) => h.terminal).length,
      });
  } catch (err) {
    logError("[dial-worker] escalation sweep failed", {
      error: err instanceof Error ? err.message : err,
    });
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

  // Fail the boot, not every call, when the media-stream plane is on and its
  // host is unreachable: the flag is the operator's statement that this
  // deployment has a publicly reachable WebSocket endpoint, and without one
  // every dial this process places is a call the customer answers in silence.
  // A crash-looping container with this message in `docker compose logs` is a
  // diagnosable five-second fix; the alternative is a month of mute calls.
  if (flag("twilioMediaStreams")) {
    mediaStreamHost();
  }

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
  installProcessCrashHandlers();
  main().catch((err) => {
    logError("[dial-worker] fatal", { error: err instanceof Error ? err.message : err });
    process.exit(1);
  });
}

export { handle, tick, WORKER_ID };
