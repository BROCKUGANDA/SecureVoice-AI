import "server-only";
/**
 * Durable queue for transactional email (magic link, invite, password reset).
 *
 * Mirrors the discipline of src/lib/outbox.ts — the bank-webhook outbox — but
 * is a separate table and a separate module, because the two payloads have
 * nothing in common. See prisma/schema.prisma `EmailOutbox` for why they are
 * not one table.
 *
 * ── The rule this file exists to enforce ────────────────────────────────────
 * These three messages each carry a live credential. A send that fails must be
 * OBSERVABLE to the caller, not swallowed. So `enqueueEmail` returns the row,
 * `attemptImmediateSend` reports success or failure, and the route decides what
 * the operator is told. What this module never does is claim a message is sent
 * when it is not.
 *
 * ── Credentials are not persisted ───────────────────────────────────────────
 * `payload` holds { template, props } with every credential-bearing prop
 * stripped (the token, the signed URL). A queued row can outlive its token's
 * expiry — that is the whole point of a queue — so storing the token would put
 * a live credential in the database for the length of the retry ladder. The
 * URL is rendered at SEND time from the token the route already holds.
 *
 * ── Recipient awareness ─────────────────────────────────────────────────────
 * `toEmail` is stored on purpose. Three reasons, all operational:
 *   · support can answer "did the invite reach this analyst?" without guessing;
 *   · a bounced address can be suppressed before it is mailed again;
 *   · the drain worker can scope its log line to the address the operator
 *     already typed, rather than an opaque id.
 * It is personal data: redacted in logs (src/lib/redact.ts has EMAIL_RE) and
 * covered by the same retention sweep as every other row in this database.
 */

import { db } from "@/lib/db";
import { logError, logWarn } from "@/lib/validation/safe-log";

/** Which flow produced a message. Drives template selection at send time. */
export type EmailKind = "magic_link" | "invite" | "password_reset" | "pilot_request";

export type EmailState = "PENDING" | "SENDING" | "SENT" | "DEAD";

/** Retry ladder. Six attempts over roughly an hour, then DEAD. */
export function maxAttempts(): number {
  return 6;
}

/**
 * Exponential backoff with jitter, matching outbox.backoffMs so an operator
 * reading one outbox can reason about the other. Jitter matters more here than
 * for bank webhooks: when a provider has an outage, every queued message
 * retries on the same schedule otherwise and re-creates the burst that caused
 * the rate limit.
 */
export function backoffMs(attempts: number, rand: number = Math.random()): number {
  const base = Math.min(2 ** attempts * 1000, 15 * 60_000);
  return Math.floor(base * (0.5 + rand * 0.5));
}

export type EnqueueInput = {
  kind: EmailKind;
  toEmail: string;
  subject: string;
  /** Non-credential props for re-render. NEVER include a token or signed URL. */
  props: Record<string, string | number | null>;
};

/** Persist a message for delivery. Does NOT send. */
export async function enqueueEmail(input: EnqueueInput): Promise<{ id: string }> {
  const row = await db.emailOutbox.create({
    data: {
      kind: input.kind,
      toEmail: input.toEmail,
      subject: input.subject,
      // Canonical-ish JSON: stable key order makes the row diffable when
      // debugging "why did the retry render differently".
      payload: JSON.stringify(input.props),
      state: "PENDING",
    },
    select: { id: true },
  });
  return row;
}

/**
 * Claim a batch with FOR UPDATE SKIP LOCKED + a compare-and-set re-assert on
 * the UPDATE's own WHERE.
 *
 * The CAS is not optional. SKIP LOCKED alone does not claim a row across two
 * statements, so two workers can both select the same id and both send the same
 * magic link — which for a single-use credential means one of the two operators
 * receives a link that no longer works. Re-checking state means the loser's
 * UPDATE affects zero rows and it never sees the row at all.
 */
export async function claimBatch(
  limit = 10,
  leaseMs = 5 * 60_000,
): Promise<
  {
    id: string;
    kind: string;
    toEmail: string;
    subject: string;
    payload: string;
    attempts: number;
  }[]
