"use client";

/**
 * Client halves of the four `/auth` routes.
 *
 * These pages export `metadata` (which only exists in a Server Component), so
 * each `page.tsx` is a thin server shell that renders one of these interactive
 * forms. `"use client"` is file-scoped, which is why the forms live here rather
 * than inside the page files.
 *
 * What all four share is a contract, not a look: the request pages acknowledge
 * a submission IDENTICALLY whether or not the address has an account. A page
 * that answered differently would be the account oracle the API routes
 * (src/app/api/auth/magic-link/route.ts, .../reset/route.ts) deliberately
 * refuse to be.
 *
 * Tokens are never rendered, never logged, and never placed in a URL that this
 * code builds beyond the redirect the email already implied.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { CheckCircle2, Loader2, Mail, TriangleAlert } from "lucide-react";
import { z } from "zod";
import { cn } from "@/lib/utils";

// ── Field schemas ────────────────────────────────────────────────────────────
// Mirrors the server's own bounds (min 3 / max 254 for an address; 12–200 for a
// password in src/lib/auth/password.ts) so the client rejects what the server
// would, before a round trip.

const emailSchema = z
  .string()
  .trim()
  .min(3, "Enter your email address.")
  .max(254, "That email address is too long.")
  .email("Enter a valid email address.");

const nameSchema = z
  .string()
  .trim()
  .min(1, "Enter your name.")
  .max(120, "That name is too long.");

const passwordSchema = z
  .string()
  .min(12, "Use at least 12 characters.")
  .max(200, "Use at most 200 characters.");

// ── Shared styling (existing design tokens only) ─────────────────────────────

const LABEL = "block text-[12.5px] font-semibold text-ink-2";
const INPUT =
  "mt-1.5 w-full rounded-xl border border-line bg-paper px-3.5 py-2.5 text-[14px] text-foreground outline-none transition placeholder:text-ink-3 focus:border-primary aria-[invalid=true]:border-red-soft";
const PRIMARY_BUTTON =
  "inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-6 py-3 text-[13.5px] font-semibold text-white transition hover:bg-green-deep disabled:cursor-not-allowed disabled:opacity-60";
const GHOST_BUTTON =
  "inline-flex w-full items-center justify-center gap-2 rounded-full border border-line bg-paper px-6 py-3 text-[13.5px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary";

// ── Small shared pieces ──────────────────────────────────────────────────────

function AuthShell({
  title,
  lead,
  children,
}: {
  title: string;
  lead?: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col justify-center px-6 py-16">
      <div className="rounded-3xl border border-line bg-white p-7 shadow-sm">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        {lead ? <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">{lead}</p> : null}
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-[13.5px] text-ink-2" role="status">
      <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
      {label}
    </p>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 text-[12.5px] text-red-soft">
      {message}
    </p>
  );
}

function FormAlert({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-xl border border-red-soft/30 bg-red-tint px-3.5 py-2.5 text-[12.5px] leading-relaxed text-red-soft"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{message}</span>
    </p>
  );
}

function OriginNote({ origin }: { origin: string }) {
  return (
    <p className="rounded-xl border border-line bg-paper px-3.5 py-2.5 text-[12px] leading-relaxed text-ink-3">
      Sign-in links are issued for <span className="font-mono text-ink-2">{origin}</span>. If you did
      not ask for one, you can close this page.
    </p>
  );
}

/** Read a JSON body defensively; a HEAD response or a non-JSON error is `null`. */
async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const data: unknown = await res.json();
    return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The server's `error` string when it sent one, otherwise our own wording. */
function messageFrom(data: Record<string, unknown> | null, fallback: string): string {
  const value = data?.error;
  return typeof value === "string" && value.trim() ? value : fallback;
}

// ── Password strength ────────────────────────────────────────────────────────

type StrengthScore = 0 | 1 | 2 | 3 | 4;

/**
 * A score derived from the properties that actually resist guessing — length
 * first, then character variety. Length alone is what the server enforces
 * (>= 12); the variety terms are advisory and only move the indicator.
 */
