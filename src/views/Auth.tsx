"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { signIn, useSession } from "@/lib/auth-client";
import { describeAuthError, reportAuthError } from "@/lib/auth/errors";
import { reportClientError } from "@/lib/client-diagnostics";
import { ArrowRight, ShieldCheck, KeyRound, Loader2, LogOut } from "lucide-react";
import { useApp, t } from "@/lib/store";
import { SUPPORT_EMAIL } from "@/lib/public-config";
import { isDemoAccount } from "@/lib/demo-account";
import { LogoMark } from "@/components/shell/Logo";
import { Input } from "@/components/ui/input";
import { Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Lang } from "@/lib/store";

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
    note: "Guided live scenario — one case run end to end against the 60-second case deadline. Never billed: a demo run is metered and audited, and the cost is ours.",
  },
] as const;

/**
 * The demo shortcut is only rendered when its credentials were actually
 * provisioned. A judge on a deployment where the demo account was removed (or
 * never seeded) should get the sign-in form and a clear message, not a button
 * that fails with "invalid credentials" and looks broken.
 */
const DEMO_READY = SEEDED[0].email !== "" && SEEDED[0].password !== "";

/* ————— Cloudflare Turnstile (bot gate on sign-in) ————— */

/**
 * Turnstile is a GATE, not a replacement. Credential checking, lockout and
 * session creation all still run inside Better Auth; this only decides whether a
 * browser is plausibly human before that work is spent.
 *
 * The site key is public by construction — it ships in this bundle and is meant
 * to. The secret never does: it lives only in `TURNSTILE_SECRET` on the server,
 * where src/lib/compliance/turnstile.ts redeems the token against Cloudflare.
 *
 * `NEXT_PUBLIC_TURNSTILE_SITE_KEY` unset => the widget does not render and the
 * client sends no token. The server treats a missing secret as "not enforced"
 * (src/lib/compliance/turnstile.ts), so a deployment with neither is a working
 * self-hosted box, just an ungated one. Production sets both; `preflight` should
 * refuse a production deploy that sets neither.
 */
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";
const TURNSTILE_ENABLED = TURNSTILE_SITE_KEY !== "";

const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId: string) => void;
      getResponse: (widgetId?: string) => string | undefined;
    };
  }
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