> {
  const stale = new Date(Date.now() - leaseMs);
  const rows = await db.$queryRaw<
    {
      id: string;
      kind: string;
      toEmail: string;
      subject: string;
      payload: string;
      attempts: number;
    }[]
  >`
    UPDATE "EmailOutbox" e
       SET state = 'SENDING', "updatedAt" = now()
     WHERE e.id IN (
       SELECT id FROM "EmailOutbox"
        WHERE (state = 'PENDING' AND "nextAttemptAt" <= now())
           OR (state = 'SENDING' AND "updatedAt" < ${stale})
        ORDER BY "nextAttemptAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
     )
     AND (
       (e.state = 'PENDING' AND e."nextAttemptAt" <= now())
       OR (e.state = 'SENDING' AND e."updatedAt" < ${stale})
     )
    RETURNING e.id, e.kind, e."toEmail", e.subject, e.payload, e.attempts
  `;
  return rows;
}

export type SendOutcome = { id: string; status: "SENT"; attempts: number } | {
  id: string;
  status: "RETRY";
  attempts: number;
  nextAttemptAt: Date;
  reason: string;
} | { id: string; status: "DEAD"; attempts: number; reason: string };

/**
 * Send one claimed message via the Resend sender.
 *
 * `sendRaw` is injected rather than imported directly so the retry logic is
 * testable without a provider key and without a network. It returns a failure
 * reason instead of throwing, because "provider rejected this" and "the network
 * blipped" want different treatment: both retry here, but only the second is
 * worth a support page.
 */