function passwordStrength(password: string): { score: StrengthScore; label: string } {
  if (password.length === 0) return { score: 0, label: "Enter a password" };

  let score = 0;
  if (password.length >= 12) score += 1;
  if (password.length >= 16) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;

  const clamped = Math.max(1, Math.min(4, score)) as 1 | 2 | 3 | 4;
  const labels: Record<1 | 2 | 3 | 4, string> = {
    1: "Weak",
    2: "Fair",
    3: "Good",
    4: "Strong",
  };
  return { score: clamped, label: labels[clamped] };
}

const STRENGTH_FILL: Record<1 | 2 | 3 | 4, string> = {
  1: "bg-red-soft",
  2: "bg-amber-soft",
  3: "bg-green-bright",
  4: "bg-primary",
};

function PasswordStrengthMeter({ password }: { password: string }) {
  const { score, label } = passwordStrength(password);
  return (
    <div className="mt-2">
      <div
        className="flex items-center gap-1.5"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={score}
        aria-label={`Password strength: ${label}`}
      >
        {[1, 2, 3, 4].map((segment) => (
          <span
            key={segment}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              score > 0 && segment <= score ? STRENGTH_FILL[score as 1 | 2 | 3 | 4] : "bg-line",
            )}
          />
        ))}
      </div>
      <p className="mt-1.5 text-[12px] text-ink-3" aria-live="polite">
        {label}
      </p>
    </div>
  );
}

// ── 1. Request a magic link ──────────────────────────────────────────────────

const NEUTRAL_MAGIC_LINK =
  "If that address belongs to an account, a sign-in link is on its way.";

export function MagicLinkRequest({ origin }: { origin: string }) {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  // Safety net, not the main path: the emailed link now points straight at
  // /auth/magic-link/verify (src/lib/email/resend.ts). A link that still lands
  // HERE with a token — an older message already in someone's inbox from before
  // that change — is forwarded rather than shown a form asking for the address
  // they just used to request it.
  useEffect(() => {
    if (token) router.replace(`/auth/magic-link/verify?token=${encodeURIComponent(token)}`);
  }, [token, router]);

  if (token) {
    return (
      <AuthShell title="Opening your sign-in link…">
        <Spinner label="Verifying your link…" />
      </AuthShell>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");

    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Enter a valid email address.");
      emailRef.current?.focus();
      return;
    }
    setFieldError("");
    setSubmitting(true);

    try {
      const res = await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: parsed.data }),
      });

      // 503 is a provider outage, not an account-existence signal, so it is the
      // one case we surface honestly rather than folding into the neutral 202.
      if (res.status === 503) {
        const data = await readJson(res);
        setFormError(
          messageFrom(data, "Sign-in email could not be sent. Please try again shortly."),
        );
        return;
      }
      if (res.ok) {
        setSent(true);
        return;
      }
      const data = await readJson(res);
      if (res.status === 422) {
        setFieldError(messageFrom(data, "Enter a valid email address."));
        emailRef.current?.focus();
        return;
      }
      setFormError(messageFrom(data, "Something went wrong. Please try again."));
    } catch {
      setFormError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <AuthShell title="Check your inbox">
        <div
          role="status"
          className="rounded-2xl border border-line bg-green-tint px-4 py-3.5 text-[13.5px] leading-relaxed text-green-deep"
        >
          <span className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Request received
          </span>
          <p className="mt-1.5 text-ink-2">{NEUTRAL_MAGIC_LINK}</p>
        </div>

        <div className="mt-4">
          <OriginNote origin={origin} />
        </div>

        <button
          type="button"
          className={cn(GHOST_BUTTON, "mt-4")}
          onClick={() => {
            setSent(false);
            setEmail("");
          }}
        >
          Use a different address
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Sign in"
      lead="Enter your work email and we will send a single-use sign-in link. There is no password to remember."
    >
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        <div>
          <label htmlFor="magic-link-email" className={LABEL}>
            Work email
          </label>
          <input
            id="magic-link-email"
            ref={emailRef}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? "magic-link-email-error" : undefined}
            className={INPUT}
            placeholder="you@yourbank.com"
          />
          <FieldError id="magic-link-email-error" message={fieldError} />
        </div>

        <FormAlert message={formError} />

        <button type="submit" className={PRIMARY_BUTTON} disabled={submitting}>
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Mail className="h-4 w-4" aria-hidden="true" />
          )}
          {submitting ? "Sending…" : "Email me a sign-in link"}
        </button>
      </form>

      <div className="mt-5">
        <OriginNote origin={origin} />
      </div>
    </AuthShell>
  );
}