function DemoRequestForm() {
  const { lang } = useApp();
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
      if (!res.ok || !d.ok)
        throw new Error(d.error || t("Request failed", "تعذّر إرسال الطلب", lang));
      setState({
        ok: true,
        text: t(
          "Received — our fraud team will reach out within one business day.",
          "تم الاستلام — سيتواصل فريق مكافحة الاحتيال لدينا خلال يوم عمل واحد.",
          lang,
        ),
      });
      setName("");
      setEmail("");
      setInstitution("");
    } catch (err) {
      // No `err.message` here. A failed POST throws "Failed to fetch" / "Load
      // failed" — a browser transport string on a public form, in front of a
      // prospect, next to nothing actionable. The raw error goes to the console
      // and Sentry; the person gets a sentence that says what actually happened:
      // the request did not land, so resending is safe.
      reportClientError("pilot-request", err);
      setState({
        ok: false,
        text:
          t(
            "Your request did not reach us — nothing was submitted, so please try again. If it keeps failing, email ",
            "لم يصلنا طلبك — لم يُرسل شيء، لذا يرجى المحاولة مرة أخرى. وإذا استمرت المشكلة راسلنا على ",
            lang,
          ) +
          SUPPORT_EMAIL +
          ".",
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
        placeholder={t("Full name", "الاسم الكامل", lang)}
        className={field}
      />
      <Input
        required
        type="email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={t("Work email", "البريد المهني", lang)}
        className={field}
      />
      <Input
        required
        autoComplete="organization"
        value={institution}
        onChange={(e) => setInstitution(e.target.value)}
        placeholder={t("Bank or insurer", "بنك أو شركة تأمين", lang)}
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
        {busy
          ? t("Sending…", "جارٍ الإرسال…", lang)
          : t("Request a pilot", "اطلب تجربة ميدانية", lang)}
        <ArrowRight className="h-4 w-4" />
      </button>
    </form>
  );
}

/**
 * Stable per-browser id for the demo queue, generated once and kept in
 * localStorage. It is an opaque random string — not a fingerprint, not the
 * IP (the server hashes that itself) — and it is validated server-side to a
 * tight alphabet, so a tampered value is a 422, not a second seat.
 */
function getDeviceId(): string {
  try {
    const existing = window.localStorage.getItem("sv_device_id");
    if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
    const fresh = (
      window.crypto?.randomUUID?.() ?? `d-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
    ).replace(/[^A-Za-z0-9_-]/g, "");
    const id = (fresh + "0".repeat(8)).slice(0, 32);
    window.localStorage.setItem("sv_device_id", id);
    return id;
  } catch {
    // Storage blocked (private mode): fall back to an ephemeral id. The
    // holder simply cannot keep a seat across reloads.
    return `eph-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

type QueuePhase =
  | { name: "idle" }
  | { name: "joining" }
  | { name: "queued"; seatId: string; position: number; capacity: number; activeCount: number }
  | { name: "entering" }
  | { name: "error"; message: string };

/**
 * One-click demo login, behind the demo queue.
 *
 * The demo credential is public, so concurrent guided-demo sessions are
 * bounded server-side (`/api/demo/queue` + `/api/demo/enter`): this button
 * joins the line, shows the position while waiting (heartbeat keeps the
 * ticket alive), and only then claims the seat and signs in. Judges and
 * operators share the same line — capacity applies to every demo session.
 *
 * `kick` lets the manual form delegate: typing the demo address into the
 * password form starts this same flow instead of a direct sign-in that
 * `getProfile()` would bounce for having no lease.
 */
function DemoQueueButton({
  lang,
  kick,
  getTurnstileToken,
  resetTurnstile,
}: {
  lang: Lang;
  kick: number;
  getTurnstileToken: () => string | undefined;
  resetTurnstile: () => void;
}) {
  const [phase, setPhase] = useState<QueuePhase>({ name: "idle" });
  const seatRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };

  const fail = (message: string) => {
    stopPoll();
    setPhase({ name: "error", message });
  };

  const leave = useCallback(async () => {
    stopPoll();
    const seatId = seatRef.current;
    seatRef.current = null;
    if (seatId) {
      try {
        await fetch("/api/demo/queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "leave", deviceId: getDeviceId(), seatId }),
        });
      } catch {
        // Best effort: the heartbeat TTL releases it anyway.
      }
    }
    setPhase({ name: "idle" });
  }, []);

  const enter = useCallback(
    async (seatId: string) => {
      setPhase({ name: "entering" });
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const token = getTurnstileToken();
        if (token) headers["cf-turnstile-response"] = token;
        const res = await fetch("/api/demo/enter", {
          method: "POST",
          headers,
          body: JSON.stringify({ deviceId: getDeviceId() }),
        });
        const data = (await res.json().catch(() => null)) as {
          error?: string;
          status?: string;
        } | null;
        if (!res.ok) {
          if (res.status === 409) {
            // Seat lapsed between poll and claim — rejoin the line, don't spin.
            seatRef.current = null;
            setPhase({ name: "idle" });
            return;
          }
          if (res.status === 401) {
            throw new Error(
              t(
                "Demo operator access is not provisioned on this deployment. Use the public demo below or request a pilot.",
                "دخول المشغّل التجريبي غير مُهيأ على هذا النشر. استخدم العرض العام أدناه أو اطلب تجربة.",
                lang,
              ),
            );
          }
          throw new Error(data?.error || `Sign-in failed (HTTP ${res.status})`);
        }
        try {
          window.localStorage.setItem("sv_demo_seat", seatId);
        } catch {
          // Seat binding degrades to the pair; a reload simply rejoins.
        }
        window.location.reload();
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      } finally {
        resetTurnstile();
      }
    },
    [getTurnstileToken, lang, resetTurnstile],
  );

  const pollStatus = useCallback(
    async (seatId: string) => {
      try {
        // Heartbeat first: the sweep releases anything stale, and a waiter who
        // only reads status would be swept out of line.
        const hb = await fetch("/api/demo/queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "heartbeat", deviceId: getDeviceId(), seatId }),
        });
        if (!hb.ok) {
          seatRef.current = null;
          setPhase({ name: "idle" });
          return;
        }
        const res = await fetch(`/api/demo/queue?seatId=${encodeURIComponent(seatId)}`, {
          cache: "no-store",
        });
        if (!res.ok) {
          seatRef.current = null;
          setPhase({ name: "idle" });
          return;
        }
        const state = (await res.json()) as
          | { status: "active"; seatId: string; capacity: number; activeCount: number }
          | {
              status: "queued";
              seatId: string;
              position: number;
              capacity: number;
              activeCount: number;
            }
          | { status: "gone" };
        if (state.status === "gone") {
          seatRef.current = null;
          setPhase({ name: "idle" });
        } else if (state.status === "active") {
          stopPoll();
          await enter(seatId);
        } else {
          setPhase({
            name: "queued",
            seatId,
            position: state.position,
            capacity: state.capacity,
            activeCount: state.activeCount,
          });
        }
      } catch {
        // Transient: keep the ticket, try again next tick.
      }
    },
    [enter],
  );

  const join = useCallback(async () => {
    stopPoll();
    setPhase({ name: "joining" });
    try {
      const res = await fetch("/api/demo/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "join", deviceId: getDeviceId() }),
      });
      const state = (await res.json().catch(() => null)) as
        | { status: "active"; seatId: string; capacity: number; activeCount: number }
        | {
            status: "queued";
            seatId: string;
            position: number;
            capacity: number;
            activeCount: number;
          }
        | { status: "rate_limited"; retryAfterMs?: number }
        | null;
      if (res.status === 429) {
        const waitS = Math.max(
          1,
          Math.ceil(((state as { retryAfterMs?: number } | null)?.retryAfterMs ?? 60_000) / 1000),
        );
        throw new Error(
          lang === "ar"
            ? `طلبات كثيرة — أعد المحاولة بعد ${waitS} ثانية.`
            : `Too many attempts — retry in ${waitS}s.`,
        );
      }
      if (!res.ok || !state || (state.status !== "active" && state.status !== "queued")) {
        throw new Error(
          lang === "ar"
            ? "تعذّر الانضمام إلى الطابور — حاول مجدداً."
            : "Could not join the line — try again.",
        );
      }
      seatRef.current = state.seatId;
      if (state.status === "active") {
        await enter(state.seatId);
        return;
      }
      setPhase({
        name: "queued",
        seatId: state.seatId,
        position: state.position,
        capacity: state.capacity,
        activeCount: state.activeCount,
      });
      pollRef.current = setInterval(() => void pollStatus(state.seatId), 5_000);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  }, [enter, pollStatus, lang]);

  // The manual form delegates here when it sees the demo address.
  const kickRef = useRef(kick);
  useEffect(() => {
    if (kick !== kickRef.current) {
      kickRef.current = kick;
      if (kick > 0) void join();
    }
  }, [kick, join]);

  // Leaving the page while holding a ticket releases it for the next waiter.
  // (Only while queued/waiting — an entered session's lease is released by
  // sign-out or heartbeat expiry, never by navigation.)
  useEffect(() => () => void leave(), [leave]);

  const busy = phase.name === "joining" || phase.name === "entering";
  const waiting = phase.name === "queued";

  return (
    <div className="mx-auto mb-4 flex max-w-5xl flex-col items-center gap-2">
      <div className="flex flex-wrap items-center justify-center gap-2">
        {!waiting && phase.name !== "error" ? (
          <button
            onClick={() => void join()}
            disabled={busy}
            className="flex items-center gap-2 rounded-full border border-green-bright/30 bg-green-bright/10 px-4 py-2 text-[12px] font-semibold text-green-bright transition hover:bg-green-bright/20 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <KeyRound className="h-3.5 w-3.5" />
            )}
            {phase.name === "entering"
              ? t("Claiming your seat…", "جارٍ حجز مقعدك…", lang)
              : t("One-click demo login", "دخول تجريبي بضغطة واحدة", lang)}
          </button>
        ) : null}
        {waiting && (
          <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 text-[12px] font-semibold text-white">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-green-bright" />
            {t(
              `You're #${phase.position} in line — ${phase.activeCount}/${phase.capacity} demo seats in use. This refreshes on its own.`,
              `أنت رقم ${phase.position} في الطابور — ${phase.activeCount}/${phase.capacity} من المقاعد التجريبية مشغولة. تُحدَّث تلقائياً.`,
              lang,
            )}
          </div>
        )}
        {phase.name === "error" && (
          <button
            onClick={() => void join()}
            className="flex items-center gap-2 rounded-full border border-green-bright/30 bg-green-bright/10 px-4 py-2 text-[12px] font-semibold text-green-bright transition hover:bg-green-bright/20"
          >
            <KeyRound className="h-3.5 w-3.5" />
            {t("Try the demo line again", "حاول الطابور التجريبي مجدداً", lang)}
          </button>
        )}
        {(waiting || phase.name === "error") && (
          <button
            onClick={() => void leave()}
            className="rounded-full px-3 py-2 text-[11.5px] font-medium text-white/50 transition hover:text-white"
          >
            {t("Leave the line", "مغادرة الطابور", lang)}
          </button>
        )}
      </div>
      {phase.name === "error" && (
        <p
          role="alert"
          className="max-w-5xl rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2.5 text-center text-[12.5px] font-medium text-red-300"
        >
          {phase.message}
        </p>
      )}
      {phase.name === "error" && (
        <a
          href="/#live-demo"
          className="rounded-full border border-white/15 px-4 py-2 text-[12px] font-semibold text-white/80 transition hover:border-white/30 hover:text-white"
        >
          {t("Open the public demo", "افتح العرض العام", lang)}
        </a>
      )}
      {waiting && (
        <p className="text-[11.5px] text-white/40">
          {t(
            "Your ticket is held while this page is open. When a seat frees, you sign straight in.",
            "تذكرتك محفوظة ما دامت هذه الصفحة مفتوحة. وعندما يتحرر مقعد تدخل مباشرة.",
            lang,
          )}
        </p>
      )}
    </div>
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
  // Bumped when the manual form sees the demo address: the password form
  // cannot mint a leased session, so it delegates to the queue button above
  // instead of attempting a direct sign-in that getProfile would bounce.
  const [queueKick, setQueueKick] = useState(0);
  // Manual sign-in form state. Better Auth ships no prebuilt sign-in UI, so the
  // panel below IS the form — which is the point of T-7: the sign-in page is the
  // first thing a judge sees, and it should look like this product rather than
  // like a hosted provider's default.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // The demo account is a judge's walkthrough seat, never an operator view —
  // an org pointer on a demo session is the demo's own org, not capability.
  const role =
    session && !isDemoAccount(session.user.email) && session.session?.activeOrganizationId
      ? "operator"
      : "demo";

  /* Turnstile: load the script once, then render the widget into our own node.
     Explicit rendering (render=explicit) rather than the auto-scanned class,
     because this is a React view that mounts and unmounts — auto-render would
     re-scan the DOM on every navigation and produce duplicate widgets. */
  const turnstileRef = useRef<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!TURNSTILE_ENABLED) return;
    let cancelled = false;

    const mount = () => {
      if (cancelled || !hostRef.current || turnstileRef.current) return;
      const id = window.turnstile?.render(hostRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        action: "login",
        theme: "dark",
        // Fails open in the CLIENT only: if the widget cannot load, the user can
        // still reach the form. The server is the real gate and fails CLOSED.
        callback: () => setQuickErr(null),
        "error-callback": () => setQuickErr(null),
      });
      if (id) turnstileRef.current = id;
    };

    if (window.turnstile) {
      mount();
      return;
    }
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.defer = true;
    script.onload = mount;
    document.head.appendChild(script);

    return () => {
      cancelled = true;
      if (turnstileRef.current) {
        window.turnstile?.remove(turnstileRef.current);
        turnstileRef.current = null;
      }
      script.remove();
    };
  }, []);

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
    // Read the widget's current token. Turnstile tokens are single-use, so this
    // value is spent the moment the sign-in is attempted and the widget is reset
    // below — a retry must never reuse it, and a failed attempt must not leave a
    // live token sitting in the DOM.
    const token = turnstileRef.current
      ? window.turnstile?.getResponse(turnstileRef.current)
      : undefined;
    try {
      // One documented call. Clerk's version needed create() -> password() ->
      // finalize() with a device-trust branch in between; Better Auth's email
      // sign-in is a single round trip, and there is no provider-specific
      // interstitial to handle. That whole dance existed only because Clerk's
      // multi-step flow had to be driven by hand.
      //
      // The token rides as a header rather than a body field: Better Auth owns
      // and serialises that body, so a body-based token would have to fight it.
      const { error } = await signIn.email({
        email: identifier,
        password: pw,
        ...(token ? { fetchOptions: { headers: { "cf-turnstile-response": token } } } : {}),
      });
      if (error) throw error;
    } catch (err) {
      // Friendly text on the screen, the vendor's words in the console and Sentry.
      // `describeAuthError` has no raw-message fallback, so this is the only path
      // the vendor string takes — which is the point: the panel used to render it.
      reportAuthError(err);
      setQuickErr(describeAuthError(err, lang));
    } finally {
      setQuickBusy(null);
      // Reset on BOTH outcomes. A token is redeemed once; leaving the solved
      // widget in place would send a spent token on the next attempt and every
      // later sign-in would fail with bot_check_failed for no visible reason.
      if (turnstileRef.current) window.turnstile?.reset(turnstileRef.current);
    }
  };

  return (
    // WHY THIS DIV IS overflow-hidden AND NOT overflow-y-auto
    //
    // It used to scroll, which made the first thing a judge sees a page with a
    // scrollbar on the outside AND a second scroll region inside each panel:
    // two scroll spots on one screen, with the emblem drifting off the top as
    // you wheeled. The panels below are the only place that scrolls (sv-scroll,
    // capped at 56vh), so this container must not. overflow-hidden on an
    // h-[100dvh] box makes the page sticky by construction: nothing to wheel,
    // the content holds its position, the words stay centred.
    //
    // The trade is honest and deliberate: a very short viewport clips rather
    // than scrolls. That is why the content is laid out for the width it is
    // given (max-w-6xl, the panels on a 2-up grid) and the vertical rhythm is
    // tight (py-5, mb-5, the banners at mb-4) so a 1440x900 screen fits with
    // room to spare and a 13-inch laptop still holds without inventing a
    // scroll region to do it.
    <div
      data-surface="dark"
      className="relative flex h-[100dvh] flex-col items-center justify-center overflow-hidden bg-[#0c110e] px-6 py-5"
    >
      <GeoField />
      <Horizon />

      <div className="relative z-10 w-full max-w-6xl">
        {/* emblem centerpiece */}
        <div className="mb-5 flex flex-col items-center gap-3">
          <Emblem />
          <h1 className="font-display text-center text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            {t("Welcome to SecureVoice", "مرحباً بكم في سيكور فويس", lang)}
            <span className="text-green-bright"> AI</span>
          </h1>
          <p className="max-w-md text-center text-[13px] leading-relaxed text-white/50">
            {t(
              "Real-time fraud intervention — operators sign in to run the platform; visitors explore the demo.",
              "منصة التدخل الاحتيالي الفوري — دخول المشغلين لتشغيل المنصة؛ واستكشاف العرض الحي للزوّار.",
              lang,
            )}
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
                  {user?.name ?? t("Signed in", "تم تسجيل الدخول", lang)}
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
                  {role === "operator"
                    ? t("OPERATOR · FULL ACCESS", "مشغّل · صلاحية كاملة", lang)
                    : t("DEMO MODE", "وضع العرض", lang)}
                </span>
              </div>
              <div className="mt-2 flex w-full flex-col gap-2">
                <button
                  onClick={() => setView(role === "operator" ? "console" : "demo")}
                  className="flex w-full items-center justify-center gap-2 rounded-full bg-primary py-3 text-[13.5px] font-semibold text-white transition hover:bg-green-deep"
                >
                  {role === "operator"
                    ? t("Open Command Center", "افتح مركز القيادة", lang)
                    : t("Open the demo", "افتح العرض التجريبي", lang)}
                  <ArrowRight className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setView("home")}
                  className="flex w-full items-center justify-center gap-2 rounded-full border border-white/15 py-2.5 text-[12.5px] font-medium text-white/70 transition hover:bg-white/5 hover:text-white"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  {t("Back to overview", "العودة إلى النظرة العامة", lang)}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {timedOut && (
              <div
                role="alert"
                className="mx-auto mb-4 max-w-5xl rounded-2xl border border-red-400/40 bg-red-500/10 px-5 py-3.5 text-center text-[12.5px] font-semibold text-red-300"
              >
                {t(
                  "For your security, you were signed out after 15 minutes of inactivity. Sign in again to continue.",
                  "لأمانكم، تم تسجيل خروجكم بعد ١٥ دقيقة من عدم النشاط. سجّلوا الدخول مرة أخرى للمتابعة.",
                  lang,
                )}
              </div>
            )}
            {/* one-click access for evaluators — demo account only, behind the
                demo queue: the credential is public, so entry is by seat lease
                (join → wait in line → claim on promotion), never by password. */}
            {DEMO_READY && (
              <DemoQueueButton
                lang={lang}
                kick={queueKick}
                getTurnstileToken={() =>
                  turnstileRef.current
                    ? window.turnstile?.getResponse(turnstileRef.current)
                    : undefined
                }
                resetTurnstile={() => {
                  if (turnstileRef.current) window.turnstile?.reset(turnstileRef.current);
                }}
              />
            )}
            {!DEMO_READY && (
              <p className="mx-auto mb-4 max-w-5xl rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-center text-[12.5px] text-ink-3">
                {t(
                  "Demo shortcut is not enabled on this deployment. Sign in with an account below.",
                  "الدخول التجريبي السريع غير مُفعّل على هذا النشر. سجّل الدخول بأحد الحسابات أدناه.",
                  lang,
                )}
              </p>
            )}
            {quickErr && (
              <p
                role="alert"
                className="mx-auto mb-4 max-w-5xl rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2.5 text-center text-[12.5px] font-medium text-red-300"
              >
                {quickErr}
              </p>
            )}

            {/* double-sided panels. The ONLY scroll spot is inside a panel
                (sv-scroll, 56vh cap), so the page itself never scrolls. */}
            <div className="mx-auto grid max-w-5xl items-stretch gap-4 md:grid-cols-2">
              <div className="flex min-h-[280px] flex-col overflow-hidden rounded-3xl border border-white/10 bg-white/[0.05] shadow-[0_40px_120px_-40px_rgba(0,0,0,0.8)] backdrop-blur-xl transition-transform duration-300 hover:-translate-y-0.5 md:max-h-[56vh]">
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
                      // The demo address goes through the queue, not the
                      // password form: a direct sign-in would mint a session
                      // with no seat lease, which getProfile resolves to
                      // signed-out. Delegating keeps one honest path in.
                      if (DEMO_READY && isDemoAccount(email)) {
                        setQuickErr(
                          t(
                            "Demo sign-ins join a short line first — starting that now.",
                            "دخول العرض ينضم إلى طابور قصير أولاً — يبدأ ذلك الآن.",
                            lang,
                          ),
                        );
                        setQueueKick((k) => k + 1);
                        return;
                      }
                      void quickLogin(email, password, "manual");
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-green-bright" />
                      <h2 className="font-display text-lg font-semibold text-white">
                        {t("Sign in", "دخول", lang)}
                      </h2>
                    </div>
                    <label className="flex flex-col gap-1.5 text-[12px] text-white/60">
                      {t("Email", "البريد الإلكتروني", lang)}
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
                      {t("Password", "كلمة المرور", lang)}
                      <input
                        type="password"
                        required
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-[13px] text-white outline-none transition focus:border-green-bright/60"
                      />
                    </label>
                    {/* Turnstile mounts here. The node is ours; the widget is
                        rendered explicitly by the effect above so React never
                        reclaims a node Cloudflare owns, and so a mount/unmount
                        cycle cannot leave a duplicate widget behind. */}
                    {TURNSTILE_ENABLED && (
                      <div className="flex justify-center pt-1">
                        <div ref={hostRef} />
                      </div>
                    )}
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
                      {t("Sign in", "دخول", lang)}
                    </button>
                  </form>
                </div>
              </div>
              <div className="flex min-h-[280px] flex-col overflow-hidden rounded-3xl border border-white/10 bg-white/[0.05] shadow-[0_40px_120px_-40px_rgba(0,0,0,0.8)] backdrop-blur-xl transition-transform duration-300 hover:-translate-y-0.5 md:max-h-[56vh]">
                <UaeAccent />
                {/* Pilot-request form. B2B provisioning is manual by design — a
                    pilot workspace is a bank integration, not a signup — so the
                    same intake as the Book-a-pilot form reaches the fraud team
                    and they answer within one business day. */}
                <div className="sv-scroll min-h-0 flex-1 overflow-y-auto p-6 sm:p-7">
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-green-bright" />
                    <h2 className="font-display text-lg font-semibold text-white">
                      {t("Request a pilot", "اطلب تجربة ميدانية", lang)}
                    </h2>
                  </div>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-white/45">
                    {t(
                      "SecureVoice is B2B — bank workspaces are provisioned manually with secure invites. Same intake as the Book-a-pilot form: our fraud team responds within one business day.",
                      "المنصة B2B — تُنشأ حسابات البنوك يدوياً مع روابط دعوة آمنة. نفس مسار نموذج التجربة في الصفحة الرئيسية.",
                      lang,
                    )}
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

export default Auth;
