import "server-only";
/**
 * SMS verdicts: closing the loop on the blind-ping SMS.
 *
 * When the voice call cannot reach a human, the customer gets a text with no
 * merchant and no amount and is asked to reply YES or NO. This module is the other
 * half: it turns that reply into a verdict the bank receives, safely.
 *
 * ## Why this is more careful than "find the phone number, update the row"
 *
 * An inbound SMS authenticates ONE thing: the sender controls that phone number.
 * It does not authenticate the customer (SIM swap, a stolen handset, a family
 * member). Every decision here is shaped by that:
 *
 *   - ASYMMETRY. NO escalates to a human fraud reviewer. YES merely records that
 *     the customer says it was theirs. Neither unfreezes, releases or approves
 *     anything - there is nothing to release, and a thief who answers YES gains
 *     nothing the bank has not already decided on its own.
 *   - STRICT PARSING. Exact-match tokens, never substring: "know", "not sure",
 *     "nothing" all contain "no". A reply that is not unambiguously YES or NO is
 *     asked again, never guessed.
 *   - FAIL SAFE ACROSS TENANTS. The same phone can have an open alert at a bank
 *     AND an insurer. A bare YES could then close the wrong one, so it closes
 *     NEITHER and tells the customer to call their institution.
 *   - 24h WINDOW. An old alert is not a standing offer to be closed by whoever
 *     holds the phone next month.
 *   - ONE TRANSACTION. The case moves to NOTIFIED and the bank's event is queued
 *     in the same database transaction (transitionCaseWithOutbox), so a verdict
 *     never exists without its delivery - and a duplicate reply loses the race
 *     against the state check instead of notifying the bank twice.
 *   - NO RAW BODY STORED. Only the parsed intent. What the customer typed is
 *     untrusted text; keeping it would create the stored-injection risk
 *     src/lib/memory-guard.ts exists to prevent.
 */

import { db } from "@/lib/db";
import { append as auditAppend } from "@/lib/audit-chain";
import { notify } from "@/lib/notifications";
import { IllegalTransitionError, transitionCaseWithOutbox } from "@/lib/case-state-machine";
import { SMS_REPLY, type OutreachLang } from "@/lib/outreach-copy";
import { screenForMemory } from "@/lib/memory-guard";
import { checkBadActor, recordStrike } from "@/lib/abuse/bad-actor";
import type { ResolutionMethod } from "@/lib/contracts/schema";

/** How long after the SMS a reply is still accepted, and when the sweep gives up. */
export const REPLY_WINDOW_MS = 24 * 60 * 60_000;

/* ————————————————————————— parsing (pure) ————————————————————————— */

export type ReplyIntent = "yes" | "no" | "stop" | "start" | "help" | "unclear";

/**
 * Whole-message matches only. Each list is the COMPLETE set of accepted
 * messages after normalisation - adding a word here is the only way to widen
 * what counts as an answer, and that is a deliberate, reviewable act.
 */
const YES = new Set([
  "yes",
  "y",
  "yeah",
  "yep",
  "yup",
  "yas",
  "yea",
  "ya",
  "yess",
  "yes it was me",
  "yes it was",
  "it was me",
  "that was me",
  "yes thanks",
  "yes thank you",
  // other deployed languages, as plain single words
  "oui",
  "ndiyo",
  "ndio",
  "haan",
  "han",
  "نعم",
  "ايوه",
  "أيوه",
  "ہاں",
  "हाँ",
  "हां",
]);

const NO = new Set([
  "no",
  "n",
  "nope",
  "nah",
  "not me",
  "not mine",
  "it was not me",
  "that was not me",
  "no it was not me",
  "no it wasnt me",
  "wasnt me",
  "was not me",
  "it wasnt me",
  "that wasnt me",
  "this wasnt me",
  "it wasnt mine",
  "that wasnt mine",
  "i didnt do it",
  "didnt do it",
  "i did not",
  "fraud",
  "scam",
  "non",
  "hapana",
  "لا",
  "نہیں",
  "नहीं",
  "nahin",
]);

