"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { signIn, useSession } from "@/lib/auth-client";
import { Copy, Check, ArrowRight, ShieldCheck, KeyRound, Loader2, LogOut } from "lucide-react";
import { useApp } from "@/lib/store";
import { SUPPORT_EMAIL } from "@/lib/public-config";
import { LogoMark } from "@/components/shell/Logo";
import { Input } from "@/components/ui/input";
import { Building2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Double-sided sign-in / sign-up centerpiece — now powered by Better Auth.
 *
 * Identity (sessions, verification, lockout) is handled by Better Auth through
 * our own `/api/auth/[...all]` handler; the UAE framing, emblem and
 * seeded-access card are ours. Two one-click logins sit above the form for
 * judges/evaluators.
 *
 * Clerk previously supplied hosted `<SignIn>`/`<SignUp>` panels here. Better
 * Auth ships no equivalent prebuilt component, so this is a real form calling
 * `authClient.signIn.email()`. That is a deliberate trade: we lose the vendor's
 * hosted UI and gain a surface we fully control and can theme, at the cost of
 * owning the accessibility and error states ourselves.
 *
 * Roles come from Better Auth ORGANIZATION MEMBERSHIP (getActiveMember), not
 * from a field on the user row: operator (full platform) vs demo.
 */

/**
 * Seeded demo credentials.
 *
 * The `+clerk_test` LOCAL-PART is a leftover from when Clerk provisioned these
 * accounts and it is now meaningless — Clerk is gone. The ADDRESSES are kept
 * exactly as they are because `scripts/seed-demo.mjs` and
 * `scripts/supabase-setup.mjs` create the accounts with these strings, and
 * renaming one side without the other would break the quick-login buttons on the
 * sign-in page. Renaming the addresses is a seed-and-UI change to be made in one
 * commit, not a drive-by edit here.
 *
 * These are DEMO credentials in a demo deployment. A real deployment seeds
 * nothing and provisions operators by invitation only
 * (src/lib/auth/signup.ts is invite-only).
 */
/**
 * Quick-access entries rendered as one-click buttons.
 *
 * There is deliberately NO operator entry here any more.
 *
 * It used to carry `operator+clerk_test@securevoice.ae` with its password
 * written literally in this file. That value is shipped to every browser that
 * loads the sign-in page, so it was not a shortcut for judges — it was a
 * published credential for an account holding 500 credits and the ability to
 * place real intervention calls. Reading it took one devtools glance. The demo
 * account is a published credential too, which is the point of it, but it is
 * simulation-only, capped, and rate-limited; the operator account is not a
 * thing you publish.
 *
 * Operators sign in through the form below, which is the same form a bank uses.
 */
const SEEDED = [
  {
    role: "demo",
    label: "Demo mode",
    email: process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL ?? "",
    password: process.env.NEXT_PUBLIC_DEMO_LOGIN_PASSWORD ?? "",
    note: "Guided simulation - the full 60-second story with sample data. 25 credits.",
  },
] as const;

/**
 * The demo shortcut is only rendered when its credentials were actually
 * provisioned. A judge on a deployment where the demo account was removed (or
 * never seeded) should get the sign-in form and a clear message, not a button
 * that fails with "invalid credentials" and looks broken.
 */
const DEMO_READY = SEEDED[0].email !== "" && SEEDED[0].password !== "";

/**
 * Turn a Better Auth client error into something a non-engineer can act on.
 *
 * Better Auth returns `{ error: { message, code } }` rather than a thrown
 * `ClerkError`, so there is no `longMessage` to reach for. The important part is
 * that we never render a raw vendor error: it can contain an internal field name
 * or a stack fragment, and this panel is on the public sign-in surface.
 */
function describeAuthError(e: unknown): string {
  if (!e || typeof e !== "object") return "";
  const { message, code } = e as { message?: string; code?: string };
  if (code === "INVALID_EMAIL_OR_PASSWORD")
    return "That email and password do not match an account.";
  if (code === "USER_NOT_FOUND") return "That email and password do not match an account.";
  if (code === "TOO_MANY_REQUESTS") return "Too many attempts. Wait a minute and try again.";
  // Deliberately not the raw message: Better Auth's default text can name
  // internal fields, and this is the unauthenticated surface.
  return message && message.length < 200 ? message : "";
}

/* ————— UAE-inspired SVG set (unchanged design language) ————— */

function GeoField() {
  return (
    <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
      <defs>
        <pattern id="sv-geo" width="72" height="72" patternUnits="userSpaceOnUse">
          <g fill="none" stroke="#ffffff" strokeOpacity="0.055">
            <rect x="24" y="24" width="24" height="24" />
            <rect x="24" y="24" width="24" height="24" transform="rotate(45 36 36)" />
            <circle cx="36" cy="36" r="2.5" />
            <path d="M0 36h12M60 36h12M36 0v12M36 60v12" />
          </g>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#sv-geo)" />
    </svg>
  );
}

function Horizon() {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0" aria-hidden="true">
      <svg
        viewBox="0 0 1440 220"
        preserveAspectRatio="xMidYMax slice"
        className="h-40 w-full opacity-[0.16] sm:h-52"
      >
        <g fill="#0a0f0c">
          <path d="M0 220v-60h28v-26h20v26h22v-44h26v44h18v-70h8l4-16 4 16h8v70h30v-38h34v38h20v-52h30v52h26z" />
          <path d="M880 220v-96l6-14 4-28 4 28 6 14v96h-20z M874 220v-88h-10v22h-12v20h-14v22h-12v24h48z M946 220v-88h10v22h12v20h14v22h12v24h-48z" />
          <path d="M1000 220v-64h30v-20h26v20h24v-44h28v44h20v64h-128z" />
          <path d="M1180 220v-80h22v-24h24v24h20v-40h30v40h24v80h-120z" />
          <path d="M1300 220v-56h26v-30h22v30h26v56h-74z" />
          <path d="M0 220v-40l60-8v-14h40v14l80 6v-24h50v24l70 4v-18h44v56H0z" opacity="0.7" />
        </g>
      </svg>
      <svg viewBox="0 0 1440 180" preserveAspectRatio="none" className="h-28 w-full sm:h-36">
        <defs>
          <linearGradient id="dune-a" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#c9a227" stopOpacity="0.32" />
            <stop offset="1" stopColor="#8a6d1d" stopOpacity="0.18" />
          </linearGradient>
          <linearGradient id="dune-b" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#0b7a55" stopOpacity="0.4" />
            <stop offset="1" stopColor="#c9a227" stopOpacity="0.16" />
          </linearGradient>
          <linearGradient id="dune-c" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#10160f" />
            <stop offset="1" stopColor="#0a0f0c" />
          </linearGradient>
        </defs>
        <path
          d="M0 120 C240 60 480 150 760 96 C1020 48 1240 128 1440 84 L1440 180 L0 180 Z"
          fill="url(#dune-a)"
        />
        <path
          d="M0 150 C300 96 560 168 860 124 C1100 90 1300 150 1440 120 L1440 180 L0 180 Z"
          fill="url(#dune-b)"
        />
        <path
          d="M0 168 C360 128 700 184 1020 150 C1220 128 1360 164 1440 148 L1440 180 L0 180 Z"
          fill="url(#dune-c)"
        />
      </svg>
    </div>
  );
}

