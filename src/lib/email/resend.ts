import "server-only";
/**
 * Resend sender — the ONE place that talks to the mail provider.
 *
 * ── Why Resend's HTTP API and not the SMTP details ───────────────────────────
 * The deployment notes list smtp.resend.com:465 (implicit TLS) and 2465/587/
 * 2587 (STARTTLS). SMTP was deliberately NOT used here:
 *
 *   · An SMTP connection means a long-lived socket, a retry queue, and a
 *     per-connection state machine. In an app that scales horizontally behind
 *     Caddy, "which replica holds the in-flight connection" is a problem this
 *     project does not need to have.
 *   · Resend's HTTPS API is request/response: a failed send is a thrown error
 *     that the caller can decide about, rather than a message sitting in a
 *     process-local spool that vanishes on deploy.
 *   · The SMTP credentials are the same API key either way, so choosing SMTP
 *     would add a dependency (nodemailer + a pool manager) and buy nothing.
 *
 * If SMTP is ever genuinely required — an on-prem relay that cannot reach the
 * public API, say — the seam for it is `sendEmail()` below. Swap its body, keep
 * the signature and the templates untouched.
 *
 * ── Secrets ──────────────────────────────────────────────────────────────────
 * The API key is read from the environment and NEVER passed in. There is no
 * default, no fallback literal, and no key-shaped string anywhere in this
 * repository. `RESEND_API_KEY` is a gitignored runtime secret
 * (.gitignore:32 `.env*`); .env.example documents the name without a value.
 *
 * ── Logging ──────────────────────────────────────────────────────────────────
 * Failure logs carry the error, the provider's message, and the RECIPIENT
 * ADDRESS — never the sign-in token and never the full URL. A support engineer
 * debugging "the link did not arrive" needs to know which address failed; they
 * never need the usable credential, and a log line containing one is a
 * password-reset token with a retention policy.
 */

import { Resend } from "resend";
import { render } from "@react-email/render";
import { enqueueAndSendEmail } from "@/lib/email/queue";

/** Subject lines. Centralised so the three templates cannot drift in tone. */
const SUBJECTS = {
  magicLink: "Your SecureVoice sign-in link",
  invite: "You have been invited to SecureVoice",
  passwordReset: "Reset your SecureVoice password",
} as const;

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; reason: "not_configured" | "render_failed" | "send_failed"; detail: string };

/**
 * Lazily-constructed client. Constructing Resend at module scope would throw
 * on import in every environment lacking a key (CI, the test suite, a laptop),
 * which is the same class of bug the BETTER_AUTH_SECRET guard in better-auth.ts
 * documents — there, deliberately; here, avoided.
 */
let client: Resend | null = null;
let clientInit = false;

function getClient(): Resend | null {
  if (clientInit) return client;
  clientInit = true;
  const key = process.env.RESEND_API_KEY;
  if (!key || !key.startsWith("re_")) {
    return null;
  }
  client = new Resend(key);
  return client;
}

/** True when this deployment can actually send. Used by the routes' gates. */
export function isEmailConfigured(): boolean {
  return getClient() !== null;
}

/**
 * From address. Defaults to the Resend onboarding domain when unset, but the
 * explicit variable is preferred: a fraud console should send from a domain it
 * controls so SPF/DKIM/DMARC align on the operator's own domain rather than a
 * shared Resend subdomain. See docs/DEPLOY.md for the DNS records.
 */
function fromAddress(): string {
  // The published sender is support@ on the domain we actually control. The
  // `onboarding@resend.dev` fallback was a Resend shared-subdomain placeholder:
  // it survives only for a laptop with no `.env`, because sending production
  // mail from a shared Resend subdomain breaks SPF/DKIM alignment for the
  // operator's own domain. Set RESEND_FROM_EMAIL in every real deployment.
  return process.env.RESEND_FROM_EMAIL ?? "SecureVoice AI <support@securevoiceai.me>";
}

/** Reply-to. Bounces must not go to a no-reply address nobody monitors. */
function replyTo(): string | undefined {
  return (
    process.env.RESEND_REPLY_TO ??
    process.env.NEXT_PUBLIC_SUPPORT_EMAIL ??
    "support@securevoiceai.me"
  );
}

/**
 * Deployment origin, used to build links and for the templates' verification
 * lines. Falls back to APP_URL so a deployment that set neither still produces
 * a coherent (if local) link rather than "undefined/auth/...".
 */