const STOP = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START = new Set(["start", "unstop"]);
const HELP = new Set(["help", "info"]);

/** Fold to a comparable form: NFKC, lowercase, punctuation and emoji to spaces. */
function foldReply(body: string): string {
  return (
    body
      .normalize("NFKC")
      // zero-width / bidi / control characters never belong in a one-word answer
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, " ")
      .toLowerCase()
      .replace(/['’`]/g, "") // "wasn't" -> "wasnt"
      .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Classify an inbound reply. Exact whole-message matching: see the lists above. */
export function parseSmsReply(body: string): ReplyIntent {
  if (typeof body !== "string" || body.length === 0 || body.length > 200) return "unclear";
  const f = foldReply(body);
  if (!f) return "unclear";
  if (STOP.has(f)) return "stop";
  if (START.has(f)) return "start";
  if (HELP.has(f)) return "help";
  // Check NO before YES only for readability: the two sets are disjoint, so a
  // message can never match both, and "yes no" matches neither.
  if (NO.has(f)) return "no";
  if (YES.has(f)) return "yes";
  return "unclear";
}

/* ————————————————————————— resolution ————————————————————————— */

function asLang(v: string | null | undefined): OutreachLang {
  return (["en", "ar", "hi", "ur", "fr", "sw"] as const).includes(v as OutreachLang)
    ? (v as OutreachLang)
    : "en";
}

/**
 * Publish the final state of an unreached case to the bank.
 *
 * Returns true if THIS call moved the case, false if it was already resolved (a
 * duplicate reply, a sweep that raced a reply). Never throws on that race: losing
 * it is the normal, correct outcome of idempotency.
 */
export async function publishResolution(args: {
  caseRef: string;
  method: ResolutionMethod;
  customerResponse: "yes" | "no" | null;
  outcome: string;
  /** NO replies queue a human reviewer; everything else does not. */
  queueHumanReview?: boolean;
  note: string;
}): Promise<boolean> {
  const row = await db.case.findFirst({
    where: { caseRef: args.caseRef },
    select: { orgId: true, state: true, freezeStaged: true, freezeReference: true },
  });
  if (!row || row.state !== "UNREACHABLE") return false;

  const review = args.queueHumanReview === true;
  try {
    await transitionCaseWithOutbox(args.caseRef, "NOTIFIED", {
      meta: {
        resolutionMethod: args.method,
        customerResponse: args.customerResponse,
        outcome: args.outcome,
        ...(review ? { handoffQueued: true, handoffSpecialist: "fraud-review-queue" } : {}),
      },
      outbox: {
        eventType: "case.notified",
        caseRef: args.caseRef,
        orgId: row.orgId ?? null,
        data: {
          state: "NOTIFIED",
          outcome: args.outcome,
          duration_seconds: null,
          // Staged, never committed - and an SMS reply never stages one: that
          // decision belongs to the institution's human fraud team.
          freeze_staged: row.freezeStaged,
          freeze_reference: row.freezeReference,
          handoff_queued: review,
          handoff_specialist: review ? "fraud-review-queue" : null,
          tool_calls_observed: 0,
          audit_ref: args.caseRef,
          resolution_method: args.method,
          customer_response: args.customerResponse,
          evidence: { transcript: "withheld", note: args.note },
        },
      },
    });
  } catch (err) {
    if (err instanceof IllegalTransitionError) return false; // lost the race: already resolved
    throw err;
  }

  await auditAppend(
    {
      callRef: args.caseRef,
      action: review ? "handoff" : "agent",
      intent: "sms_resolution",
      callerId: "sms-verdict",
      redactedText: `${args.method}`,
      meta: { method: args.method, customerResponse: args.customerResponse, review },
      orgId: row.orgId ?? undefined,
    },
    { fast: true },
  ).catch((e) => console.error("[sms-verdict] audit failed:", e instanceof Error ? e.message : e));

  if (review) {
    void notify({
      orgId: row.orgId ?? null,
      alertType: "case:sms_reported_fraud",
      severity: "page",
      title: `Case ${args.caseRef}: customer replied NO by SMS`,
      body: "Customer reported the activity as fraud over SMS. Human review required; nothing has been frozen automatically.",
      caseRef: args.caseRef,
    }).catch(() => {});
  }
  return true;
}

/**
 * Give up on cases whose SMS window has closed with no reply.
 * The bank still hears about them - "nobody answered" is information, and a case
 * the bank never learns about is the failure this whole path exists to prevent.
 */
export async function sweepExpiredSmsCases(now: Date = new Date(), limit = 50): Promise<number> {
  const stale = await db.case.findMany({
    where: { state: "UNREACHABLE", smsSentAt: { lt: new Date(now.getTime() - REPLY_WINDOW_MS) } },
    select: { caseRef: true },
    orderBy: { smsSentAt: "asc" },
    take: limit,
  });
  let resolved = 0;
  for (const c of stale) {
    const moved = await publishResolution({
      caseRef: c.caseRef,
      method: "unreachable_no_reply",
      customerResponse: null,
      outcome: "unreachable_no_reply",
      note: "Voice call did not reach the customer and the SMS received no reply within 24 hours.",
    }).catch((err) => {
      console.error("[sms-verdict] sweep failed:", err instanceof Error ? err.message : err);
      return false;
    });
    if (moved) resolved++;
  }
  return resolved;
}

/* ————————————————————————— the inbound reply ————————————————————————— */

export type SmsReplyResult = {
  /** Text to send back, or null for "send nothing" (STOP / START / blocked). */
  reply: string | null;
  outcome:
    | "resolved_yes"
    | "resolved_no"
    | "duplicate"
    | "invalid"
    | "no_open_alert"
    | "expired"
    | "ambiguous"
    | "stop"
    | "start"
    | "help"
    | "blocked"
    | "rejected";
  caseRef?: string;
};

const E164 = /^\+[1-9]\d{7,14}$/;

/** The generic text a non-match, a block and an expiry all share: a probe learns nothing. */
async function replyFor(kind: keyof typeof SMS_REPLY, phone: string): Promise<string> {
  const latest = await db.case
    .findFirst({ where: { phone }, orderBy: { createdAt: "desc" }, select: { language: true } })
    .catch(() => null);
  return SMS_REPLY[kind][asLang(latest?.language)];
}

/**
 * Handle one inbound SMS. `from` is Twilio's `From` (already authenticated by the
 * route's signature check - this function trusts that the SENDER is who Twilio
 * says, and nothing about the BODY).
 */
export async function handleSmsReply(input: {
  from: string;
  body: string;
  now?: Date;
}): Promise<SmsReplyResult> {
  const now = input.now ?? new Date();
  const from = typeof input.from === "string" ? input.from.trim() : "";
  if (!E164.test(from)) return { reply: null, outcome: "rejected" };

  const actor = `sms:${from}`;
  const standing = checkBadActor(actor, now.getTime());
  if (standing.action === "block") {
    // Same silence a STOP gets. A prober cannot distinguish "blocked" from "ignored".
    return { reply: null, outcome: "blocked" };
  }

  const intent = parseSmsReply(input.body);

  // A body that screens as an injection attempt is a strike regardless of what it
  // parses to. It is never stored (we keep only the parsed intent) and never echoed.
  const risk = screenForMemory(typeof input.body === "string" ? input.body : "");
  if (risk.verdict !== "clean") {
    const v = recordStrike(actor, risk.verdict === "poisoned" ? 3 : 1, now.getTime());
    await auditAppend({
      callRef: "SV-SMS-INBOUND",
      action: "agent",
      intent: "sms_injection_suspected",
      callerId: "sms-verdict",
      redactedText: `verdict=${risk.verdict} reasons=${risk.reasons.join(",")}`,
      meta: { verdict: risk.verdict, score: risk.score, reasons: risk.reasons, standing: v.action },
    }).catch(() => {});
  }

  if (intent === "stop") {
    await db.smsSuppression
      .upsert({ where: { phone: from }, create: { phone: from, reason: "stop" }, update: {} })
      .catch((e) => console.error("[sms-verdict] suppression failed:", e));
    return { reply: null, outcome: "stop" }; // Twilio sends its own opt-out confirmation
  }
  if (intent === "start") {
    await db.smsSuppression.deleteMany({ where: { phone: from } }).catch(() => {});
    return { reply: null, outcome: "start" };
  }
  if (intent === "help") {
    return {
      reply:
        "SecureVoice sends fraud alerts for your bank or insurer. Reply STOP to opt out. To check an alert, call the number on your card or policy documents.",
      outcome: "help",
    };
  }
  if (intent === "unclear") {
    recordStrike(actor, 0.5, now.getTime());
    return { reply: await replyFor("invalid", from), outcome: "invalid" };
  }

  // — a YES or a NO. Find the alert it answers. —
  const open = await db.case.findMany({
    where: {
      phone: from,
      state: "UNREACHABLE",
      smsSentAt: { gte: new Date(now.getTime() - REPLY_WINDOW_MS) },
    },
    orderBy: { smsSentAt: "desc" },
    take: 5,
    select: { caseRef: true, orgId: true, language: true },
  });

  if (open.length === 0) {
    // Distinguish "your window closed" from "never had one" only for the CUSTOMER's
    // benefit; both are the same shape of answer and neither names a case.
    const lapsed = await db.case.count({
      where: {
        phone: from,
        state: "UNREACHABLE",
        smsSentAt: { lt: new Date(now.getTime() - REPLY_WINDOW_MS) },
      },
    });
    if (lapsed > 0) return { reply: await replyFor("expired", from), outcome: "expired" };
    // Replying to a number nobody alerted is the signature of enumeration.
    const v = recordStrike(actor, 1, now.getTime());
    await auditAppend({
      callRef: "SV-SMS-INBOUND",
      action: "agent",
      intent: "sms_no_open_alert",
      callerId: "sms-verdict",
      redactedText: `standing=${v.action} strikes=${v.strikes}`,
      meta: { standing: v.action, strikes: v.strikes },
    }).catch(() => {});
    return { reply: await replyFor("unknown", from), outcome: "no_open_alert" };
  }

  const orgs = new Set(open.map((c) => c.orgId ?? "∅"));
  if (orgs.size > 1) {
    // Two institutions are waiting on this number. A bare YES/NO cannot be placed
    // safely, so it is applied to NEITHER.
    return { reply: SMS_REPLY.ambiguous[asLang(open[0]!.language)], outcome: "ambiguous" };
  }

  // Several open alerts at one institution: the reply answers the most recent.
  const target = open[0]!;
  const yes = intent === "yes";
  const moved = await publishResolution({
    caseRef: target.caseRef,
    method: yes ? "sms_reply_yes" : "sms_reply_no",
    customerResponse: yes ? "yes" : "no",
    outcome: yes ? "customer_confirmed_activity_sms" : "customer_reported_fraud_sms",
    queueHumanReview: !yes,
    note: yes
      ? "Customer replied YES to the blind-ping SMS. This proves possession of the phone, not identity."
      : "Customer replied NO to the blind-ping SMS. Human review required; nothing was frozen automatically.",
  });

  const lang = asLang(target.language);
  return {
    reply: SMS_REPLY[yes ? "yes" : "no"][lang],
    outcome: moved ? (yes ? "resolved_yes" : "resolved_no") : "duplicate",
    caseRef: target.caseRef,
  };
}