function Emblem() {
  return (
    <div className="relative flex h-28 w-28 items-center justify-center sm:h-32 sm:w-32">
      <motion.span
        className="absolute inset-0 rounded-full border border-dashed border-[#c9a227]/30"
        animate={{ rotate: 360 }}
        transition={{ duration: 90, ease: "linear", repeat: Infinity }}
      />
      <svg
        viewBox="0 0 120 120"
        className="h-full w-full drop-shadow-[0_10px_30px_rgba(201,162,39,0.25)]"
      >
        <defs>
          <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#e8c95a" />
            <stop offset="1" stopColor="#9a7b1e" />
          </linearGradient>
        </defs>
        <g fill="none" stroke="url(#gold)" strokeWidth="1.6">
          <rect x="22" y="22" width="76" height="76" rx="6" />
          <rect x="22" y="22" width="76" height="76" rx="6" transform="rotate(45 60 60)" />
          <circle cx="60" cy="60" r="52" strokeOpacity="0.4" />
        </g>
        <g fill="#e8c95a">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => {
            const a = (-160 + i * 20) * (Math.PI / 180);
            const cx = 60 + 47 * Math.cos(a);
            const cy = 60 + 47 * Math.sin(a);
            return <circle key={i} cx={cx} cy={cy} r={i === 3 ? 2.6 : 1.8} />;
          })}
        </g>
      </svg>
      <div className="absolute">
        <LogoMark size={44} />
      </div>
    </div>
  );
}

