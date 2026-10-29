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

import {
  drainDialQueue,
  markDialStarted,
  clearDialInFlight,
  renewClaim,
  DIAL_IN_FLIGHT,
  type DialJob,
  type DialOutcome,
} from "@/lib/scale/queue";
import { createBreaker, type Breaker } from "@/lib/failures/breaker";
import { placeOutboundCall } from "@/lib/elevenlabs/outbound-call";
import { placeInterventionCall } from "@/lib/twilio";
import { append as auditAppend } from "@/lib/audit-chain";
import { flushLangfuse } from "@/lib/langfuse";
import { db } from "@/lib/db";
import { env } from "@/lib/config";
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
import { sweepSlaBreaches } from "@/lib/sla-breach";
import { advanceEscalations } from "@/lib/notifications";
import { auditChainWatchTick } from "@/lib/audit-chain-watch";
import { resolveCasePhone } from "@/lib/compliance/pii-vault";
import { logError, logInfo, logWarn } from "@/lib/validation/safe-log";
import { flag } from "@/lib/flags";
import { dialKillSwitchEngaged, pilotDialDecision, pilotBlockMarker } from "@/lib/pilot/mode";
import { resolveDeliveryLang } from "@/lib/languages";
import { installProcessCrashHandlers } from "@/lib/process-crash-handlers";

