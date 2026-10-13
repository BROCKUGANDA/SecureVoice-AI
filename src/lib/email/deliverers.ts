/**
 * The three transactional deliverers: magic link, invite, password reset.
 *
 * They lived in `@/lib/email/resend`, which made that file import
 * `@/lib/email/queue` while `queue.ts` imports `sendQueuedEmail` from it — a
 * cycle (`gitnexus check --cycles`). It was inert only because both sides are
 * hoisted `export async function` declarations, so nothing called either during
 * module evaluation. That is a property of today's code, not a guarantee, and a
 * future call at import time would fail at boot rather than at the offending
 * line.
 *
 * Placing them here makes the graph acyclic and one-directional:
 *
 *     queue.ts ──▶ resend.ts            (the transport)
 *     deliverers.ts ──▶ queue.ts        (row first, send second)
 *     deliverers.ts ──▶ resend.ts       (baseUrl + subject table)
 *
 * `baseUrl` and `SUBJECTS` are imported rather than duplicated: a link and its
 * subject that disagree between two modules is exactly the drift this avoids.
 */
import { enqueueAndSendEmail } from "@/lib/email/queue";
import { baseUrl, SUBJECTS } from "@/lib/email/resend";

/**
 * Magic-link deliverer. Matches `MagicLinkDeliverer`
 * (src/lib/auth/magic-link.ts:54) so it can be passed straight to
 * `issueMagicLink`.
 *
 * THROWS on failure, so the route can 503 rather than promise a link that was
 * never delivered. `issueMagicLink` has already written the token to the store
 * by the time it calls `deliver`; a queued row now exists either way, and the
 * drain worker retries.
 *
 * The token is never logged. It exists here only to be put in the URL and is
 * never persisted.
 */
export async function deliverMagicLink(input: {
  email: string;
  token: string;
  expiresAt: number;
}): Promise<void> {
  const origin = baseUrl();
  const result = await enqueueAndSendEmail({
    kind: "magic_link",
    toEmail: input.email,
    subject: SUBJECTS.magicLink,
    token: input.token,
    props: { expiresAt: input.expiresAt, baseUrl: origin, name: null },
  });
  if (!result.ok) {
    throw new Error(`magic-link delivery failed (${result.reason}): ${result.detail}`);
  }
}

/**
 * Invite deliverer. Single use, bound to the address, 72 hours — matching
 * src/lib/auth/invite.ts and the copy in templates/invite.tsx.
 *
 * Queued-then-attempted like the magic link. Also throws on a synchronous
 * failure so the invite route can report honestly rather than returning 201
 * for an email that bounced.
 */
export async function deliverInvite(input: {
  email: string;
  token: string;
  expiresAt: number;
  role?: string | null;
}): Promise<void> {
  const origin = baseUrl();
  const result = await enqueueAndSendEmail({
    kind: "invite",
    toEmail: input.email,
    subject: SUBJECTS.invite,
    token: input.token,
    props: { expiresAt: input.expiresAt, baseUrl: origin, role: input.role ?? null, name: null },
  });
  if (!result.ok) {
    throw new Error(`invite delivery failed (${result.reason}): ${result.detail}`);
  }
}

/**
 * Better Auth `sendResetPassword` / `sendVerificationEmail` handler.
 *
 * Signature matches Better Auth's `sendResetPassword` exactly (user, token,
 * url) — see src/lib/better-auth.ts for where it is wired.
 */
export async function sendResetPassword(input: {
  user: { email: string; name?: string | null };
  url: string;
}): Promise<void> {
  const origin = baseUrl();
  // The token is parsed back OUT of the URL so it can be put in the retry-safe
  // props while still never being stored. If the URL is not one we minted, we
  // refuse rather than queue something we cannot reproduce.
  let token: string | null = null;
  try {
    token = new URL(input.url).searchParams.get("token");
  } catch {
    token = null;
  }
  if (!token) {
    throw new Error("password-reset URL did not carry a token; refusing to queue");
  }
  const result = await enqueueAndSendEmail({
    kind: "password_reset",
    toEmail: input.user.email,
    subject: SUBJECTS.passwordReset,
    token,
    props: {
      // Better Auth does not hand the expiry over; state the window this
      // template advertises rather than printing a fabricated timestamp.
      expiresAt: Date.now() + 60 * 60 * 1000,
      baseUrl: origin,
      name: input.user.name ?? null,
    },
  });
  if (!result.ok) {
    throw new Error(`password-reset delivery failed (${result.reason}): ${result.detail}`);
  }
}
