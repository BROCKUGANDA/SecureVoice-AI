"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useSession } from "@/lib/auth-client";
import {
  PhoneCall,
  MessageSquareText,
  Zap,
  ShieldCheck,
  Snowflake,
  Fingerprint,
  CheckCircle2,
  XCircle,
  Loader2,
  Radio,
  History,
  ArrowRight,
  Timer,
  Siren,
  ClipboardCheck,
  Coins,
  Download,
  Mail,
} from "lucide-react";
import { useApp } from "@/lib/store";
import { Chip, LiveDot, StatusPill } from "@/components/fx/core";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { openRealtime, type RealtimeHandle, type RealtimeStatus } from "@/lib/realtime-client";
import { interventionsCsv } from "@/lib/csv-export";
import { LiveOpsPanel, type TranscriptLine, type LiveCall } from "@/components/ops/LiveOpsPanel";

/**
 * Operator Command Center — run the platform for real, on your own information:
 *   1. Connect your phone (enrollment → live Twilio delivery)
 *   2. Fire a risk signal through the exact production path (HMAC-signed ingest)
 *   3. Watch the SLA clock, the delivery receipt, and the actions-to-take runbook
 *   4. Verify the tamper-evident audit chain for the case
 */

type FireResponse = {
  ok?: boolean;
  caseRef?: string;
  slaDeadline?: string;
  plan?: { action: string; handoff: string; verification: string };
  delivery?: {
    channel: string;
    to?: string;
    sid?: string;
    status?: string;
    failed?: boolean;
    error?: string;
    reason?: string;
    mode?: string;
  };
  notes?: string;
  creditsRemaining?: number;
  signedSignal?: {
    caseId: string;
    riskScore: number;
    channel: string;
    customer: { ref: string; lang: string };
  };
  error?: string;
};

type ChainVerification = { ok: boolean; rows: number; brokenAt?: string };

const inputCls = "h-10 rounded-xl border-line bg-paper";

function selfRef(email: string): string {
  return `SELF-${email.split("@")[0].replace(/\W/g, "").slice(0, 24) || "operator"}`;
}

/* ————— SLA countdown ————— */
function SlaClock({ deadline }: { deadline: string }) {
  const [left, setLeft] = useState(60);
  useEffect(() => {
    const tick = () =>
      setLeft(Math.max(0, Math.round((new Date(deadline).getTime() - Date.now()) / 1000)));
    tick();
    const iv = setInterval(tick, 500);
    return () => clearInterval(iv);
  }, [deadline]);
  const pct = Math.max(0, Math.min(100, (left / 60) * 100));
  return (
    <div className="flex items-center gap-3">
      <div className="relative h-11 w-11">
        <svg viewBox="0 0 44 44" className="h-full w-full -rotate-90">
          <circle cx="22" cy="22" r="19" fill="none" stroke="#e7eae3" strokeWidth="4" />
          <circle
            cx="22"
            cy="22"
            r="19"
            fill="none"
            stroke={left > 20 ? "#0b7a55" : "#d64545"}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={`${(pct / 100) * 119.4} 119.4`}
            className="transition-[stroke-dasharray] duration-500"
          />
        </svg>
        <span className="num absolute inset-0 flex items-center justify-center text-[11px] font-semibold">
          {left}s
        </span>
      </div>
      <div>
        <p className="text-[12px] font-semibold">SLA to customer contact</p>
        <p className="text-[11px] text-ink-3">
          {left > 0 ? "counting down from signal receipt" : "window elapsed"}
        </p>
      </div>
    </div>
  );
}