export async function deliverEmail(
  row: { id: string; kind: string; toEmail: string; subject: string; payload: string; attempts: number },
  sendRaw: (input: { to: string; subject: string; kind: string; props: Record<string, unknown> }) => Promise<
    { ok: true; id: string } | { ok: false; reason: string }
  >,
): Promise<SendOutcome> {
  const attempt = row.attempts + 1;

  let props: Record<string, unknown>;
  try {
    props = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    // Unparseable payload will never parse on a retry either. Do not burn the
    // ladder on it.
    await markDead(row.id, attempt, "payload is not valid JSON");
    return { id: row.id, status: "DEAD", attempts: attempt, reason: "bad payload" };
  }

  let result: Awaited<ReturnType<typeof sendRaw>>;
  try {
    result = await sendRaw({
      to: row.toEmail,
      subject: row.subject,
      kind: row.kind,
      props,
    });
  } catch (cause) {
    result = { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }

  if (result.ok) {
    await db.emailOutbox.update({
      where: { id: row.id },
      data: {
        state: "SENT",
        sentAt: new Date(),
        attempts: attempt,
        lastError: null,
        // The provider's id is the ONLY key a delivery webhook carries, so it is
        // recorded here or a later bounce cannot be matched to this row. The
        // sender returns the literal "unknown" when Resend accepted the message
        // without echoing an id — storing that sentinel would create a column of
        // identical "unknown" values that match nothing, so it is dropped to
        // null instead and reported as unmatched.
        ...(result.id && result.id !== "unknown" ? { providerMessageId: result.id } : {}),
      },
    });
    return { id: row.id, status: "SENT", attempts: attempt };
  }

  // The address is logged because it is what support needs; it is not a secret
  // and it is the same value the operator just typed into the form.
  logWarn("[email-outbox] send failed", { id: row.id, kind: row.kind, to: row.toEmail, attempt });

  if (attempt >= maxAttempts()) {
    await markDead(row.id, attempt, result.reason);
    return { id: row.id, status: "DEAD", attempts: attempt, reason: result.reason };
  }

  const nextAttemptAt = new Date(Date.now() + backoffMs(attempt));
  await db.emailOutbox.update({
    where: { id: row.id },
    data: { state: "PENDING", attempts: attempt, lastError: result.reason, nextAttemptAt },
  });
  return { id: row.id, status: "RETRY", attempts: attempt, nextAttemptAt, reason: result.reason };
}

async function markDead(id: string, attempts: number, error: string): Promise<void> {
  await db.emailOutbox.update({
    where: { id },
    data: { state: "DEAD", attempts, lastError: error.slice(0, 500) },
  });
  // Deliberately NOT a bank DeadLetter row: that table's replay endpoint
  // re-signs and re-POSTs a canonical-JSON body to a bank URL. Replaying an
  // email through it would attempt to deliver a sign-in link to a bank's
  // webhook endpoint.
  logError("[email-outbox] message exhausted retries", { id, attempts });
}

/* ── Delivery signals (provider webhooks) ───────────────────────────────────── */

/**
 * What a delivery webhook told us about a message we already sent.
 *
 * These arrive AFTER the send succeeded, so they are a different axis from the
 * retry ladder: `deliverEmail` decides whether the PROVIDER accepted the
 * message; these decide whether it then reached the human.
 */
export type DeliverySignal = "bounced" | "complained" | "delayed" | "delivered";

export type DeliverySignalOutcome =
  | { matched: true; id: string; state: EmailState; signal: DeliverySignal }
  | { matched: false; signal: DeliverySignal; reason: "no_provider_message_id" | "unknown_message_id" };

/**
 * Apply a provider delivery signal to the outbox row that produced the message.
 *
 * Matching is by `providerMessageId` — the only identifier a delivery webhook
 * carries. An unmatched signal is RETURNED as `matched: false` rather than
 * swallowed: a bounce nobody can attach to a row means the address is still
 * being retried, and silently ignoring it would hide exactly that.
 *
 * Treatment per signal:
 *
 *   · **bounced** → DEAD. A hard bounce is terminal: the address does not
 *     exist. Retrying it burns the ladder and, worse, repeated sends to a
 *     bouncing address damage the sending domain's reputation. `attempts` is
 *     left as-is so the row still records how many sends it took to give up.
 *   · **complained** → DEAD. A spam complaint is a human saying "stop". Sending
 *     again after one is how a domain gets blocklisted.
 *   · **delayed** → lastError only, state UNCHANGED. A delay is not a failure;
 *     the message may still arrive, and flipping a SENT row back to PENDING
 *     would re-send a magic link that has already been delivered.
 *   · **delivered** → lastError cleared, state unchanged. `SENT` already means
 *     "the provider accepted it"; this closes the loop without inventing a
 *     fifth state the drain worker would have to understand.
 *
 * `reason` is truncated to the column's bound, matching markDead.
 */
export async function applyDeliverySignal(input: {
  providerMessageId: string | null | undefined;
  signal: DeliverySignal;
  reason: string;
}): Promise<DeliverySignalOutcome> {
  const { providerMessageId, signal, reason } = input;

  if (!providerMessageId) {
    return { matched: false, signal, reason: "no_provider_message_id" };
  }

  const row = await db.emailOutbox.findFirst({
    where: { providerMessageId },
    select: { id: true, state: true },
  });
  if (!row) {
    return { matched: false, signal, reason: "unknown_message_id" };
  }

  if (signal === "bounced" || signal === "complained") {
    const detail = `${signal}: ${reason}`.slice(0, 500);
    await db.emailOutbox.update({
      where: { id: row.id },
      data: { state: "DEAD", lastError: detail },
    });
    logError("[email-outbox] delivery signal terminated the message", {
      id: row.id,
      signal,
    });
    return { matched: true, id: row.id, state: "DEAD", signal };
  }

  if (signal === "delayed") {
    await db.emailOutbox.update({
      where: { id: row.id },
      // State deliberately untouched: see the doc comment.
      data: { lastError: `delayed: ${reason}`.slice(0, 500) },
    });
    logWarn("[email-outbox] delivery delayed", { id: row.id });
    return { matched: true, id: row.id, state: row.state as EmailState, signal };
  }

  await db.emailOutbox.update({
    where: { id: row.id },
    data: { lastError: null },
  });
  return { matched: true, id: row.id, state: row.state as EmailState, signal };
}

/** Drain one batch. Called by the cron/worker tick. */
export async function drainEmailOutbox(
  limit = 10,
  sendRaw: Parameters<typeof deliverEmail>[1],
): Promise<SendOutcome[]> {
  const rows = await claimBatch(limit);
  const results: SendOutcome[] = [];
  for (const row of rows) {
    results.push(await deliverEmail(row, sendRaw));
  }
  return results;
}