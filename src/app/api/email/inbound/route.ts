import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { payload as redactPayload } from "@/lib/redact";
import { applyDeliverySignal, type DeliverySignal } from "@/lib/email/outbox";
import { logError, logWarn } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

/**
 * POST /api/email/inbound — the RECEIVE half of the email surface.
 *
 * Mail addressed to support@ / legal@ / founder@ on `securevoiceai.me` is
 * delivered by Resend to this endpoint (Resend dashboard → Webhooks → add
 * `email.received` → this URL). One row per message lands in `EmailInbound`, so
 * the console can show an inbox rather than an operator having to log into the
 * mailbox to know a bank wrote in.
 *
 * ## It also takes the OUTBOUND delivery signals
 *
 * The same endpoint handles `email.bounced`, `email.complained`,
 * `email.delivery_delayed` and `email.delivered` — what happened to mail WE sent
 * — because Resend delivers both families to one URL and both need the identical
 * signature check. Those are matched back to their `EmailOutbox` row by
 * `providerMessageId` (recorded at send time) and applied by
 * `applyDeliverySignal`: a bounce or complaint marks the row DEAD so the address
 * is not retried, a delay is recorded without changing state, and a delivery
 * clears the error. An unmatched signal is REPORTED in the response, never
 * swallowed.
 *
 * ## Signature scheme (Svix — Resend's webhook signer)
 *
 * Headers: `svix-id`, `svix-timestamp`, `svix-signature`.
 * Signed content: `${svix-id}.${svix-timestamp}.${rawBody}`.
 * Key: the `whsec_` secret from `RESEND_WEBHOOK_SECRET`, base64-decoded after
 * the prefix. `svix-signature` carries one or more space-separated
 * `v1,<base64>` entries during a secret rotation, so ANY match is a pass.
 *
 * A replay window (5 minutes) is enforced on `svix-timestamp`; without it a
 * captured delivery could be replayed forever, which for an inbound-email
 * webhook means an attacker can inject arbitrary mail into the inbox.
 *
 * ## Why the body is redacted and truncated
 *
 * An inbound email is UNTRUSTED content from the public internet. In a bank
 * integration it may quote a customer's PII, and it is the classic injection
 * vector into whatever reads the inbox next. Only redacted, length-capped plain
 * text is stored; the raw HTML is never persisted. The mailbox keeps the
 * original.
 *
 * ## Failure discipline
 *
 * 4xx for a verification failure (never 5xx — a 5xx makes the provider retry a
 * delivery that can never succeed), 2xx fast on success so Resend does not
 * queue retries behind our database write.
 */

const REPLAY_WINDOW_SECONDS = 300;
const MAX_BODY_CHARS = 20_000;

/** Decodes the Svix signing key. `whsec_` + base64, but a bare base64 value is
 * tolerated so a hand-set secret still works. Returns null when unusable. */