/* ————— delivery result card ————— */
function DeliveryCard({ delivery }: { delivery: NonNullable<FireResponse["delivery"]> }) {
  if (delivery.channel === "none") {
    return (
      <div className="rounded-xl border border-line bg-paper px-4 py-3 text-[12.5px] text-ink-2">
        <span className="font-semibold">No live delivery</span> — {delivery.reason ?? delivery.mode}
      </div>
    );
  }
  if (delivery.failed) {
    const geo = delivery.error?.includes("21215");
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-900">
        <p className="font-semibold">Delivery attempt failed — {delivery.channel}</p>
        <p className="mt-1 leading-snug">{delivery.error?.slice(0, 160)}</p>
        {geo && (
          <p className="mt-1.5 leading-snug text-amber-700">
            Trial accounts: enable international calling in the Twilio console (Voice → Geo
            Permissions), or upgrade.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-[#c4e5d6] bg-green-tint px-4 py-3 text-[12.5px] text-green-deep">
      <p className="flex items-center gap-2 font-semibold">
        <CheckCircle2 className="h-4 w-4" />
        {delivery.channel === "sms" ? "SMS handed to Twilio" : "Voice call placed"} —{" "}
        {delivery.status ?? "queued"}
      </p>
      {delivery.sid && <p className="num mt-1 text-[11px] text-green-deep/70">{delivery.sid}</p>}
      <p className="mt-1 text-[11.5px] text-green-deep/80">
        Receipt on its way to {delivery.to ?? "your phone"} · sent from your bank&apos;s line.
      </p>
    </div>
  );
}

/* ————— actions-to-take runbook ————— */
function Runbook({ res }: { res: FireResponse }) {
  const steps = [
    {
      icon: Fingerprint,
      label: "Signal verified",
      detail: "HMAC-SHA256 signature + replay window",
      done: true,
    },
    {
      icon: ClipboardCheck,
      label: "Case sealed in audit chain",
      detail: res.caseRef,
      done: !!res.caseRef,
    },
    {
      icon: Snowflake,
      label: "Protective action armed",
      detail: res.plan?.action ?? "—",
      done: !!res.plan,
    },
    {
      icon:
        res.delivery?.channel === "sms"
          ? MessageSquareText
          : res.delivery?.channel === "call"
            ? PhoneCall
            : Radio,
      label: "Customer contacted",
      detail: res.delivery?.failed
        ? `attempt failed (${res.delivery.error?.slice(0, 60)}…)`
        : res.delivery?.sid
          ? `${res.delivery.channel} · ${res.delivery.status}`
          : (res.delivery?.reason ?? "—"),
      done: !res.delivery?.failed && res.delivery?.channel !== "none",
    },
  ];
  const actions = [
    "Pick up the incoming call or read the SMS from your bank's line — expect verification questions about the merchant, the amount, and the date.",
    "Never share a PIN, password, or one-time passcode — the agent will never ask, and no legitimate bank employee will.",
    res.plan?.action === "card_freeze_temporary"
      ? "If the transaction is not yours, say so — the temporary freeze stays, a fraud specialist joins, and a replacement card is arranged."
      : "If the transaction is not yours, say so — the transfer hold stays while the fraud team reviews.",
    "If the transaction was yours, confirm it — the protective hold is lifted and the review closes with an audit record.",
  ];
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div>
        <p className="micro text-[9px] text-ink-3">WHAT THE PLATFORM DID</p>
        <ol className="mt-3 space-y-2.5">
          {steps.map((s, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <span
                className={cn(
                  "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg",
                  s.done ? "bg-green-tint text-primary" : "bg-paper text-ink-3",
                )}
              >
                <s.icon className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0">
                <p className="text-[12.5px] font-semibold leading-snug">{s.label}</p>
                <p className="num truncate text-[11px] text-ink-3">{s.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div>
        <p className="micro text-[9px] text-ink-3">YOUR ACTIONS NOW</p>
        <ol className="mt-3 space-y-2.5">
          {actions.map((a, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <span className="num mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[#0c110e] text-[10px] font-semibold text-green-bright">
                {i + 1}
              </span>
              <p className="text-[12.5px] leading-snug text-ink-2">{a}</p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/* ————— main view ————— */

export function Console() {
  const { lang, setView } = useApp();
  const { data: session, isPending } = useSession();
  const user = session?.user;
  const isSignedIn = Boolean(user);
  // `isLoaded` becomes `isPending`: Better Auth reports a pending session fetch
  // where the session reported "loaded". Both mean "do not decide yet" — deciding
  // early would flash the signed-out screen at a signed-in operator.
  const isLoaded = !isPending;
  // Display-only. The capability check that actually gates every console action
  // happens server-side on each route.
  const role = session?.session?.activeOrganizationId ? "operator" : undefined;
  const ar = lang === "ar";

  const [status, setStatus] = useState<{
    ok?: boolean;
    telephony?: string;
    voiceProvider?: string;
    ingest?: string;
  } | null>(null);
  const [phone, setPhone] = useState("");
  const [enrollLang, setEnrollLang] = useState("en");
  const [enrollChannel, setEnrollChannel] = useState<"call" | "sms">("call");
  const [enrollState, setEnrollState] = useState<{ ok: boolean; msg: string } | null>(null);
  const [enrolling, setEnrolling] = useState(false);

  const [risk, setRisk] = useState(0.94);
  const [channel, setChannel] = useState("card");
  const [amount, setAmount] = useState("2500");
  const [merchant, setMerchant] = useState("Electronics World");
  const [fireLang, setFireLang] = useState("en");
  const [firing, setFiring] = useState(false);
  const [res, setRes] = useState<FireResponse | null>(null);

  const [chain, setChain] = useState<{ checking: boolean; result?: ChainVerification } | null>(
    null,
  );
  const [cases, setCases] = useState<
    {
      callRef: string;
      riskScore: number | null;
      channel: string | null;
      plannedAction: string | null;
      at: string;
    }[]
  >([]);
  const [credits, setCredits] = useState<number | null>(null);
  const [branding, setBranding] = useState<{
    orgName: string | null;
    orgLogoUrl: string | null;
  } | null>(null);
  const [liveFeed, setLiveFeed] = useState<string[]>([]);
  // Realtime push path state. "unavailable" is not an error — it means the console
  // is reading the SSE feed instead, which is exactly what it did before.
  const [rtStatus, setRtStatus] = useState<RealtimeStatus>("connecting");
  // Live Operations panel state — transcript lines for the active call.
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [activeCallRef, setActiveCallRef] = useState<string | null>(null);
  const [liveCall, setLiveCall] = useState<LiveCall | null>(null);

  const email = user?.email ?? "";
  const customerRef = email ? selfRef(email) : "SELF-";

  // Live Operations: poll the audit chain for the active call's transcript.
  // The post_call_ingest row carries the redacted transcript in redactedText.
  // We poll every 3s and parse it into lines for the LiveOpsPanel.
  const pollTranscript = async (caseRef: string) => {
    try {
      const r = await fetch(`/api/console/audit?callRef=${encodeURIComponent(caseRef)}`);
      if (!r.ok) return;
      const d = (await r.json()) as {
        rows: { action: string; intent: string; redactedText: string | null }[];
      };
      const ingestRow = d.rows.find((row) => row.intent === "post_call_ingest");
      if (!ingestRow?.redactedText) return;
      const lines: TranscriptLine[] = ingestRow.redactedText
        .split("\n")
        .filter((l) => l.trim())
        .map((l, i) => {
          const roleMatch = l.match(/^\[(agent|user|system)\]\s*(.*)$/);
          if (roleMatch) {
            return {
              id: `${caseRef}-t-${i}`,
              speaker: roleMatch[1] as "agent" | "customer" | "system",
              text: roleMatch[2] ?? "",
              ts: new Date().toISOString(),
            };
          }
          return {
            id: `${caseRef}-t-${i}`,
            speaker: "system" as const,
            text: l,
            ts: new Date().toISOString(),
          };
        });
      if (lines.length > 0) {
        setTranscript(lines);
        setLiveCall({
          caseRef,
          riskScore: null,
          lang: "en",
          state: "ANSWERED",
          startedAt: new Date().toISOString(),
          durationSecs: 0,
          transcript: lines,
        });
      }
    } catch {}
  };

  useEffect(() => {
    // async fetches resolve outside the effect body — no synchronous setState
    let alive = true;
    // Declared here, not inside the isSignedIn block: the cleanup below closes both
    // transports and would otherwise capture them out of scope.
    let es: EventSource | null = null;
    let rt: RealtimeHandle | null = null;
    fetch("/api/status")
      .then((r) => r.json())
      .then((d) => alive && setStatus(d))
      .catch(() => {});
    if (isSignedIn) {
      fetch("/api/console/me")
        .then((r) => r.json())
        .then(
          (d: { profile: { credits: number } | null }) =>
            alive && d.profile && setCredits(d.profile.credits),
        )
        .catch(() => {});
      fetch("/api/console/settings")
        .then((r) => r.json())
        .then((d: { orgName: string | null; orgLogoUrl: string | null; error?: string }) => {
          if (alive && !d.error) setBranding({ orgName: d.orgName, orgLogoUrl: d.orgLogoUrl });
        })
        .catch(() => {});
      // Live pipeline feed. Realtime (websocket) is the preferred transport; SSE is
      // the always-on fallback. Both append the same rows to liveFeed, so the UI is
      // identical either way and the console never goes blind.

      const pushRow = (ref: string, action: string, intent: string | null) => {
        if (!alive) return;
        setLiveFeed((f) => [`${ref} · ${action}${intent ? ` · ${intent}` : ""}`, ...f].slice(0, 4));
      };

      const startSse = () => {
        if (es || !alive) return;
        try {
          es = new EventSource("/api/console/events");
          es.addEventListener("activity", (ev) => {
            try {
              const rows = JSON.parse((ev as MessageEvent).data) as {
                callRef: string;
                action: string;
                intent: string | null;
              }[];
              for (const r of rows) pushRow(r.callRef, r.action, r.intent ?? null);
            } catch {}
          });
          es.onerror = () => es?.close();
        } catch {}
      };

      const startRealtime = (callRefs: string[]) => {
        openRealtime({
          callRefs,
          onActivity: (a, channel) => {
            // channel is `case:<org>:<callRef>` — the ref is what the operator reads.
            pushRow(channel.split(":")[2] ?? a.id, a.action, a.intent);
          },
          onStatus: (st) => alive && setRtStatus(st),
        })
          .then((handle) => {
            if (!alive) {
              handle?.close();
              return;
            }
            rt = handle;
            // SSE stays open even when realtime connects: a row written between the
            // socket opening and the first join would otherwise be lost, and SSE is
            // the cheap safety net for exactly that gap.
            startSse();
          })
          .catch(() => startSse());
      };

      // The grant is minted from the case list, so the list has to arrive FIRST.
      // Opening the socket before this resolves would mint a grant for zero channels
      // and nothing would ever be pushed (→ the ordering bug this avoids).
      (async () => {
        let refs: string[] = [];
        try {
          const r = await fetch("/api/console/audit");
          if (r.ok) {
            const d = ((await r.json()) as { cases?: typeof cases }).cases ?? [];
            if (alive) setCases(d);
            refs = d.map((c) => c.callRef);
          }
        } catch {}
        if (alive) startRealtime(refs);
      })();
    }

    return () => {
      alive = false;
      // Both transports must be torn down: leaving the socket open would keep it
      // reconnecting after the operator navigates away.
      es?.close();
      rt?.close();
      // Clean up transcript polling interval
      if ((window as any).__transcriptPoll) {
        clearInterval((window as any).__transcriptPoll);
        (window as any).__transcriptPoll = undefined;
      }
    };
  }, [isSignedIn, role]);

  if (!isLoaded) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-ink-3" />
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
        <ShieldCheck className="h-8 w-8 text-primary" />
        <p className="font-display text-xl font-semibold">Sign in to open the Command Center</p>
        <p className="max-w-sm text-[13px] text-ink-2">
          The Command Center is available to every provisioned seat — demo explorers and bank
          operators see the same surface.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => setView("auth")}
            className="rounded-full bg-primary px-6 py-2.5 text-[13px] font-semibold text-white transition hover:bg-green-deep"
          >
            Sign in
          </button>
          <button
            onClick={() => setView("demo")}
            className="rounded-full border border-line px-6 py-2.5 text-[13px] font-semibold text-ink-2 transition hover:border-primary/40"
          >
            Open demo
          </button>
        </div>
      </div>
    );
  }

  const enroll = async () => {
    const trimmed = phone.trim();
    if (!/^\+[1-9]\d{7,14}$/.test(trimmed)) {
      setEnrollState({ ok: false, msg: "Phone must be E.164 format, e.g. +971501234567" });
      return;
    }
    setEnrolling(true);
    setEnrollState(null);
    try {
      const r = await fetch("/api/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerRef,
          phone: trimmed,
          lang: enrollLang,
          channel: enrollChannel,
          consentRecordId: `CN-${customerRef}`,
        }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
      };
      setEnrollState({
        ok: !!d.ok,
        msg: d.ok ? (d.message ?? "Enrolled") : (d.error ?? "Enrollment failed"),
      });
    } catch {
      setEnrollState({ ok: false, msg: "Network error — try again." });
    } finally {
      setEnrolling(false);
    }
  };

  const fire = async () => {
    setFiring(true);
    setRes(null);
    setChain(null);
    try {
      const r = await fetch("/api/console/fire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          riskScore: risk,
          channel,
          lang: fireLang,
          ...(amount ? { amountAed: Number(amount) } : {}),
          ...(merchant ? { merchant } : {}),
        }),
      });
      const data = (await r
        .json()
        .catch(() => ({ error: "Unreadable response from server" }))) as FireResponse;
      if (typeof data.creditsRemaining === "number") setCredits(data.creditsRemaining);
      setRes(data);
      // Start live transcript polling for the fired case
      if (data.caseRef) {
        setActiveCallRef(data.caseRef);
        setTranscript([]);
        setLiveCall(null);
        // Poll immediately, then every 3s
        void pollTranscript(data.caseRef);
        const iv = setInterval(() => {
          void pollTranscript(data.caseRef!);
        }, 3000);
        // Store interval for cleanup
        (window as any).__transcriptPoll = iv;
      }
      // refresh the recent-cases strip (async, outside any effect body)
      (async () => {
        try {
          const cr = await fetch("/api/console/audit");
          if (cr.ok) setCases(((await cr.json()) as { cases: typeof cases }).cases ?? []);
        } catch {}
      })();
    } catch {
      setRes({ error: "Network error — the signal never left the console." });
    } finally {
      setFiring(false);
    }
  };

  const verifyChainFor = async () => {
    if (!res?.caseRef) return;
    setChain({ checking: true });
    try {
      const r = await fetch(`/api/console/audit?callRef=${encodeURIComponent(res.caseRef)}`);
      const d = (await r
        .json()
        .catch(() => ({ verification: { ok: false, rows: 0, brokenAt: "unparseable" } }))) as {
        verification: ChainVerification;
      };
      setChain({ checking: false, result: d.verification });
    } catch {
      setChain({ checking: false, result: { ok: false, rows: 0, brokenAt: "network" } });
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      {/* graceful degradation: DB down → maintenance state, no raw errors */}
      {status && status.ok === false && (
        <div
          role="alert"
          className="mb-6 flex items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-5 py-4"
        >
          <Loader2 className="h-5 w-5 animate-spin text-amber-600" />
          <div>
            <p className="text-[13px] font-semibold text-amber-900">System under maintenance</p>
            <p className="text-[12px] text-amber-800">
              The case database is not responding — signals are rejected for safety until it
              recovers. This page retries automatically.
            </p>
          </div>
        </div>
      )}

      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            {branding?.orgLogoUrl ? (
              <img src={branding.orgLogoUrl} alt="" className="h-6 w-6 rounded-lg object-contain" />
            ) : (
              <span className="micro text-primary">COMMAND CENTER</span>
            )}
            <LiveDot />
          </div>
          <h1 className="font-display mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
            {branding?.orgName ?? (ar ? "مركز التشغيل" : "Run the platform")}
          </h1>
          <p className="mt-2 max-w-xl text-[13.5px] leading-relaxed text-ink-2">
            {role === "operator"
              ? "Full production access — connect your own phone, fire a real risk signal through the signed ingest path, and follow the response runbook step by step."
              : "Sandboxed workspace — everything a bank operator sees, with seeded cases and a metered platform voice key. Fire a signal and watch the full pipeline."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {role !== "operator" && (
            <span
              className="flex items-center gap-1.5 rounded-full bg-amber-tint px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-wide text-amber-soft"
              title="Sandboxed workspace — seeded data, metered platform key"
            >
              🟡 Demo Mode
            </span>
          )}
          <Chip className="!text-[10.5px]">
            <Coins className="h-3 w-3 text-[#8a6d1d]" /> {credits ?? "…"} credits left
          </Chip>
          <Chip className="!text-[10.5px]">
            <PhoneCall className="h-3 w-3 text-primary" /> telephony: {status?.telephony ?? "…"}
          </Chip>
          <Chip className="!text-[10.5px]">
            <Radio className="h-3 w-3 text-primary" /> voice:{" "}
            {status?.voiceProvider?.split(" ")[0] ?? "…"}
          </Chip>
          <Chip className="!text-[10.5px]">
            <Siren className="h-3 w-3 text-primary" /> ingest:{" "}
            {status?.ingest?.split(" ")[0] ?? "…"}
          </Chip>
          <a
            href="mailto:otemaach@gmail.com?subject=SecureVoice%20feedback"
            className="flex items-center gap-1.5 rounded-full border border-line bg-white px-2.5 py-1 text-[10.5px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary"
          >
            <Mail className="h-3 w-3" /> Feedback
          </a>
        </div>
        {liveFeed.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="micro flex items-center gap-1.5 text-[9px] text-primary">
              <LiveDot /> LIVE PIPELINE
            </span>
            {liveFeed.map((line, i) => (
              <span
                key={`${line}-${i}`}
                className="num rounded-full border border-line bg-white px-2.5 py-1 text-[10px] text-ink-2"
              >
                {line}
              </span>
            ))}
          </div>
        )}
        {/* Transport badge sits OUTSIDE the liveFeed guard on purpose: with no
            activity yet the console still needs to say which transport it is on.
            Realtime is the push path; "unavailable" means SSE fallback, which is a
            normal working state, not a fault. */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "micro rounded-full border px-2 py-1 text-[9px]",
              rtStatus === "live"
                ? "border-green-tint text-primary"
                : rtStatus === "connecting"
                  ? "border-line text-ink-2"
                  : "border-line text-ink-3",
            )}
          >
            feed:{" "}
            {rtStatus === "live" ? "websocket" : rtStatus === "connecting" ? "connecting" : "sse"}
          </span>
        </div>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_1.1fr]">
        {/* ————— left rail: connect + fire ————— */}
        <div className="space-y-6">
          <div className="rounded-3xl border border-line bg-white p-6">
            <div className="flex items-center gap-2">
              <span className="num flex h-6 w-6 items-center justify-center rounded-lg bg-green-tint text-[11px] font-semibold text-primary">
                1
              </span>
              <h2 className="font-display text-[15px] font-semibold">Connect your phone</h2>
            </div>
            <p className="mt-1.5 text-[12px] leading-snug text-ink-3">
              Enrolled as <span className="num text-ink-2">{customerRef}</span> · consent recorded
              for intervention contact.
            </p>
            <div className="mt-4 space-y-3.5">
              <div className="space-y-1.5">
                <Label className="text-[11.5px] font-semibold">Phone (E.164)</Label>
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+971501234567"
                  className={inputCls}
                  inputMode="tel"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-[11.5px] font-semibold">Language</Label>
                  <select
                    value={enrollLang}
                    onChange={(e) => setEnrollLang(e.target.value)}
                    className={cn(inputCls, "w-full border px-3")}
                  >
                    <option value="en">English</option>
                    <option value="ar">العربية</option>
                    <option value="hi">हिन्दी</option>
                    <option value="ur">اردو</option>
                    <option value="fr">Français</option>
                    <option value="sw">Kiswahili</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11.5px] font-semibold">Channel</Label>
                  <div className="flex items-center rounded-xl border border-line bg-paper p-1">
                    {(["call", "sms"] as const).map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setEnrollChannel(c)}
                        aria-pressed={enrollChannel === c}
                        className={cn(
                          "flex-1 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition",
                          enrollChannel === c ? "bg-[#0c110e] text-white" : "text-ink-3",
                        )}
                      >
                        {c === "call" ? "Voice call" : "SMS"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <button
                onClick={enroll}
                disabled={enrolling || !phone.trim()}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-primary py-2.5 text-[12.5px] font-semibold text-white transition hover:bg-green-deep disabled:opacity-40"
              >
                {enrolling ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <PhoneCall className="h-4 w-4" />
                )}
                Enroll this number
              </button>
              {enrollState && (
                <p
                  role="status"
                  className={cn(
                    "rounded-xl px-3.5 py-2.5 text-[12px] font-medium",
                    enrollState.ok ? "bg-green-tint text-green-deep" : "bg-red-tint text-red-soft",
                  )}
                >
                  {enrollState.msg}
                </p>
              )}
            </div>
          </div>

          <div className="rounded-3xl border border-line bg-white p-6">
            <div className="flex items-center gap-2">
              <span className="num flex h-6 w-6 items-center justify-center rounded-lg bg-green-tint text-[11px] font-semibold text-primary">
                2
              </span>
              <h2 className="font-display text-[15px] font-semibold">Fire a risk signal</h2>
              <StatusPill tone="gray">signed · replay-protected</StatusPill>
            </div>
            <p className="mt-1.5 text-[12px] leading-snug text-ink-3">
              The console server signs the exact bytes your fraud engine would send — same HMAC
              scheme, same endpoint, same audit trail.
            </p>
            <div className="mt-4 space-y-3.5">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-[11.5px] font-semibold">Risk score</Label>
                  <span className="num text-[12px] font-semibold text-primary">
                    {risk.toFixed(2)}
                  </span>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={0.99}
                  step={0.01}
                  value={risk}
                  onChange={(e) => setRisk(Number(e.target.value))}
                  className="w-full accent-[#0b7a55]"
                  aria-label="Risk score"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-[11.5px] font-semibold">Channel</Label>
                  <select
                    value={channel}
                    onChange={(e) => setChannel(e.target.value)}
                    className={cn(inputCls, "w-full border px-3")}
                  >
                    {["card", "login", "payment", "transfer", "remittance"].map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11.5px] font-semibold">Call language</Label>
                  <select
                    value={fireLang}
                    onChange={(e) => setFireLang(e.target.value)}
                    className={cn(inputCls, "w-full border px-3")}
                  >
                    <option value="en">English</option>
                    <option value="ar">العربية</option>
                    <option value="hi">हिन्दी</option>
                    <option value="ur">اردو</option>
                    <option value="fr">Français</option>
                    <option value="sw">Kiswahili</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-[11.5px] font-semibold">Amount (AED)</Label>
                  <Input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                    className={inputCls}
                    inputMode="decimal"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11.5px] font-semibold">Merchant</Label>
                  <Input
                    value={merchant}
                    onChange={(e) => setMerchant(e.target.value)}
                    className={inputCls}
                  />
                </div>
              </div>
              <button
                onClick={fire}
                disabled={firing}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-[#0c110e] py-3 text-[13px] font-semibold text-white transition hover:bg-black disabled:opacity-50"
              >
                {firing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Zap className="h-4 w-4 text-green-bright" />
                )}
                Fire intervention signal
              </button>
            </div>
          </div>
        </div>

        {/* ————— right rail: response ————— */}
        <div className="space-y-6">
          <div className="rounded-3xl border border-line bg-white p-6">
            <div className="flex items-center gap-2">
              <span className="num flex h-6 w-6 items-center justify-center rounded-lg bg-green-tint text-[11px] font-semibold text-primary">
                3
              </span>
              <h2 className="font-display text-[15px] font-semibold">
                Response &amp; actions to take
              </h2>
            </div>

            {!res && (
              <div className="mt-6 flex h-64 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line bg-paper/60 text-center">
                <Siren className="h-6 w-6 text-ink-3" strokeWidth={1.6} />
                <p className="max-w-[240px] text-[12.5px] leading-snug text-ink-3">
                  Fire a signal to see the case envelope, the 60-second SLA clock, the live delivery
                  receipt — and exactly what to do next.
                </p>
              </div>
            )}

            {res?.error && !res.caseRef && (
              <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[12.5px] font-medium text-red-700">
                {res.error}
              </div>
            )}

            {res?.caseRef && (
              <div className="mt-5 space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <p className="micro text-[9px] text-ink-3">CASE REFERENCE</p>
                    <p className="num mt-1 text-xl font-semibold tracking-wider">{res.caseRef}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <StatusPill tone="green">
                        <ShieldCheck className="h-3 w-3" /> {res.plan?.action ?? "armed"}
                      </StatusPill>
                      <StatusPill tone="amber">
                        <ArrowRight className="h-3 w-3" /> handoff: {res.plan?.handoff ?? "human"}
                      </StatusPill>
                    </div>
                  </div>
                  {res.slaDeadline && <SlaClock deadline={res.slaDeadline} />}
                </div>

                {res.delivery && <DeliveryCard delivery={res.delivery} />}

                <div className="rounded-2xl border border-line bg-paper/60 p-5">
                  <Runbook res={res} />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={verifyChainFor}
                    disabled={chain?.checking}
                    className="flex items-center gap-2 rounded-full border border-line bg-white px-4 py-2 text-[12px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary disabled:opacity-40"
                  >
                    {chain?.checking ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <History className="h-3.5 w-3.5" />
                    )}
                    Verify audit chain
                  </button>
                  {chain?.result && (
                    <span
                      className={cn(
                        "flex items-center gap-1.5 text-[12px] font-semibold",
                        chain.result.ok ? "text-green-deep" : "text-red-soft",
                      )}
                    >
                      {chain.result.ok ? (
                        <CheckCircle2 className="h-4 w-4" />
                      ) : (
                        <XCircle className="h-4 w-4" />
                      )}
                      {chain.result.ok
                        ? `intact — ${chain.result.rows} rows, every link valid`
                        : `BROKEN at ${chain.result.brokenAt}`}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* recent cases */}
          <div className="rounded-3xl border border-line bg-white p-6">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-[15px] font-semibold">Recent interventions</h2>
              <div className="flex items-center gap-2">
                <Chip className="!text-[10px]">
                  <Timer className="h-3 w-3" /> SLA 60s
                </Chip>
                {cases.length > 0 && (
                  <button
                    onClick={() => {
                      // Bank analysts live in Excel, so every cell is untrusted
                      // input rendered inside a spreadsheet that executes
                      // formulas. `interventionsCsv` goes through `toCsv`, which
                      // neutralises a leading = + - @ and RFC-4180 quotes the
                      // field; the hand-rolled join this replaced did neither.
                      const csv = interventionsCsv(
                        cases.map((c) => ({
                          callRef: c.callRef,
                          riskScore: c.riskScore ?? null,
                          channel: c.channel ?? null,
                          plannedAction: c.plannedAction ?? null,
                          at: c.at,
                        })),
                      );
                      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `securevoice-interventions-${new Date().toISOString().slice(0, 10)}.csv`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[10.5px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary"
                  >
                    <Download className="h-3 w-3" />
                    CSV
                  </button>
                )}
              </div>
            </div>
            {cases.length === 0 ? (
              <p className="mt-4 text-[12.5px] text-ink-3">No cases yet — fire the first signal.</p>
            ) : (
              <ul className="mt-4 space-y-2.5">
                {cases.slice(0, 6).map((c) => (
                  <motion.li
                    key={c.callRef}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex items-center justify-between gap-3 rounded-xl border border-line bg-paper/60 px-3.5 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="num text-[12px] font-semibold">{c.callRef}</p>
                      <p className="truncate text-[11px] text-ink-3">
                        {c.channel ?? "—"} · {c.plannedAction ?? "—"} ·{" "}
                        {new Date(c.at).toLocaleTimeString()}
                      </p>
                    </div>
                    <span
                      className={cn(
                        "num rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
                        (c.riskScore ?? 0) >= 0.9
                          ? "bg-red-tint text-red-soft"
                          : "bg-amber-tint text-amber-soft",
                      )}
                    >
                      {c.riskScore != null ? c.riskScore.toFixed(2) : "—"}
                    </span>
                  </motion.li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* ————— Live Operations panel ————— */}
      <div className="mt-6">
        <LiveOpsPanel
          activeCallRef={activeCallRef}
          transcript={transcript}
          call={liveCall}
          rtStatus={rtStatus}
        />
      </div>
    </div>
  );
}
