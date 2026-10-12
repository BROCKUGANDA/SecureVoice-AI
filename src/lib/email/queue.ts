import "server-only";
/**
 * Enqueue-and-attempt orchestration for transactional email.
 *
 * Sits between the auth modules (which mint a token and hand it to a
 * `deliver` callback) and the Resend sender (which knows how to talk to the
 * provider). Keeping the orchestration here means:
 *
 *   · The auth modules never import the provider. Their `deliver` callback is
 *     this one function, so a test can substitute a fake without a key.
 *   · The Resend sender never imports the store. It is a pure "render and post",
 *     which is what makes it reusable by the drain worker for retries.
 *
 * The ordering — row FIRST, send SECOND — is the whole point. If the process
 * dies between "token minted" and "provider accepted", the durable row already
 * exists and the drain worker retries; nothing is lost. The reverse order would
 * drop the message on a crash with no record that it was ever meant to be sent.
 *
 * See src/lib/email/outbox.ts for the queue discipline and why it is a separate
 * table from the bank-webhook outbox.
 */

import { db } from "@/lib/db";
import { enqueueEmail } from "@/lib/email/outbox";
import { sendQueuedEmail } from "@/lib/email/resend";
import type { EmailKind } from "@/lib/email/outbox";

export type EnqueueAndSendResult =
  { ok: true; id: string } | { ok: false; reason: "queue_failed" | "send_failed"; detail: string };

/**
 * Persist a message, then attempt one synchronous send.
 *
 * The token is supplied for the FIRST send only and is NEVER written to the
 * queue — a queued row outlives the token's TTL, and a stored token would be a
 * live credential in the database. A drain retry therefore re-renders from the
 * stored credential-free props; for a single-use link that means a retried
 * magic link is only useful within its original window, which is the correct
 * and safe behaviour.
 */
export async function enqueueAndSendEmail(input: {
  kind: EmailKind;
  toEmail: string;
  subject: string;
  token: string;
  props: Record<string, string | number | null>;
}): Promise<EnqueueAndSendResult> {
  // Defensive: never let a caller smuggle a token into the persisted payload.
  const persistable: Record<string, string | number | null> = { ...input.props };
  delete (persistable as Record<string, unknown>).token;

  let rowId: string;
  try {
    const row = await enqueueEmail({
      kind: input.kind,
      toEmail: input.toEmail,
      subject: input.subject,
      props: persistable,
    });
    rowId = row.id;
  } catch (cause) {
    // The DB is down. We cannot queue, so we cannot promise a retry either.
    return {
      ok: false,
      reason: "queue_failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }

  const sent = await sendQueuedEmail({
    to: input.toEmail,
    subject: input.subject,
    kind: input.kind,
    props: { ...persistable, token: input.token },
  });

  if (sent.ok) {
    await db.emailOutbox
      .update({
        where: { id: rowId },
        data: {
          state: "SENT",
          sentAt: new Date(),
          // Recorded for the same reason as in deliverEmail: it is the only key
          // a delivery webhook carries, so a bounce cannot be matched without it.
          ...(sent.id && sent.id !== "unknown" ? { providerMessageId: sent.id } : {}),
        },
      })
      .catch(() => {
        // The message went out. A missed status update is cosmetic — it does not
        // lose the message, and the drain worker will not re-send a SENT row.
      });
    return { ok: true, id: sent.id };
  }

  // Leave the row PENDING so the drain worker retries with backoff. The caller
  // decides how loudly to report this; the reset route deliberately reports it
  // no louder than success, because a differing response is an account oracle.
  return { ok: false, reason: "send_failed", detail: sent.reason };
}