// ── 2. Redeem a magic link ───────────────────────────────────────────────────

export function MagicLinkVerify() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const router = useRouter();

  const [state, setState] = useState<"verifying" | "ok" | "error">("verifying");
  const [message, setMessage] = useState("");
  const started = useRef(false);

  useEffect(() => {
    // Guard against React's development double-invoke: a magic-link token is
    // single-use, so a second redemption would fail on a link that just worked.
    if (started.current) return;
    started.current = true;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function run() {
      if (!token) {
        setState("error");
        setMessage("This sign-in link is missing its token. Request a new one below.");
        return;
      }
      try {
        const res = await fetch("/api/auth/magic-link/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (cancelled) return;

        if (res.ok) {
          setState("ok");
          // Brief confirmation before the browser lands on the Command Center.
          timer = setTimeout(() => router.replace("/"), 1200);
          return;
        }
        // 401 for every failure mode; the token itself is never echoed back.
        setState("error");
        setMessage("This sign-in link is not valid or has expired.");
      } catch {
        if (!cancelled) {
          setState("error");
          setMessage("Could not reach the server. Check your connection and open the link again.");
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [token, router]);

  if (state === "verifying") {
    return (
      <AuthShell title="Signing you in…">
        <Spinner label="Verifying your link…" />
      </AuthShell>
    );
  }

  if (state === "ok") {
    return (
      <AuthShell title="You are signed in">
        <p className="flex items-center gap-2 text-[13.5px] text-ink-2" role="status">
          <CheckCircle2 className="h-4 w-4 text-primary" aria-hidden="true" />
          Taking you to the Command Center…
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="This sign-in link is not valid or has expired">
      <p className="text-[13.5px] leading-relaxed text-ink-2">{message}</p>
      <Link href="/auth/magic-link" className={cn(PRIMARY_BUTTON, "mt-5")}>
        Request a new sign-in link
      </Link>
    </AuthShell>
  );
}

// ── 3. Accept an invitation ──────────────────────────────────────────────────

export function AcceptInvite() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const router = useRouter();

  const [check, setCheck] = useState<"checking" | "usable" | "unusable" | "missing">("checking");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [fieldError, setFieldError] = useState<{ name?: string; password?: string }>({});
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const started = useRef(false);

  // Validate the invitation before showing a form. `HEAD /api/auth/invites`
  // answers "usable" or gone; the three gone reasons are not distinguished on
  // the server (and HEAD carries no readable body), so we do not guess at one.
  useEffect(() => {
    if (started.current) return;
    started.current = true;

    if (!token) {
      setCheck("missing");
      return;
    }

    let cancelled = false;
    async function run() {
      try {
        const res = await fetch(`/api/auth/invites?token=${encodeURIComponent(token)}`, {
          method: "HEAD",
          cache: "no-store",
        });
        if (!cancelled) setCheck(res.ok ? "usable" : "unusable");
      } catch {
        if (!cancelled) setCheck("unusable");
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");

    const nextErrors: { name?: string; password?: string } = {};
    const parsedName = nameSchema.safeParse(name);
    if (!parsedName.success) {
      nextErrors.name = parsedName.error.issues[0]?.message ?? "Enter your name.";
    }
    const parsedPassword = passwordSchema.safeParse(password);
    if (!parsedPassword.success) {
      nextErrors.password = parsedPassword.error.issues[0]?.message ?? "Use at least 12 characters.";
    }
    setFieldError(nextErrors);
    if (nextErrors.name) {
      nameRef.current?.focus();
      return;
    }
    if (nextErrors.password) {
      passwordRef.current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/invites/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name: parsedName.data, password: parsedPassword.data }),
      });

      if (res.ok) {
        setDone(true);
        // The new member is signed in server-side; the Command Center lives at
        // `/`, and its `auth` view is what the hash opens.
        setTimeout(() => router.replace("/#auth"), 1400);
        return;
      }
      const data = await readJson(res);
      // 410 covers expired, already used, and not a real token alike.
      setFormError(
        messageFrom(
          data,
          "This invitation is no longer valid. It may have expired or already been used.",
        ),
      );
    } catch {
      setFormError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (check === "missing") {
    return (
      <AuthShell title="This invitation link is incomplete">
        <p className="text-[13.5px] leading-relaxed text-ink-2">
          The link is missing its invitation token. Open the link from your invitation email exactly
          as it was sent.
        </p>
        <Link href="/" className={cn(GHOST_BUTTON, "mt-5")}>
          Back to the platform
        </Link>
      </AuthShell>
    );
  }

  if (check === "checking") {
    return (
      <AuthShell title="Checking your invitation…">
        <Spinner label="One moment…" />
      </AuthShell>
    );
  }

  if (check === "unusable") {
    return (
      <AuthShell title="This invitation is not valid">
        <p className="text-[13.5px] leading-relaxed text-ink-2">
          Invitations are single use and expire after 72 hours. This one has already been used, has
          expired, or was never valid. Ask an administrator to send a new invitation.
        </p>
        <Link href="/" className={cn(GHOST_BUTTON, "mt-5")}>
          Back to the platform
        </Link>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell title="Welcome aboard">
        <p className="flex items-center gap-2 text-[13.5px] text-ink-2" role="status">
          <CheckCircle2 className="h-4 w-4 text-primary" aria-hidden="true" />
          Your account is ready. Taking you to sign in…
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Accept your invitation"
      lead="Choose how you will sign in. Your name is shown to colleagues in the Command Center."
    >
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        <div>
          <label htmlFor="invite-name" className={LABEL}>
            Full name
          </label>
          <input
            id="invite-name"
            ref={nameRef}
            name="name"
            type="text"
            autoComplete="name"
            autoFocus
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={fieldError.name ? true : undefined}
            aria-describedby={fieldError.name ? "invite-name-error" : undefined}
            className={INPUT}
            placeholder="Aisha Rahman"
          />
          <FieldError id="invite-name-error" message={fieldError.name} />
        </div>

        <div>
          <label htmlFor="invite-password" className={LABEL}>
            Password
          </label>
          <input
            id="invite-password"
            ref={passwordRef}
            name="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={fieldError.password ? true : undefined}
            aria-describedby={cn("invite-password-strength", fieldError.password ? "invite-password-error" : undefined)}
            className={INPUT}
          />
          <div id="invite-password-strength">
            <PasswordStrengthMeter password={password} />
          </div>
          <FieldError id="invite-password-error" message={fieldError.password} />
        </div>

        <FormAlert message={formError} />

        <button type="submit" className={PRIMARY_BUTTON} disabled={submitting}>
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          )}
          {submitting ? "Creating your account…" : "Create account"}
        </button>
      </form>
    </AuthShell>
  );
}

// ── 4. Request a password reset ──────────────────────────────────────────────

const NEUTRAL_RESET = "If that address belongs to an account, a password reset link is on its way.";

export function ResetRequest() {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");

    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Enter a valid email address.");
      emailRef.current?.focus();
      return;
    }
    setFieldError("");
    setSubmitting(true);

    try {
      // This route answers 202 with the same body whether or not the address has
      // an account — including when delivery fails — so there is no outage case
      // to distinguish here, unlike the magic-link request.
      const res = await fetch("/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: parsed.data }),
      });

      if (res.ok) {
        setSent(true);
        return;
      }
      const data = await readJson(res);
      if (res.status === 422) {
        setFieldError(messageFrom(data, "Enter a valid email address."));
        emailRef.current?.focus();
        return;
      }
      setFormError(messageFrom(data, "Something went wrong. Please try again."));
    } catch {
      setFormError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <AuthShell title="Check your inbox">
        <div
          role="status"
          className="rounded-2xl border border-line bg-green-tint px-4 py-3.5 text-[13.5px] leading-relaxed text-green-deep"
        >
          <span className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Request received
          </span>
          <p className="mt-1.5 text-ink-2">{NEUTRAL_RESET}</p>
        </div>

        <button
          type="button"
          className={cn(GHOST_BUTTON, "mt-4")}
          onClick={() => {
            setSent(false);
            setEmail("");
          }}
        >
          Use a different address
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      lead="Enter your work email and we will send a link to set a new password."
    >
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        <div>
          <label htmlFor="reset-email" className={LABEL}>
            Work email
          </label>
          <input
            id="reset-email"
            ref={emailRef}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? "reset-email-error" : undefined}
            className={INPUT}
            placeholder="you@yourbank.com"
          />
          <FieldError id="reset-email-error" message={fieldError} />
        </div>

        <FormAlert message={formError} />

        <button type="submit" className={PRIMARY_BUTTON} disabled={submitting}>
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Mail className="h-4 w-4" aria-hidden="true" />
          )}
          {submitting ? "Sending…" : "Email me a reset link"}
        </button>
      </form>

      <p className="mt-5 text-center text-[12.5px] text-ink-3">
        Remembered it?{" "}
        <Link
          href="/auth/magic-link"
          className="font-semibold text-primary underline-offset-2 hover:underline"
        >
          Sign in with a link instead
        </Link>
        .
      </p>
    </AuthShell>
  );
}

