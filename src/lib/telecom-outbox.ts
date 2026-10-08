import "server-only";
/**
 * The telecom outbox — the lifecycle record of every call and SMS.
 *
 * Why this exists: a compliance-grade voice platform must be able to answer
 * "what did we send, to whom, from which number, and what happened to it" for
 * every customer contact. The case state machine records WHY; this records the
 * TELECOM facts — channel, endpoints, the provider's own sid, and the delivery
 * status the provider reports back on its callback.
 *
 * Multi-tenant isolation rides along: every row is org-scoped, and the from
 * number recorded is the one the customer actually saw (the org's own where
 * configured, the platform's otherwise) — so a Bank A alert can never be
 * attributed to Bank B's number.
 *
 * Direction is carried by the endpoints, not a column: on an outbound row
 * `toPhone` is the customer; on an inbound one `toPhone` is the number the
 * customer dialled, which is the org's.
 */

import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";

export type TelecomChannel = "voice" | "sms";
export type TelecomStatus = "queued" | "in_progress" | "sent" | "delivered" | "failed";

export async function recordTelecomEvent(args: {
  orgId: string | null;
  caseId: string | null;
  channel: TelecomChannel;
  toPhone: string;
  fromPhone: string;
  providerSid?: string | null;
  status: TelecomStatus;
  payload?: Record<string, unknown>;
}): Promise<string> {
  const row = await db.telecomEvent.create({
    data: {
      orgId: args.orgId,
      caseId: args.caseId,
      channel: args.channel,
      toPhone: args.toPhone,
      fromPhone: args.fromPhone,
      providerSid: args.providerSid ?? null,
      status: args.status,
      payload: args.payload as Prisma.InputJsonValue | undefined,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * The provider's status callback join: fold a report about a sid into the row
 * that sid belongs to.
 *
 * Returns the number of rows touched. Zero is not an error — a callback can
 * arrive for a row this deployment never wrote (a re-created database, an
 * operator purge, a duplicated webhook) — but the caller logs it, because an
 * outbox that silently stops matching callbacks is a compliance record that
 * looks complete while every row still says "queued".
 *
 * `detail` is MERGED into the existing payload rather than replacing it: the
 * payload is the sent text, which the record must keep.
 *
 * Raw SQL, deliberately. A read-modify-write of a JSONB column through the
 * client would race two callbacks for the same sid and lose one; Postgres
 * merges them in the statement.
 */
export async function updateTelecomEvent(args: {
  providerSid: string;
  status: TelecomStatus;
  detail?: Record<string, string>;
  /** The real sender, once the carrier reports it — a Messaging Service chooses
   *  its own number, so the outbound write can only record the service. */
  fromPhone?: string | null;
}): Promise<number> {
  const detail = JSON.stringify(args.detail ?? {});
  return db.$executeRaw`UPDATE "TelecomEvent"
     SET "status" = ${args.status},
         "fromPhone" = COALESCE(${args.fromPhone ?? null}, "fromPhone"),
         "payload" = COALESCE("payload", '{}'::jsonb) || ${detail}::jsonb,
         "updatedAt" = now()
   WHERE "providerSid" = ${args.providerSid}`;
}

/** Map Twilio's message status vocabulary onto ours. Unknown stays null. */
export function twilioMessageStatusToOurs(raw: string | null): TelecomStatus | null {
  switch ((raw ?? "").toLowerCase()) {
    case "queued":
    case "accepted":
    case "scheduled":
      return "queued";
    case "sent":
      return "sent";
    case "delivered":
    case "read":
      return "delivered";
    case "undelivered":
    case "failed":
      return "failed";
    default:
      return null;
  }
}

/**
 * Map Twilio's CALL status vocabulary onto ours.
 *
 * `completed` is "delivered": the call reached a human, which is the fact the
 * outbox is asked for. `busy`, `no-answer` and `canceled` are `failed` — they
 * are not delivery failures at the network layer, but from the platform's point
 * of view the customer was not reached, and that is the distinction the retry
 * ladder and the bank's report both care about. Twilio's own word is kept in the
 * payload so the difference is never actually lost.
 */
export function twilioCallStatusToOurs(raw: string | null): TelecomStatus | null {
  switch ((raw ?? "").toLowerCase()) {
    case "queued":
    case "ringing":
      return "queued";
    case "initiated":
    case "answering":
    case "in-progress":
    case "in_progress":
      return "in_progress";
    case "completed":
      return "delivered";
    case "busy":
    case "no-answer":
    case "not-empty":
    case "canceled":
    case "failed":
      return "failed";
    default:
      return null;
  }
}
