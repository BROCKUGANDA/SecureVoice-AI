import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSignedIn } from "@/lib/credits";
import { consume as consumeRateLimit } from "@/lib/ratelimit";
import {
  badRequest,
  parseJson,
  tooManyRequests,
  unprocessable,
  upstreamError,
} from "@/lib/api-errors";
import { redactPII } from "@/lib/compliance/redactor";
import { enqueueAndSendEmail } from "@/lib/email/queue";
import { isEmailConfigured } from "@/lib/email/resend";
import { SUPPORT_EMAIL } from "@/lib/public-config";
import { logError } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

/**
 * POST /api/support/ticket — an operator reports a problem, with the context
 * support actually needs attached: the SESSION's organization id and an
 * optional intervention (case) reference.
 *
 * ── Why there is no support_tickets table ────────────────────────────────────
 * The durable artifact is the `EmailOutbox` row on the existing Resend path
 * (`enqueueAndSendEmail`) — row first, send second, retried by the drain worker
 * on failure. A second table would be a second store to keep in sync with the
 * mailbox the ticket lands in, and the console already reads that mailbox
 * (src/components/console/MailInbox.tsx). What this route adds over the pilot
 * form is not storage — it is the CONTEXT: org id, intervention ref, and the
 * operator's own session-derived identity.
 *
 * ── The redaction guarantee, and where it is enforced ────────────────────────
 * `redactPII` runs on the free-text message BEFORE the row is written. That
 * ordering is the whole guarantee: the persisted payload is what a drain retry
 * re-renders from, so scrubbing after persistence would leave the raw PAN/SSN
 * in the database and re-send it on every attempt. The route test asserts the
 * ROW (not the response) contains no raw identifier, so it holds regardless of
 * what the handler claims.
 *
 * ── orgId is never read from the body ────────────────────────────────────────
 * `requireSignedIn` resolves the active organization from the session
 * (src/lib/credits.ts — "NEVER read from a header, a query parameter or a
 * request body"); the request schema does not even declare an orgId field, so
 * a body-supplied value is stripped by parsing and can never reach the row. A
 * "demo" session with no organization files a ticket with orgId null, which is
 * stated in the notification rather than invented.
 *
 * ── Honest verdicts ──────────────────────────────────────────────────────────
 *   401/403  no session                        (nothing written)
 *   429      rate limit per operator           (nothing written)
 *   400/422  malformed body / invalid fields   (nothing written)
 *   503      mail unarmed, or the queue refused the row (nothing promised)
 *   202      accepted — `delivery` says whether the first attempt sent it
 *            ("sent") or the durable row is waiting on the retry ladder
 *            ("queued"). 202 rather than 200 because delivery is async in the
 *            "queued" case and the row, not the response, is the record.
 */

/** Per-operator budget. A report is text, but an unbounded loop of them is a
 *  spam cannon aimed at the support inbox, so the cap is deliberately small. */
const RATE_LIMIT_PER_HOUR = 10;

const ticketSchema = z.object({
  message: z
    .string()
    .trim()
    .min(10, "Tell us what happened — at least 10 characters.")
    .max(2000, "Keep the report under 2000 characters."),
  // An identifier, not free text. This value is rendered in the notification
  // and joined to a case by eye, so anything that is not ref-shaped (a pasted
  // phone number, a full sentence) is refused rather than carried into an
  // email. The pilot route's P2002 loop does not apply here: the ref is a
  // human handle inside the payload, not a unique key, so collisions between
  // two tickets are a curiosity rather than a constraint violation.
  interventionRef: z
    .string()
    .trim()
    .max(80)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/,
      "Intervention reference must be an identifier (letters, digits, . _ : -).",
    )
    .optional()
    .or(z.literal("")),
});

/** Same alphabet as the pilot reference: no 0/O/1/I/L confusables. */
const REF_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function makeRef(): string {
  let s = "";
  for (let i = 0; i < 5; i++) {
    s += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
  }
  return `SV-S-${s}`;
}

export async function POST(req: NextRequest) {
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const profile = guard.profile;

  const rl = consumeRateLimit("support-ticket", profile.userId, 1, RATE_LIMIT_PER_HOUR);
  if (!rl.ok) {
    return tooManyRequests("Too many reports from this account; retry later.", rl);
  }

  const raw = await parseJson(req);
  if (raw === null) return badRequest("Invalid JSON body");

  const parsed = ticketSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return unprocessable(first?.message ?? "Please check the form and try again.");
  }
  const d = parsed.data;

  // A deployment without the provider key cannot deliver this. Refusing here —
  // before a row exists — keeps the retry ladder free of messages that can
  // never succeed and stops the response from promising an email nobody will
  // send. Same verdict the fire route gives its unarmed WEBHOOK_SECRET.
  if (!isEmailConfigured()) {
    return upstreamError(
      "Support email is not configured in this deployment (RESEND_API_KEY unset) — nothing was sent.",
    );
  }

  const ref = makeRef();
  const interventionRef = (d.interventionRef || "").trim() || null;
  // Scrub BEFORE persistence — see the header. From here on the raw text does
  // not exist in any durable form or in any send.
  const message = redactPII(d.message);

  let result: Awaited<ReturnType<typeof enqueueAndSendEmail>>;
  try {
    result = await enqueueAndSendEmail({
      kind: "support_ticket",
      toEmail: SUPPORT_EMAIL,
      subject: `Support ticket ${ref} — ${profile.email}`,
      token: "",
      // The column this stamps is what the tenant_scope policy on EmailOutbox
      // was written for — the first flow that knows its tenant at send time.
      orgId: profile.orgId,
      props: {
        ref,
        orgId: profile.orgId,
        operatorName: profile.name,
        operatorEmail: profile.email,
        interventionRef,
        message,
      },
    });
  } catch (err) {
    // `sendQueuedEmail` can throw AFTER the row was committed (e.g. a missing
    // APP_BASE_URL while building the footer). The queued row is the record,
    // so this is "queued", never a 500 about a report that is on disk.
    logError("[support/ticket] send threw after enqueue", {
      ref,
      error: err instanceof Error ? err.message : String(err),
    });
    return accepted(ref, profile.orgId, "queued");
  }

  if (!result.ok && result.reason === "queue_failed") {
    // Nothing durable exists, so there is nothing honest to accept.
    return upstreamError("The report could not be recorded; please try again.");
  }

  return accepted(ref, profile.orgId, result.ok ? "sent" : "queued");
}

function accepted(ref: string, orgId: string | null, delivery: "sent" | "queued"): NextResponse {
  return NextResponse.json({ data: { ref, orgId, delivery } }, { status: 202 });
}