// ── 5. Consume a password-reset token ────────────────────────────────────────

/**
 * The other half of the reset flow, and the page the reset EMAIL links to
 * (src/lib/email/resend.ts builds this path). Submitting it POSTs
 * { token, password } to /api/auth/reset/confirm, which consumes the token and
 * revokes every existing session for the identity — the attacker's session dies
 * here, which is the entire reason a reset exists.
 *
 * The token is read from the query string and never rendered. A 401 covers
 * every failure server-side (wrong, expired, already used), so this page shows
 * one message for all of them rather than guessing which happened.
 */
export function ResetConfirm() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");

    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? "Use at least 12 characters.");
      passwordRef.current?.focus();
      return;
    }
    setFieldError("");
    setSubmitting(true);

    try {
      const res = await fetch("/api/auth/reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: parsed.data }),
      });

      if (res.ok) {
        // The new password is live and the session cookie is set by the
        // response, so the Command Center renders from `/`.
        setDone(true);
        setTimeout(() => router.replace("/"), 1400);
        return;
      }
      const data = await readJson(res);
      if (res.status === 422) {
        // Password too weak. The token was NOT consumed — the server validates
        // strength before it spends the token — so the user can retry inline.
        setFieldError(messageFrom(data, "Choose a stronger password."));
        passwordRef.current?.focus();
        return;
      }
      if (res.status === 401) {
        setFormError("That reset link is no longer valid. Request a new one.");
        return;
      }
      setFormError(messageFrom(data, "Something went wrong. Please try again."));
    } catch {
      setFormError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <AuthShell title="Reset link missing">
        <FormAlert message="This page needs a reset link. Open the link from your email, or request a new one." />
        <Link href="/auth/reset-password" className={cn(PRIMARY_BUTTON, "mt-5")}>
          Request a new link
        </Link>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell title="Password updated">
        <div
          role="status"
          className="rounded-2xl border border-line bg-green-tint px-4 py-3.5 text-[13.5px] leading-relaxed text-green-deep"
        >
          <span className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Done — taking you to the Command Center
          </span>
          <p className="mt-1.5 text-ink-2">
            Every other session for this account has been signed out, as it should be after a
            password reset.
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Choose a new password"
      lead="This link works once. Setting a new password signs out every other session on this account."
    >
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        <div>
          <label htmlFor="reset-new-password" className={LABEL}>
            New password
          </label>
          <input
            id="reset-new-password"
            ref={passwordRef}
            name="password"
            type="password"
            autoComplete="new-password"
            autoFocus
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? "reset-new-password-error" : "reset-new-password-hint"}
            className={INPUT}
          />
          <p id="reset-new-password-hint" className="mt-1.5 text-[12px] text-ink-3">
            At least 12 characters.
          </p>
          <FieldError id="reset-new-password-error" message={fieldError} />
        </div>

        <FormAlert message={formError} />

        <button type="submit" className={PRIMARY_BUTTON} disabled={submitting}>
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          )}
          {submitting ? "Updating…" : "Set new password"}
        </button>
      </form>

      <p className="mt-5 text-center text-[12.5px] text-ink-3">
        Wrong link?{" "}
        <Link
          href="/auth/reset-password"
          className="font-semibold text-primary underline-offset-2 hover:underline"
        >
          Request a new one
        </Link>
        .
      </p>
    </AuthShell>
  );
}