function signingKey(secret: string): Buffer | null {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  try {
    const buf = Buffer.from(raw, "base64");
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

function verifySvix(
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  rawBody: string,
  secret: string,
): { ok: true } | { ok: false; reason: string } {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing_signature_headers" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad_timestamp" };
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (ageSeconds > REPLAY_WINDOW_SECONDS) return { ok: false, reason: "timestamp_out_of_window" };

  const key = signingKey(secret);
  if (!key) return { ok: false, reason: "signing_key_unusable" };

  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
  // `svix-signature` is a space-separated list of `v1,<base64>` entries.
  for (const entry of signature.split(" ")) {
    const [version, b64] = entry.split(",");
    if (version !== "v1" || !b64) continue;
    let candidate: Buffer;
    try {
      candidate = Buffer.from(b64, "base64");
    } catch {
      continue;
    }
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "signature_mismatch" };
}

/** Extracts a string field defensively: the payload shape is the provider's,
 * and an unexpected shape must degrade to "unknown", never to a 500. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function firstAddress(v: unknown): { email: string; name: string | null } | null {
  // Resend sends `from` as "Name <addr@host>" and `to` as an array of the same.
  const raw = Array.isArray(v) ? v.find((x) => typeof x === "string") : v;
  const s = str(raw);
  if (!s) return null;
  const m = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(s);
  if (m) return { email: m[2]!.trim().toLowerCase(), name: m[1]!.trim() || null };
  return { email: s.trim().toLowerCase(), name: null };
}

/** Which of our mailboxes this arrived on. Anything else is recorded as
 * `unknown` rather than dropped — an unexpected recipient is itself signal. */
function classifyRecipient(to: { email: string } | null): string {
  const addr = to?.email ?? "";
  if (addr.startsWith("support@")) return "support";
  if (addr.startsWith("legal@")) return "legal";
  if (addr.startsWith("founder@")) return "founder";
  return "unknown";
}

/**
 * Resend event type → the outbox signal it maps to.
 *
 * Only these four. `email.sent` and `email.opened`/`email.clicked` are NOT here:
 * "sent" duplicates what the API response already told us at send time, and
 * opens/clicks are marketing telemetry that a sign-in email has no use for —
 * recording them would put a tracking signal on a credential-bearing message.
 */
const DELIVERY_SIGNALS: Record<string, DeliverySignal> = {
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.delivery_delayed": "delayed",
  "email.delivered": "delivered",
};

/**
 * Pull a human-readable reason out of a delivery event, defensively.
 *
 * The nested shape is the provider's and has moved between versions, so this
 * tries the known locations in order and falls back to a bare event name. It
 * must never throw: a delivery webhook that 500s is one the provider retries
 * forever, and a missing reason string is not worth that.
 */
function deliveryReason(data: Record<string, unknown>): string {
  const bounce = (data.bounce ?? {}) as Record<string, unknown>;
  const candidates = [
    bounce.message,
    bounce.type,
    bounce.subType,
    data.reason,
    data.error,
    data.detail,
  ];
  for (const c of candidates) {
    const s = str(c);
    if (s) return s.slice(0, 300);
  }
  return "unspecified";
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const secret = process.env.RESEND_WEBHOOK_SECRET;

  if (!secret) {
    logError("email inbound unconfigured", { provider: "resend" });
    return NextResponse.json({ error: "ingest_unconfigured" }, { status: 503 });
  }

  const verdict = verifySvix(
    {
      id: req.headers.get("svix-id"),
      timestamp: req.headers.get("svix-timestamp"),
      signature: req.headers.get("svix-signature"),
    },
    raw,
    secret,
  );

  if (!verdict.ok) {
    // 4xx, exactly like the ElevenLabs ingest: a verification failure is the
    // sender's problem and must not be retried forever.
    logWarn("email inbound rejected", {
      provider: "resend",
      outcome: verdict.reason,
      bodyBytes: new TextEncoder().encode(raw).byteLength,
    });
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "malformed_body" }, { status: 400 });
  }

  const e = (event ?? {}) as Record<string, unknown>;
  const eventType = str(e.type) ?? "unknown";
  const data = (e.data ?? {}) as Record<string, unknown>;

  /*
   * Delivery signals — the OUTBOUND half of this endpoint.
   *
   * `email.received` is inbound mail. These four are what happened to mail WE
   * sent, and they are handled here because Resend delivers both to one endpoint
   * and both need the same signature verification.
   *
   * They identify the message ONLY by the provider's id, which is why
   * `EmailOutbox.providerMessageId` is written at send time. An unmatched signal
   * is reported in the response (`matched:false`) instead of being swallowed: a
   * bounce that cannot be attached to a row means the address is still queued for
   * retry, and silently ignoring it is how a domain keeps mailing a dead address.
   */
  const signal = DELIVERY_SIGNALS[eventType];
  if (signal) {
    const providerMessageId = str(data.email_id) ?? str(data.id);
    const outcome = await applyDeliverySignal({
      providerMessageId,
      signal,
      reason: deliveryReason(data),
    });
    if (!outcome.matched) {
      logWarn("email delivery signal unmatched", {
        provider: "resend",
        eventType,
        signal,
        reason: outcome.reason,
        providerMessageIdPresent: Boolean(providerMessageId),
      });
    }
    return NextResponse.json({
      ok: true,
      signal,
      matched: outcome.matched,
      ...(outcome.matched ? {} : { reason: outcome.reason }),
    });
  }

  // Inbound mail is the remaining handled case. Anything else is acknowledged so
  // Resend does not retry a delivery we have no use for.
  if (eventType !== "email.received") {
    return NextResponse.json({ ok: true, ignored: eventType });
  }

  const messageId = str(data.email_id) ?? str(data.id);
  if (!messageId) {
    logWarn("email inbound missing message id", { provider: "resend", eventType });
    return NextResponse.json({ error: "missing_message_id" }, { status: 400 });
  }

  const from = firstAddress(data.from);
  const to = firstAddress(data.to);
  const subject = str(data.subject) ?? "(no subject)";
  const rawText = str(data.text) ?? str(data.plain) ?? "";
  const attachmentNames = Array.isArray(data.attachments)
    ? data.attachments
        .map((a) => (a && typeof a === "object" ? str((a as Record<string, unknown>).name) : null))
        .filter((n): n is string => n !== null)
    : [];

  // Redact before storage. `redactPayload` is the same scanner the webhook
  // receiver and the audit chain use, so the PII rules stay in one place.
  const redacted = redactPayload({ text: rawText.slice(0, MAX_BODY_CHARS) });
  const bodyText = redacted.text.slice(0, MAX_BODY_CHARS);

  try {
    // Idempotent on messageId: a provider retry updates nothing and creates no
    // second row.
    await db.emailInbound.upsert({
      where: { messageId },
      create: {
        messageId,
        recipient: classifyRecipient(to),
        fromEmail: from?.email ?? "unknown",
        fromName: from?.name ?? null,
        subject: subject.slice(0, 500),
        bodyText,
        attachmentNames: JSON.stringify(attachmentNames.slice(0, 50)),
        verdict: str(data.verdict),
      },
      update: {},
    });
  } catch (err) {
    // A storage failure IS retryable, so this one is a 5xx and the provider
    // will try again.
    logError("email inbound persist failed", {
      provider: "resend",
      messageId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "persist_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