function baseUrl(): string {
  const raw = process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL;
  if (!raw) {
    throw new Error("APP_BASE_URL (or NEXT_PUBLIC_APP_URL) must be set to build email links");
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Build an absolute URL from a path and its query parameters.
 *
 * Single funnel on purpose: if a template is handed a half-built string from
 * anywhere else in the codebase, a missing slash or an unencoded token becomes
 * a link that 404s or, worse, one that lands on an unexpected host.
 */
export function buildLink(path: string, params: Record<string, string>): string {
  const url = new URL(path, `${baseUrl()}/`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Render JSX to HTML and hand it to Resend. The only provider call in the app.
 *
 * Never throws: every failure is a `SendResult` so callers can make a decision
 * (fail the request, or accept it and let the operator retry) without a
 * try/catch at every call site.
 */
async function sendEmail(input: {
  to: string;
  subject: string;
  element: React.ReactElement;
}): Promise<SendResult> {
  const resend = getClient();
  if (!resend) {
    return { ok: false, reason: "not_configured", detail: "RESEND_API_KEY is unset or malformed" };
  }

  let html: string;
  let text: string;
  try {
    // `text` is the plain-text alternative. It matters more than usual here:
    // corporate gateways strip HTML aggressively, and the templates carry a
    // plain-text copy of the link precisely for that case.
    [html, text] = await Promise.all([
      render(input.element),
      render(input.element, { plainText: true }),
    ]);
  } catch (cause) {
    return { ok: false, reason: "render_failed", detail: describe(cause) };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: fromAddress(),
      to: input.to,
      subject: input.subject,
      html,
      text,
      replyTo: replyTo(),
      // Tags scope sending in the Resend dashboard (which template, which
      // flow) without inspecting message content.
      tags: [{ name: "category", value: "auth" }],
    });
    if (error) {
      // The recipient address is included deliberately: it is not a secret and
      // it is the field support needs. The token is NOT in this string.
      console.error("[email] send failed", { to: input.to, detail: error.message });
      return { ok: false, reason: "send_failed", detail: error.message };
    }
    return { ok: true, id: data?.id ?? "unknown" };
  } catch (cause) {
    console.error("[email] send threw", { to: input.to, detail: describe(cause) });
    return { ok: false, reason: "send_failed", detail: describe(cause) };
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/* ── Deliverers ─────────────────────────────────────────────────────────────── */

/**
 * Render + send a queued row at drain time. The `props` are the
 * credential-FREE values stored in EmailOutbox.payload (expiry, origin, role)
 * plus a freshly-built token, which the drain caller supplies because the token
 * is never persisted.
 *
 * This is the function handed to `drainEmailOutbox` as `sendRaw`.
 */
export async function sendQueuedEmail(input: {
  to: string;
  subject: string;
  kind: string;
  props: Record<string, unknown>;
}): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const token = typeof input.props.token === "string" ? input.props.token : null;
  const expiresAt = typeof input.props.expiresAt === "number" ? input.props.expiresAt : Date.now();
  const origin = typeof input.props.baseUrl === "string" ? input.props.baseUrl : baseUrl();
  const role = typeof input.props.role === "string" ? input.props.role : null;
  const name = typeof input.props.name === "string" ? input.props.name : null;
  // Each link points at the page that CONSUMES its token, not at a form that
  // collects one. The verify page redeems and sets the session cookie itself.
  const signInUrl = buildLink("/auth/magic-link/verify", { token: token ?? "" });
  const inviteUrl = buildLink("/auth/invites/accept", { token: token ?? "" });
  // The reset link must land on the page that CONSUMES a reset token
  // (POST /api/auth/reset/confirm). Pointing it at /auth/magic-link would post a
  // reset token to the magic-link verifier, which hashes it under a different
  // scope and always fails — the user would be told the link was invalid on a
  // link that was perfectly good.
  const resetUrl = buildLink("/auth/reset-password/confirm", { token: token ?? "" });

  switch (input.kind) {
    case "magic_link": {
      const { MagicLinkEmail } = await import("@/lib/email/templates/magic-link");
      return sendEmail({
        to: input.to,
        subject: input.subject,
        element: MagicLinkEmail({ signInUrl, baseUrl: origin, expiresAt, name }),
      });
    }
    case "invite": {
      const { InviteEmail } = await import("@/lib/email/templates/invite");
      return sendEmail({
        to: input.to,
        subject: input.subject,
        element: InviteEmail({ inviteUrl, baseUrl: origin, expiresAt, role, name }),
      });
    }
    case "password_reset": {
      const { PasswordResetEmail } = await import("@/lib/email/templates/password-reset");
      return sendEmail({
        to: input.to,
        subject: input.subject,
        element: PasswordResetEmail({ resetUrl, baseUrl: origin, expiresAt, name }),
      });
    }
    case "pilot_request": {
      // Internal notification, not a customer mail. Every field comes from the
      // stored props (the submitter's own values), so a drain retry re-renders
      // the same message without needing the request to still be in memory.
      const { PilotRequestEmail } = await import("@/lib/email/templates/pilot-request");
      return sendEmail({
        to: input.to,
        subject: input.subject,
        element: PilotRequestEmail({
          ref: typeof input.props.ref === "string" ? input.props.ref : "unknown",
          name: typeof input.props.name === "string" ? input.props.name : "unknown",
          email: typeof input.props.email === "string" ? input.props.email : "unknown",
          institution:
            typeof input.props.institution === "string" ? input.props.institution : "unknown",
          role: typeof input.props.role === "string" ? input.props.role : null,
          volume: typeof input.props.volume === "string" ? input.props.volume : null,
          message: typeof input.props.message === "string" ? input.props.message : null,
          source: typeof input.props.source === "string" ? input.props.source : "website",
          baseUrl: origin,
        }),
      });
    }
    case "support_ticket": {
      // Operator report → our own support inbox. The message was scrubbed by
      // `redactPII` BEFORE the row was written (src/app/api/support/ticket/route.ts),
      // so a drain retry re-renders exactly the same already-redacted text and
      // no retry can reintroduce a raw identifier.
      const { SupportTicketEmail } = await import("@/lib/email/templates/support-ticket");
      return sendEmail({
        to: input.to,
        subject: input.subject,
        element: SupportTicketEmail({
          ref: typeof input.props.ref === "string" ? input.props.ref : "unknown",
          orgId: typeof input.props.orgId === "string" ? input.props.orgId : null,
          operatorName:
            typeof input.props.operatorName === "string" ? input.props.operatorName : "unknown",
          operatorEmail:
            typeof input.props.operatorEmail === "string" ? input.props.operatorEmail : "unknown",
          interventionRef:
            typeof input.props.interventionRef === "string" ? input.props.interventionRef : null,
          message: typeof input.props.message === "string" ? input.props.message : "",
          baseUrl: origin,
        }),
      });
    }
    default:
      return { ok: false, reason: `unknown email kind: ${input.kind}` };
  }
}

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