const WORKER_ID =
  process.env.DIAL_WORKER_ID ?? `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
const POLL_MS = Number(process.env.DIAL_WORKER_POLL_MS ?? 1_000);
const BATCH = Number(process.env.DIAL_WORKER_BATCH ?? 5);
const LEASE_MS = Number(process.env.DIAL_WORKER_LEASE_MS ?? 60_000);
/**
 * The lease a job carries WHILE its call is being placed.
 *
 * The claim lease is sized for claiming, not for talking: a batch of five is
 * claimed at once and handled serially, so the last job's 60s claim can expire
 * before the worker reaches it. Reclaiming it while the first worker is still
 * about to dial is exactly how one case becomes two calls. `renewClaim` is run
 * immediately before each handler and extends the row for this window; a lost
 * claim fails the renewal and the job is skipped rather than dialled twice.
 *
 * Fifteen minutes is longer than any call this platform places and short enough
 * that a worker killed mid-call does not strand the case for a shift — and it
 * is a deployment decision (`DIAL_WORKER_CALL_LEASE_MS`), because "how long
 * before a dead worker's call is picked up again" is a question about the
 * deployment's call lengths, not a constant.
 */
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
  // Every threshold is a deployment decision, read from the environment: how
  // many carrier refusals count as "the carrier is down", how long it stays
  // down, and how many probes are allowed while it recovers. A constant here
  // is a constant every operator has to live with.
  failureThreshold: env.breakerFailureThreshold,
  openMs: env.breakerOpenMs,
  halfOpenProbes: env.breakerHalfOpenProbes,
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
 * The states in which a case has a completed prior attempt and MAY be dialled
 * again by a later job. `RETRY_SCHEDULED` is the SMS-reply path; the other
 * three are the provider's own end-of-call outcomes.
 */
const REDIAL_STATES = new Set(["NO_ANSWER", "BUSY", "VOICEMAIL", "RETRY_SCHEDULED"]);

/**
 * Decide whether an existing conversation id means "this attempt already
 * reached the provider" or "a previous attempt finished and this job is the
 * retry".
 *
 * The original check refused every job whose case carried a conversation id.
 * That is right for a reclaimed attempt-1 job (the provider accepted a call we
 * must not place twice) and wrong for attempt 2+: the first call ended in
 * NO_ANSWER/VOICEMAIL, the retry was deliberately queued, and the terminal
 * `conversationId` is evidence of the PRIOR attempt, not of this one. The state
 * machine already records which case it is, so the decision is made from that
 * state rather than from an id that never clears.
 *
 * Exported because this is the join between two independently tested modules
 * (the queue's attempt identity and the case state machine) and a wrong answer
 * here is a second fraud call, not a failed test.
 */
export function shouldSkipRedial(
  existing: { conversationId: string | null; state: string } | null,
  attemptNo: number,
): boolean {
  if (!existing?.conversationId) return false;
  return !(attemptNo > 1 && REDIAL_STATES.has(existing.state));
}

/**
 * Did the provider ANSWER, or did it simply fail?
 *
 * ── Why the distinction decides whether the customer is called again ─────────
 *
 * A carrier call that crosses the provider boundary can end in three ways, and
 * only two of them are failures:
 *
 *   1. The provider REFUSED it (a 4xx). It answered, and what it said was
 *      "no". Nothing was placed, the customer's phone did not ring, and the
 *      attempt ladder is exactly the mechanism for trying again. A 429 or a
 *      503 from the provider's own edge is the same answer.
 *   2. The provider FAILED without answering (a 5xx, a timeout, a socket
 *      reset). The request may have been accepted and the response lost, so
 *      the call MAY already be ringing on the customer's phone. Re-dialling
 *      would ring a customer twice, which on a fraud intervention is the
 *      failure that teaches people to ignore the number.
 *   3. The provider accepted it and the call is in progress. Not a failure.
 *
 * ── Where the answer comes from ─────────────────────────────────────────────
 *
 * A TYPED status, when there is one. Both planes know what they got:
 * `placeInterventionCall` RETURNS `{ ok: false, status, error }`, and
 * `placeOutboundCall` now throws an error carrying `providerStatus`. Neither
 * needs the status recovered from a formatted string, and neither should
 * have it: a vendor that rewords its error message would otherwise change
 * whether the platform retries, silently and without a test failing.
 *
 * The message-parsing fallback is for the errors that carry NO status — a
 * timeout, a socket reset, a `fetch failed` — and for any transport that has
 * not been taught the typed field yet. It is the conservative direction: an
 * unrecognised message is the ABSENCE of an answer, so the call is not
 * retried.
 */
export function providerAnswered(message: string, status?: number | null): boolean {
  // A typed status wins over the message, always.
  if (typeof status === "number" && Number.isFinite(status)) {
    return status >= 400 && status < 500;
  }
  // The three spellings the two planes use:
  //   `twilio dial refused (status 400): …`
  //   `ElevenLabs outbound-call 404: …`
  //   `Twilio 500`
  // The gap between the word and the digits is bounded so a number further
  // along the message — a body echoing a case ref, say — cannot be mistaken
  // for the status.
  const m = /(?:status|outbound-call|refused|twilio)\D{0,12}(\d{3})/i.exec(message);
  if (!m) return false;
  const parsed = Number(m[1]);
  return parsed >= 400 && parsed < 500;
}

/**
 * Place one call.
 *
 * The recovery checks come first. If the case already carries a conversation id,
 * a previous worker placed this call and died before recording it; dialling
 * again would call a customer who is already on the phone with us. If the JOB
 * carries the in-flight marker, the previous worker reached the provider but its
 * outcome is unknowable; neither case may be guessed at with a second call.
 */
async function handle(job: DialJob): Promise<DialOutcome> {
  const payload = parsePayload(job);
  /**
   * Has the carrier been REACHED?
   *
   * Set immediately before the provider call, so it is true even for a row
   * with no claimant (where the in-flight marker could not be written).
   *
   * It is what separates a failure of OUR PREPARATION from a failure of the
   * CARRIER CALL, and the two must not be conflated: a failure before the
   * carrier was reached is the ladder's business, and a failure after it may
   * have left a call ringing on the customer's phone, which is not.
   *
   * The DURABLE marker (written by `markDialStarted`) covers the other half of
   * the same risk: the worker DIED between the marker and the outcome, so
   * nothing ran and nothing was recorded, and the bare marker is what the next
   * claim finds. The flag covers the case where the worker survived and the
   * carrier went quiet.
   */
  let carrierCallAttempted = false;

  // A reclaimed job carrying this marker is the one case the lease cannot
  // resolve: a previous worker reached the provider boundary and stopped. The
  // provider may have accepted a call, so redialling can ring the customer
  // twice; the honest outcome is "unknown", which the queue dead-letters into
  // the SMS fallback and a human-visible record.
  //
  // The marker can carry a suffix. `failDialJob` PRESERVES it when the
  // provider call itself failed after the boundary was crossed, so the row
  // reads `dial_in_flight: <the provider's error>` rather than losing the
  // marker entirely. That distinction is the difference between "the worker
  // died mid-call" and "the provider call failed after we had already handed
  // it over" — and in BOTH cases the carrier may have accepted the call, so
  // in both cases the answer is the same: do not ring the customer again.
  if (job.last_error?.startsWith(DIAL_IN_FLIGHT)) {
    return {
      ok: false,
      error: "previous dial outcome unknown — the provider call started and the worker stopped",
      retryable: false,
    };
  }

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
  if (shouldSkipRedial(existing, job.attempt_no)) {
    // Already placed by a worker that died before writing it down, or a prior
    // attempt whose conversation id is still the case's last known call.
    return { ok: true };
  }

  // ── The pilot charter and the kill switch ──────────────────────────────────
  //
  // Checked HERE, at the authoritative dial moment, and not only at ingest: a
  // job accepted at 09:59 with a lead delay can lawfully be dialled at 10:01,
  // by which time the daily cap may have been reached, a human may have
  // declined the dial, or the kill switch may have been flipped. A ceiling
  // enforced only at intake is a ceiling the queue walks straight past.
  //
  // It sits after the case read and before every check that spends money
  // (a carrier call), touches a customer (an SMS), or burns an attempt on the
  // retry ladder. Those are the three things an operator is trying to avoid
  // when they reach for the switch during an incident.
  //
  // A BLOCK is not a FAILURE. It parks the job — back to PENDING, no attempt
  // consumed, no SMS — so a pilot block can never dead-letter a case into the
  // blind-ping fallback and text a customer the operator deliberately
  // decided not to call.
  const pilot = await pilotDialDecision({
    orgId: job.org_id,
    caseRef: job.case_ref,
    // The CASE id, not the case reference: the cap counter works in cases and
    // excludes the case being decided, because that case is already inside
    // today's window.
    caseId: job.case_id,
    signalKind: existing?.signalKind ?? null,
    // A human approval is bound to ONE case-attempt, and the queue's ladder
    // stays inside that attempt: the retries a carrier's transient refusal
    // causes are retries of a call that was NEVER DELIVERED (a 4xx, a timeout
    // before the carrier accepted it), so no customer hears a second ring. A
    // NEW attempt — the dispatch engine's `retry.callback`, which opens a
    // fresh `dial_job` row — needs its own approval, because that is a new
    // intervention and Phase 1 says a human approves every dial.
    //
    // The rule the code actually enforces is therefore: an approval
    // authorises the DELIVERY of one intervention, and a delivery that may
    // have reached the customer ends the attempt rather than being repeated
    // under the same approval.
    attemptNo: job.attempt_no,
  });
  if (!pilot.allowed) {
    // The marker makes the audit row fire ONCE per blocked episode rather than
    // on every re-claim: a parked job is re-claimed every minute for as long
    // as the block lasts, and a chain with sixty identical rows per hour is a
    // chain nobody reads. The reason is IN the marker, so a change of reason
    // (cap reached → approved → cap reached again) still gets its own row.
    //
    // The marker spelling comes from `pilotBlockMarker` because the console's
    // "waiting for a human" list matches on it: the two used to be written
    // independently, and a disagreement there lists the whole backlog as if
    // every case were waiting on a person.
    const marker = pilotBlockMarker(pilot.reason);
    if (job.last_error !== marker) {
      void auditAppend({
        callRef: job.case_ref,
        action: "handoff",
        intent: "dial_pilot_blocked",
        callerId: WORKER_ID,
        redactedText: pilot.detail.slice(0, 160),
        meta: {
          jobId: job.id,
          reason: pilot.reason,
          mode: pilot.mode,
          retryAfterMs: pilot.retryAfterMs,
        },
        orgId: job.org_id ?? undefined,
      }).catch(() => {});
    }
    return {
      ok: false,
      error: marker,
      retryable: true,
      retryAfterMs: pilot.retryAfterMs,
    };
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

    // The last possible moment before the irreversible provider call. If this
    // CAS fails, another worker owns the row; do not dial. If the process dies
    // after it, the marker survives and the reclaim refuses to redial.
    //
    // A fixture with no claimant (direct handler tests, and a malformed row)
    // cannot be CASed; the production path always reaches this function through
    // `renewClaim`, which refuses a row this worker does not own, so the skip is
    // confined to callers that never had a durable claim to lose.
    if (job.claimed_by) {
      const marked = await markDialStarted(job.id, job.claimed_by);
      if (!marked) {
        return { ok: false, error: "claim lost immediately before dial", retryable: true };
      }
      // The marker is durable, so a crash from here on leaves a row the next
      // claim refuses to redial.
    }

    // Both planes must report the truth about the carrier. `placeOutboundCall`
    // throws on failure; `placeInterventionCall` RETURNS one, so the ok flag has
    // to be read here or a refused call becomes a recorded successful dial.
    //
    // From this line on, the carrier has been reached. Anything that fails
    // after it may have left a call ringing on the customer's phone.
    carrierCallAttempted = true;
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
        // The status rides on the error as a TYPED field. The worker has to
        // know whether the carrier ANSWERED (a 4xx — nothing was placed, so
        // the attempt may be retried) or merely FAILED (a 5xx, a timeout —
        // the call may be ringing, so it must not be), and it must not have
        // to recover that from a formatted string.
        const err = new Error(
          `twilio dial refused (status ${dial.status}): ${dial.error}`,
        ) as Error & { providerStatus?: number };
        err.providerStatus = dial.status;
        throw err;
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

    // ── Was the call PLACED? ─────────────────────────────────────────────────
    //
    // `carrierCallAttempted` is true when the carrier was REACHED — that is,
    // after the job was handed over. Only then is the carrier's answer, or its
    // silence, the question.
    //
    // Before the boundary (a bad payload, a closed breaker, a case that
    // vanished) nothing was handed over, so the ordinary ladder applies.
    const crossedBoundary = carrierCallAttempted;
    // The provider's TYPED status, when the transport gave us one. Both
    // planes attach it to the error they raise, so the judgement never
    // depends on the wording of a message a vendor can change.
    const providerStatus = (err as { providerStatus?: number } | null)?.providerStatus;
    // The provider ANSWERED and refused: nothing was placed, and the ladder
    // may try again. A 4xx is an answer.
    const answered = crossedBoundary && providerAnswered(message, providerStatus);
    // The provider did not answer: a 5xx, a timeout, a socket reset. The call
    // MAY already be ringing on the customer's phone, so this attempt is the
    // last one.
    const unknownOutcome = crossedBoundary && !answered;

    // Retryable: a busy signal or a transient provider error is worth another
    // attempt; a rejected number is not, and retrying it wastes quota.
    //
    // The refusals that are PERMANENT include the platform's own: "live send
    // not attested" is a missing configuration on THIS deployment, and retrying
    // it three times spends a quarter of an hour of backoff to arrive at the
    // same answer. It is a 4xx — the carrier answered — so the marker is
    // cleared and the ladder would apply, and this is what stops it.
    const permanent = /not a valid|invalid|not.*reachable|permission|not attested/i.test(message);

    // The provider REFUSED, so nothing was placed: clear the marker and let
    // the ladder do its job. This is the one case where the marker is
    // actively wrong — it would make the next attempt look like an unknown
    // outcome and stop a call that never happened.
    if (answered && job.claimed_by) {
      const cleared = await clearDialInFlight(job.id, job.claimed_by);
      if (!cleared) {
        // We no longer own the row, or the marker was not ours to clear. The
        // marker stays, and the next claim refuses to redial — the safe
        // direction, because we no longer know what happened to that call.
        return {
          ok: false,
          error: `claim lost while clearing the in-flight marker; not retrying: ${message.slice(0, 200)}`,
          retryable: false,
        };
      }
    }

    return {
      ok: false,
      error: message.slice(0, 300),
      // A call whose outcome is UNKNOWN is never retried: the ladder's whole
      // job is to try again, and "again" is exactly what would ring the
      // customer twice. It dead-letters to the SMS fallback instead, which
      // still reaches the customer and still tells the bank.
      retryable: !permanent && !unknownOutcome,
    };
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
    // The deadline the intake response quotes (`SLA_SECONDS`) had no checker: a case
    // that never reached its customer was invisible unless someone read the queue by
    // hand. Recorded, never auto-actioned — see src/lib/sla-breach.ts for why a missed
    // promise must not be answered with a second contact.
    const sla = await sweepSlaBreaches();
    if (sla.breached > 0)
      logInfo("[dial-worker] case deadlines breached with no contact", {
        breached: sla.breached,
        windowSecs: sla.windowSecs,
      });
  } catch (err) {
    logError("[dial-worker] sla sweep failed", {
      error: err instanceof Error ? err.message : String(err),
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
  try {
    // The tamper watch. `verifyChain()` was checked only when an operator opened
    // that one case in the console; an altered chain elsewhere stayed broken in
    // silence. The sweep verifies a bounded sample of recent chains and pages
    // the inbox on a break. Scheduled inside the module (every 10 minutes), so
    // this one-second loop only pays for a timestamp comparison on most ticks.
    const chains = await auditChainWatchTick();
    if (chains && chains.broken.length > 0)
      logError("[dial-worker] audit-chain sweep found broken chains", {
        checked: chains.checked,
        broken: chains.broken.map((b) => b.callRef),
      });
  } catch (err) {
    logError("[dial-worker] audit-chain sweep failed", {
      error: err instanceof Error ? err.message : err,
    });
  }
}

/**
 * Whether the "dialling is stopped" notice has already been printed for the
 * current episode.
 *
 * The loop ticks once a second; an unflagged log line every second for the
 * duration of an incident is a log nobody can read, and a log nobody can read
 * is how a switch that is working goes unnoticed.
 */
let killSwitchNoticeShown = false;

async function tick(): Promise<number> {
  // The kill switch, at the LOOP level and not only inside the handler.
  //
  // While it is engaged the worker claims nothing at all: no lease is taken,
  // no job is settled, no attempt is consumed. The jobs stay PENDING and are
  // picked up when the switch is released. That is materially different from
  // claiming every job and parking it again — which is what the handler-level
  // check alone would do, once a minute per job, forever, with an audit row
  // each time.
  //
  // The sweeps still run. They resolve cases, escalate lapsed holds and
  // publish bank events; none of them places a call or texts a customer, and
  // stopping them during an incident would leave the bank uninformed for
  // exactly as long as the incident lasts.
  if (await dialKillSwitchEngaged()) {
    if (!killSwitchNoticeShown) {
      killSwitchNoticeShown = true;
      logWarn("[dial-worker] the dial kill switch is engaged — no jobs are being claimed", {
        workerId: WORKER_ID,
        effect: "queued jobs stay PENDING and are dialled when the switch is released",
      });
    }
    await maybeSweep();
    return 0;
  }
  if (killSwitchNoticeShown) {
    killSwitchNoticeShown = false;
    logInfo("[dial-worker] the dial kill switch is released — dialling resumed", {
      workerId: WORKER_ID,
    });
  }

  const result = await drainDialQueue({
    workerId: WORKER_ID,
    handler: handle,
    // The last point before the irreversible action. `renewClaim` both proves
    // this worker still owns the row and extends the lease over the call; a
    // false answer skips the job. Without this a batch-claimed job whose 60s
    // claim lapsed, or a job reclaimed by a second worker, was dialled anyway.
    beforeHandler: (job) => renewClaim(job.id, WORKER_ID, env.dialWorkerCallLeaseMs),
    onDead,
    limit: BATCH,
    leaseMs: LEASE_MS,
  });
  // After the claims, not before them.
  //
  // The sweeps were awaited first, so on a tick where one was due the worker paid up
  // to 50 SMS resolutions, 50 freeze-window lapses and every escalation advance
  // BEFORE taking a single job off the dial queue — and a queued signal is a customer
  // whose card is still live. `maybeSweep` self-throttles to once every
  // SWEEP_EVERY_MS, so ordering costs a sweep at most one tick's worth of claims.
  // It is not gated on an idle queue: a lapsed freeze window that only escalates when
  // nothing is dialling is the same silent stall this sweep exists to remove.
  await maybeSweep();
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
    await flushLangfuse();
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
  // The traces this worker makes are the only record of what the agent was asked
  // and what it answered, and Langfuse batches them. A SIGTERM between two spans
  // used to drop whatever had not been shipped yet, because `flushLangfuse` existed,
  // documented "call this in a SIGTERM handler", and was called by nothing. It is
  // called after the drain rather than inside the signal handler on purpose: spans
  // created while in-flight work finishes are exactly the ones worth keeping, and
  // the flush itself swallows every error so a dead collector cannot stall a shutdown.
  await flushLangfuse();
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