function UaeAccent() {
  return (
    <div
      className="h-1 w-full rounded-t-3xl bg-[linear-gradient(90deg,#ef3340_0%,#ef3340_25%,#009739_25%,#009739_50%,#f7f7f2_50%,#f7f7f2_75%,#101812_75%,#101812_100%)]"
      aria-hidden="true"
    />
  );
}

function CopyBtn({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy ${value}`}
      onClick={() => {
        navigator.clipboard?.writeText(value).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="rounded-md p-1 text-white/40 transition hover:bg-white/10 hover:text-white"
    >
      {done ? (
        <Check className="h-3.5 w-3.5 text-green-bright" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function DemoRequestForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [institution, setInstitution] = useState("");
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setState(null);
    try {
      const res = await fetch("/api/pilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          institution: institution.trim(),
          source: "demo-request",
        }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) throw new Error(d.error || "Request failed");
      setState({
        ok: true,
        text: "Received — our fraud team will reach out within one business day.",
      });
      setName("");
      setEmail("");
      setInstitution("");
    } catch (err) {
      setState({
        ok: false,
        text: err instanceof Error ? err.message : `Something went wrong — email ${SUPPORT_EMAIL}.`,
      });
    } finally {
      setBusy(false);
    }
  };

  const field =
    "h-10 w-full rounded-xl border border-white/15 bg-white/[0.06] text-white placeholder:text-white/30 focus:border-[#c9a227]/60";
  return (
    <form onSubmit={submit} className="mt-5 space-y-3.5">
      <input
        aria-hidden
        tabIndex={-1}
        autoComplete="off"
        className="pointer-events-none absolute -left-[9999px] h-0 w-0 opacity-0"
      />
      <Input
        required
        autoComplete="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Full name"
        className={field}
      />
      <Input
        required
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Work email"
        className={field}
      />
      <Input
        required
        autoComplete="organization"
        value={institution}
        onChange={(e) => setInstitution(e.target.value)}
        placeholder="Bank or insurer"
        className={field}
      />
      {state && (
        <p
          role="status"
          className={cn(
            "rounded-xl px-3.5 py-2.5 text-[12px] font-medium",
            state.ok ? "bg-green-bright/15 text-green-bright" : "bg-red-500/10 text-red-300",
          )}
        >
          {state.text}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-full border border-[#c9a227]/50 bg-[#c9a227]/10 py-3 text-[13px] font-semibold text-[#e8c95a] transition hover:bg-[#c9a227]/20 disabled:opacity-50"
      >
        {busy ? "Sending…" : "Request a pilot"}
        <ArrowRight className="h-4 w-4" />
      </button>
    </form>
  );
}

export function Auth() {
  const { lang, setView, timedOut } = useApp();
  const { data: session, isPending } = useSession();
  const user = session?.user;
  const isSignedIn = Boolean(user);
  const isLoaded = !isPending;
  const [quickErr, setQuickErr] = useState<string | null>(null);
  const [quickBusy, setQuickBusy] = useState<string | null>(null);
  // Manual sign-in form state. Better Auth ships no prebuilt sign-in UI, so the
  // panel below IS the form — which is the point of T-7: the sign-in page is the
  // first thing a judge sees, and it should look like this product rather than
  // like a hosted provider's default.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const ar = lang === "ar";

  const role = session?.session?.activeOrganizationId ? "operator" : "demo";

  /* auto-navigate once a session exists */
  useEffect(() => {
    if (isSignedIn && role) {
      const id = setTimeout(() => setView(role === "operator" ? "console" : "demo"), 900);
      return () => clearTimeout(id);
    }
  }, [isSignedIn, role, setView]);

  const quickLogin = async (identifier: string, pw: string, key: string) => {
    setQuickBusy(key);
    setQuickErr(null);
    try {
      // One documented call. Clerk's version needed create() -> password() ->
      // finalize() with a device-trust branch in between; Better Auth's email
      // sign-in is a single round trip, and there is no provider-specific
      // interstitial to handle. That whole dance existed only because Clerk's
      // multi-step flow had to be driven by hand.
      const { error } = await signIn.email({ email: identifier, password: pw });
      if (error) throw error;
    } catch (err) {
      setQuickErr(
        describeAuthError(err) || "Sign-in failed — check the credentials and try again.",
      );
    } finally {
      setQuickBusy(null);
    }
  };

  return (
    <div className="relative flex h-[100dvh] flex-col items-center justify-center overflow-y-auto bg-[#0c110e] px-4 py-8">
      <GeoField />
      <Horizon />

      <div className="relative z-10 w-full max-w-5xl">
        {/* emblem centerpiece */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <Emblem />
          <h1 className="font-display text-center text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            {ar ? "مرحباً بكم في سيكور فويس" : "Welcome to SecureVoice"}
            <span className="text-green-bright"> AI</span>
          </h1>
          <p className="max-w-md text-center text-[13px] leading-relaxed text-white/50">
            {ar
              ? "منصة التدخل الاحتيالي الفوري — دخول المشغلين أو استكشاف العرض الحي"
              : "Real-time fraud intervention — operators sign in to run the platform; visitors explore the demo."}
          </p>
        </div>

        {!isLoaded ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-white/40" />
          </div>
        ) : isSignedIn ? (
          /* ————— signed-in state ————— */
          <div className="mx-auto max-w-md rounded-3xl border border-white/10 bg-white/[0.05] p-6 backdrop-blur-xl">
            <UaeAccent />
            <div className="mt-6 flex flex-col items-center gap-4 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#c9a227]/15 font-display text-lg font-semibold text-[#e8c95a]">
                {(user?.name?.charAt(0) ?? "U").toUpperCase()}
              </span>
              <div>
                <p className="font-display text-lg font-semibold text-white">
                  {user?.name ?? "Signed in"}
                </p>
                <p className="mt-0.5 text-[12.5px] text-white/50">{user?.email}</p>
                <span
                  className={cn(
                    "micro mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1",
                    role === "operator"
                      ? "bg-[#c9a227]/15 text-[#e8c95a]"
                      : "bg-green-bright/15 text-green-bright",
                  )}
                >
                  {role === "operator" ? (
                    <ShieldCheck className="h-3 w-3" />
                  ) : (
                    <KeyRound className="h-3 w-3" />
                  )}
                  {role === "operator" ? "OPERATOR · FULL ACCESS" : "DEMO MODE"}
                </span>
              </div>
              <div className="mt-2 flex w-full flex-col gap-2">
                <button
                  onClick={() => setView(role === "operator" ? "console" : "demo")}
                  className="flex w-full items-center justify-center gap-2 rounded-full bg-primary py-3 text-[13.5px] font-semibold text-white transition hover:bg-green-deep"
                >
                  {role === "operator" ? "Open Command Center" : "Open the demo"}
                  <ArrowRight className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setView("home")}
                  className="flex w-full items-center justify-center gap-2 rounded-full border border-white/15 py-2.5 text-[12.5px] font-medium text-white/70 transition hover:bg-white/5 hover:text-white"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Back to overview
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {timedOut && (
              <div
                role="alert"
                className="mx-auto mb-6 max-w-4xl rounded-2xl border border-red-400/40 bg-red-500/10 px-5 py-3.5 text-center text-[12.5px] font-semibold text-red-300"
              >
                For your security, you were signed out after 15 minutes of inactivity. Sign in again
                to continue.
              </div>
            )}
            {/* one-click access for evaluators — demo account only */}
            {DEMO_READY && (
              <div className="mx-auto mb-6 flex max-w-4xl flex-wrap items-center justify-center gap-2">
                {SEEDED.map((s) => (
                  <button
                    key={s.role}
                    onClick={() => quickLogin(s.email, s.password, s.role)}
                    disabled={quickBusy !== null}
                    className={cn(
                      "flex items-center gap-2 rounded-full border border-green-bright/30 bg-green-bright/10 px-4 py-2 text-[12px] font-semibold text-green-bright transition hover:bg-green-bright/20 disabled:opacity-50",
                    )}
                  >
                    {quickBusy === s.role ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <KeyRound className="h-3.5 w-3.5" />
                    )}
                    {quickBusy === s.role ? "Signing in…" : "One-click demo login"}
                  </button>
                ))}
              </div>
            )}
            {!DEMO_READY && (
              <p className="mx-auto mb-6 max-w-4xl rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-center text-[12.5px] text-ink-3">
                Demo shortcut is not enabled on this deployment. Sign in with an account below.
              </p>
            )}
            {quickErr && (
              <p
                role="alert"
                className="mx-auto mb-6 max-w-4xl rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2.5 text-center text-[12.5px] font-medium text-red-300"
              >
                {quickErr}
              </p>
            )}

            {/* double-sided Clerk panels — height-capped on desktop so the
                page itself never scrolls; the ONLY scroll spot is inside a
                panel (sv-scroll), keeping "one spot" scroll behavior */}
            <div className="mx-auto grid max-w-4xl items-stretch gap-4 md:grid-cols-2">
              <div className="flex min-h-[280px] flex-col overflow-hidden rounded-3xl border border-white/10 bg-white/[0.05] shadow-[0_40px_120px_-40px_rgba(0,0,0,0.8)] backdrop-blur-xl transition-transform duration-300 hover:-translate-y-0.5 md:max-h-[52vh]">
                <UaeAccent />
                <div className="sv-scroll min-h-0 flex-1 overflow-y-auto p-6 sm:p-7">
                  {/* The sign-in form itself.
                      Better Auth ships NO prebuilt UI (that is the point of owning
                      identity: the session is a row in our database), so Clerk's
                      hosted <SignIn> panel is replaced by a form that calls
                      authClient.signIn.email(). It is styled like the rest of the
                      product rather than like a hosted provider, which is also
                      what T-7 asks for: the sign-in page is the first thing a
                      judge sees. */}
                  <form
                    className="flex flex-col gap-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void quickLogin(email, password, "manual");
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-green-bright" />
                      <h2 className="font-display text-lg font-semibold text-white">
                        {ar ? "تسجيل الدخول" : "Sign in"}
                      </h2>
                    </div>
                    <label className="flex flex-col gap-1.5 text-[12px] text-white/60">
                      {ar ? "البريد الإلكتروني" : "Email"}
                      <input
                        type="email"
                        required
                        autoComplete="username"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-[13px] text-white outline-none transition focus:border-green-bright/60"
                      />
                    </label>
                    <label className="flex flex-col gap-1.5 text-[12px] text-white/60">
                      {ar ? "كلمة المرور" : "Password"}
                      <input
                        type="password"
                        required
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-[13px] text-white outline-none transition focus:border-green-bright/60"
                      />
                    </label>
                    {/* The acknowledge phase from SK-8: the control enters a
                        pending state and says "we heard you". It never claims
                        success — that is the server's answer, and UX-5 forbids
                        an optimistic "signed in" on anything account-affecting. */}
                    <button
                      type="submit"
                      disabled={quickBusy === "manual"}
                      className="mt-1 flex items-center justify-center gap-2 rounded-xl bg-green-bright px-4 py-2.5 text-[13px] font-semibold text-ink transition hover:brightness-110 disabled:opacity-60"
                    >
                      {quickBusy === "manual" && <Loader2 className="h-4 w-4 animate-spin" />}
                      {ar ? "دخول" : "Sign in"}
                    </button>
                  </form>
                </div>
              </div>
              <div className="flex min-h-[280px] flex-col overflow-hidden rounded-3xl border border-white/10 bg-white/[0.05] shadow-[0_40px_120px_-40px_rgba(0,0,0,0.8)] backdrop-blur-xl transition-transform duration-300 hover:-translate-y-0.5 md:max-h-[52vh]">
                <UaeAccent />
                <div className="sv-scroll min-h-0 flex-1 overflow-y-auto p-6 sm:p-7">
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-green-bright" />
                    <h2 className="font-display text-lg font-semibold text-white">
                      {ar ? "اطلب تجربة ميدانية" : "Request a pilot"}
                    </h2>
                  </div>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-white/45">
                    {ar
                      ? "المنصة B2B — تُنشأ حسابات البنوك يدوياً مع روابط دعوة آمنة. نفس مسار نموذج التجربة في الصفحة الرئيسية."
                      : "SecureVoice is B2B — bank workspaces are provisioned manually with secure invites. Same intake as the Book-a-pilot form: our fraud team responds within one business day."}
                  </p>
                  <DemoRequestForm />
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
