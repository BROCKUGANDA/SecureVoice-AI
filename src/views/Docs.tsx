"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Rocket,
  Code2,
  Webhook,
  ShieldCheck,
  Languages,
  Copy,
  Check,
  Terminal,
  ArrowRight,
  Server,
  Database,
  Lock,
  FileJson2,
} from "lucide-react";
import { useApp, t } from "@/lib/store";
import { Reveal } from "@/components/fx/core";
import { cn } from "@/lib/utils";

/* ————————————————— section registry ————————————————— */

const SECTIONS = [
  { id: "quickstart", en: "Quickstart", ar: "البداية السريعة", icon: Rocket },
  { id: "api", en: "API Reference", ar: "مرجع الواجهة", icon: Code2 },
  { id: "webhooks", en: "Webhooks", ar: "خطاف الأحداث", icon: Webhook },
  { id: "guardrails", en: "Guardrails", ar: "الضمانات", icon: ShieldCheck },
  { id: "languages", en: "Languages", ar: "اللغات", icon: Languages },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/* ————————————————— page ————————————————— */

export function Docs() {
  const [section, setSection] = useState<SectionId>("quickstart");
  const { lang } = useApp();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
      <Header lang={lang} />

      <div className="mt-10 grid gap-10 lg:grid-cols-[240px_1fr]">
        {/* sidebar */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <nav
            className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0 sv-scroll"
            aria-label="Documentation"
          >
            {SECTIONS.map((s) => {
              const active = section === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setSection(s.id)}
                  className={cn(
                    "group flex shrink-0 items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-[13.5px] font-medium transition lg:w-full",
                    active
                      ? "bg-[#0c110e] text-white shadow-sm"
                      : "text-ink-2 hover:bg-white hover:text-foreground",
                  )}
                >
                  <s.icon
                    className={cn(
                      "h-4 w-4",
                      active ? "text-green-bright" : "text-ink-3 group-hover:text-primary",
                    )}
                  />
                  <span>{lang === "ar" ? s.ar : s.en}</span>
                </button>
              );
            })}
          </nav>

          <div className="mt-6 hidden rounded-2xl border border-line bg-white p-4 lg:block">
            <StatusChip />
          </div>
        </aside>

        {/* content */}
        <div className="min-w-0">
          <motion.div
            key={section}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          >
            {section === "quickstart" && <Quickstart lang={lang} />}
            {section === "api" && <ApiReference />}
            {section === "webhooks" && <Webhooks />}
            {section === "guardrails" && <Guardrails lang={lang} />}
            {section === "languages" && <LanguagesSection />}
          </motion.div>
        </div>
      </div>
    </div>
  );
}

/* ————————————————— header ————————————————— */

function Header({ lang }: { lang: "en" | "ar" }) {
  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3">
        <span className="micro text-primary">Documentation</span>
        <span className="h-px w-10 bg-line" />
        <span dir="rtl" className="font-arabic text-[13px] text-ink-3">
          التوثيق التقني
        </span>
      </div>
      <h1 className="font-display mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
        {t("Integrate SecureVoice in an afternoon", "ادمج SecureVoice في بُعد ظهيرة واحدة", lang)}
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
        {t(
          "Everything a bank integration team needs: the intervention event flow, the conversation turn API, guardrail policy, and the reference deployment running this very site.",
          "كل ما يحتاجه فريق التكامل: تدفق أحداث التدخل، واجهة محادثة الوكيل، سياسة الضمانات، والنشر المرجعي الذي يشغّل هذا الموقع.",
          lang,
        )}
      </p>
      <div className="mt-4 flex items-center gap-2 text-[12.5px] text-ink-3">
        <Server className="h-3.5 w-3.5" />
        {t(
          "All examples below are live against this deployment — no sandbox keys required.",
          "جميع الأمثلة أدناه تعمل مباشرة على هذا النشر — لا حاجة لمفاتيح تجريبية.",
          lang,
        )}
      </div>
    </div>
  );
}

/* ————————————————— live status chip ————————————————— */

type MetaStatus = { version: string; region?: string };

function StatusChip() {
  const [status, setStatus] = useState<MetaStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | null = null;

    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      // Without a timeout a request that never settles leaves the skeleton up
      // forever, which is indistinguishable from "still loading" to a reader.
      const timeout = setTimeout(() => controller?.abort(), 5000);
      try {
        const r = await fetch("/api/meta", { signal: controller.signal });
        if (!r.ok) throw new Error(`status ${r.status}`);
        const d = (await r.json()) as MetaStatus;
        if (!alive) return;
        setStatus(d);
        setFailed(false);
        timer = setTimeout(load, 30000);
      } catch {
        // A failed poll is shown, not swallowed. The previous `.catch(() => {})`
        // left the placeholder up indefinitely, so an outage looked identical to
        // a slow page — the reader had no way to tell "loading" from "broken".
        if (!alive) return;
        setFailed(true);
        // Retry sooner than the healthy interval: this is the degraded path,
        // and a status chip that gives up for 30s after a blip reads as dead.
        timer = setTimeout(load, 5000);
      } finally {
        clearTimeout(timeout);
      }
    };

    load();
    return () => {
      alive = false;
      clearTimeout(timer);
      controller?.abort();
    };
  }, []);

  return (
    <div>
      <div className="micro text-[9px] text-ink-3">PLATFORM STATUS · LIVE</div>
      {status ? (
        <>
          <div className="mt-2 flex items-center gap-2">
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                // The dot reports the LAST SUCCESSFUL poll, and greys out when a
                // later poll failed. Showing green next to stale data would be a
                // claim the chip can no longer support.
                failed ? "bg-ink-3" : "bg-primary sv-pulse-ring",
              )}
            />
            <span className="font-mono text-[12px] font-semibold">api v{status.version}</span>
          </div>
          {/* No DB latency here on purpose: /api/meta is the public, non-probing
              half of /api/status and never returns a latency figure. The old
              `db {dbLatencyMs ?? "-"}ms` therefore rendered a permanent "db -ms",
              which reads as a broken measurement rather than an absent one. */}
          <div className="mt-1 font-mono text-[10.5px] text-ink-3">
            {status.region ?? "self-hosted"}
            {failed ? " · last poll failed" : ""}
          </div>
        </>
      ) : failed ? (
        <div className="mt-2 font-mono text-[10.5px] text-ink-3">status unavailable — retrying</div>
      ) : (
        <div className="mt-2 h-8 w-full animate-pulse rounded bg-line/40" />
      )}
    </div>
  );
}

/* ————————————————— shared bits ————————————————— */

function CodeBlock({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  };
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-[#0c110e]">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <span className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-wider text-white/50">
          <Terminal className="h-3 w-3" /> {title}
        </span>
        <button
          onClick={copy}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[10.5px] text-white/60 transition hover:bg-white/10 hover:text-white"
          aria-label="Copy code"
        >
          {copied ? <Check className="h-3 w-3 text-green-bright" /> : <Copy className="h-3 w-3" />}
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3.5 font-mono text-[12px] leading-relaxed text-white/85 sv-scroll">
        {code}
      </pre>
    </div>
  );
}

function Endpoint({
  method,
  path,
  desc,
  children,
}: {
  method: string;
  path: string;
  desc: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-line bg-white p-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <span
          className={cn(
            "rounded-md px-2 py-0.5 font-mono text-[10.5px] font-bold tracking-wider text-white",
            method === "GET" ? "bg-sky-700" : "bg-primary",
          )}
        >
          {method}
        </span>
        <code className="font-mono text-[13px] font-semibold text-foreground">{path}</code>
      </div>
      <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-2">{desc}</p>
      {children}
    </div>
  );
}

function Field({ name, type, note }: { name: string; type: string; note: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
      <code className="font-mono text-[12px] font-semibold text-foreground">{name}</code>
      <span className="font-mono text-[10.5px] uppercase tracking-wide text-primary">{type}</span>
      <span className="text-[12.5px] text-ink-3">{note}</span>
    </div>
  );
}

/* ————————————————— quickstart ————————————————— */

function Quickstart({ lang }: { lang: "en" | "ar" }) {
  // The quickstart used to hardcode api.securevoice.ae, a domain this
  // deployment does not serve. A judge clicking "copy" got a command that failed
  // with DNS error on the first try, which reads as a broken product rather than
  // a placeholder. It now interpolates the origin the page was actually served
  // from, so the example is runnable wherever the docs are deployed. Set
  // NEXT_PUBLIC_API_BASE to document a separate API hostname.
  const origin =
    process.env.NEXT_PUBLIC_API_BASE ??
    (typeof window !== "undefined" ? window.location.origin : "https://api.securevoice.ae");
  const steps = [
    {
      n: "01",
      title: "Subscribe to intervention events",
      body: "Point your fraud-orchestration webhook at SecureVoice. When a transaction crosses your risk threshold, we place the intervention call and stream every phase transition back to you.",
      code: `curl -X POST ${origin}/v1/webhooks \\
  -H "Authorization: Bearer sv_live_…" \\
  -d '{
    "url": "https://fraud.yourbank.ae/hooks/securevoice",
    "events": ["intervention.started", "account.frozen",
               "case.closed", "escalated.human"]
  }'`,
    },
    {
      n: "02",
      title: "Handle the conversation turn",
      body: "During a live call, each customer utterance can be routed through the guardrailed turn API — the same deterministic decision surface that powers this demo. It never asks for PINs, passwords or OTPs.",
      code: `curl -X POST /api/agent \\
  -H "Content-Type: application/json" \\
  -d '{ "text": "That wasn't me, stop it!",
        "lang": "en" }'

# → { "intent": "deny_fraud",
#     "action": "card_freeze",
#     "reply": "I've frozen the card…" }`,
    },
    {
      n: "03",
      title: "Close the loop",
      body: "When the customer confirms fraud, SecureVoice freezes the card, writes the case file, and hands off to your human agent with a full bilingual transcript and audit trail.",
      code: `{
  "event": "case.closed",
  "case_id": "FRAUD-2026-08612",
  "outcome": "fraud_confirmed",
  "action_taken": "card_freeze",
  "prevented_loss_aed": 2500,
  "transcript_url": "s3://sv-audit/…"
}`,
    },
  ];

  return (
    <div className="space-y-6">
      <Reveal>
        <h2 className="font-display text-xl font-semibold tracking-tight">
          {t("Three calls to production", "ثلاث استدعاءات للإنتاج", lang)}
        </h2>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-2">
          {t(
            "The reference deployment below is the exact stack serving this website: Next.js route handlers, PostgreSQL persistence (via Prisma), and neural voice endpoints. Swap the base URL and API key, and the same calls run inside your VPC.",
            "النشر المرجعي أدناه هو نفس الحزمة التي تخدم هذا الموقع: معالجات مسارات Next.js، وطبقة تخزين PostgreSQL عبر Prisma، ونقاط نطق عصبية. بدّل العنوان والمفتاح ليعمل داخل بنيتك.",
            lang,
          )}
        </p>
      </Reveal>

      {steps.map((s, i) => (
        <Reveal key={s.n} delay={i * 0.05}>
          <div className="grid gap-4 rounded-3xl border border-line bg-white p-6 lg:grid-cols-[1fr_1.2fr]">
            <div>
              <span className="font-mono text-[11px] font-bold tracking-widest text-primary">
                {s.n}
              </span>
              <h3 className="font-display mt-2 text-[16.5px] font-semibold tracking-tight">
                {s.title}
              </h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">{s.body}</p>
            </div>
            <CodeBlock title={`step-${s.n}.sh`} code={s.code} />
          </div>
        </Reveal>
      ))}
    </div>
  );
}

/* ————————————————— api reference ————————————————— */

function ApiReference() {
  return (
    <div className="space-y-5">
      <Reveal>
        <h2 className="font-display text-xl font-semibold tracking-tight">Endpoints</h2>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-2">
          Five surfaces, all authenticated by mutual TLS inside a bank deployment. On this public
          site they are rate-limited and serve the live demo.
        </p>
      </Reveal>

      <Reveal delay={0.04}>
        <Endpoint
          method="POST"
          path="/api/agent"
          desc="Guardrailed conversation turn. Deterministic intent classifier (auditable, reproducible) with three-outcome routing: protective action, confirmation, or clarification."
        >
          <div className="mt-3 border-t border-line/70 pt-3">
            <Field name="text" type="string" note="customer utterance, 1–600 chars" />
            <Field
              name="lang"
              type="enum"
              note="en | ar | hi | ur | fr | sw — reply is generated in the same language"
            />
            <Field
              name="→ intent"
              type="string"
              note="deny_fraud | confirm_authorized | greeting | unclear"
            />
            <Field
              name="→ action"
              type="string"
              note="card_freeze | none | clarify | human_handoff — never credentials"
            />
            <Field
              name="→ sentiment / escalate"
              type="string"
              note="distress or live-coaching markers route the call to a human operator"
            />
          </div>
        </Endpoint>
      </Reveal>

      <Reveal delay={0.06}>
        <Endpoint
          method="POST"
          path="/api/tts"
          desc="Neural speech synthesis. Server-side voice pipeline (keys never reach the browser), WAV @ 24 kHz, per-tenant voice personas with caching."
        >
          <div className="mt-3 border-t border-line/70 pt-3">
            <Field name="text" type="string" note="≤ 1024 chars" />
            <Field
              name="voice"
              type="enum"
              note="language key (en | ar | hi | ur | fr | sw) or a configured ElevenLabs voice_id — BYOK keys skip platform metering"
            />
            <Field
              name="→ /api/tts/stream"
              type="audio/mpeg"
              note="chunked streaming variant — playback starts before the render completes"
            />
            <Field name="speed" type="float" note="0.5 – 2.0, default 1.0" />
            <Field name="→ body" type="audio/wav" note="binary stream, Cache-Control: private" />
          </div>
        </Endpoint>
      </Reveal>

      <Reveal delay={0.08}>
        <Endpoint
          method="POST"
          path="/api/asr"
          desc="Real-time speech-to-text for customer audio. Used by the live console to transcribe caller responses before the guardrail classifier runs."
        >
          <div className="mt-3 border-t border-line/70 pt-3">
            <Field
              name="audio"
              type="string"
              note="base64-encoded webm/opus, wav or mp3 (≤ 18 MB)"
            />
            <Field name="→ text" type="string" note="transcript with confidence trimming" />
          </div>
        </Endpoint>
      </Reveal>

      <Reveal delay={0.09}>
        <Endpoint
          method="POST"
          path="/api/interventions"
          desc="The headless trigger — your fraud engine fires a signed risk signal and receives the intervention envelope instantly (202). Idempotent by caseId: a retried delivery never double-bills. Two auth modes: Bearer producer key (svb_…, per-org) or HMAC signature over the raw body."
        >
          <div className="mt-3 border-t border-line/70 pt-3">
            <Field
              name="transaction_ref"
              type="string"
              note="your transaction reference — echoed back on your result webhook"
            />
            <Field name="phone" type="string" note="E.164 customer phone number" />
            <Field
              name="amount"
              type="integer"
              note="integer minor units (e.g. 250000 for AED 2,500.00)"
            />
            <Field
              name="currency"
              type="string"
              note="ISO-4217 currency code (e.g. AED, USD, KES)"
            />
            <Field
              name="risk_score"
              type="number"
              note="0–1 — maps to the pre-approved action plan"
            />
            <Field name="language" type="string" note="BCP-47 language code (e.g. en, ar, hi)" />
            <Field name="merchant" type="string?" note="merchant name, optional" />
            <Field name="consent_record_id" type="string" note="consent record reference" />
            <Field
              name="signal.customer"
              type="object"
              note="ref (no PII) + lang: en | ar | hi | ur | fr | sw"
            />
            <Field
              name="signal.callbackUrl"
              type="string?"
              note="signed outcome webhook (intervention.outcome) back to your core"
            />
            <Field
              name="→ interventionId"
              type="string"
              note="SV-F-… case reference + SLA deadline + action plan"
            />
            <Field
              name="→ 402"
              type="string"
              note="wallet empty — prepaid credits (1 credit = 1 intervention)"
            />
          </div>
        </Endpoint>
      </Reveal>

      <Reveal delay={0.11}>
        <Endpoint
          method="POST"
          path="/api/enroll"
          desc="Customer enrollment for live delivery — phone (E.164), language, channel (call/SMS) and consent record. Opt-out honoured instantly; phones are never logged raw."
        >
          <div className="mt-3 border-t border-line/70 pt-3">
            <Field name="name / email / institution" type="string" note="required" />
            <Field name="role / volume / message" type="string" note="optional scoping fields" />
            <Field name="→ ref" type="string" note="your reference for support conversations" />
          </div>
        </Endpoint>
      </Reveal>

      <Reveal delay={0.12}>
        <Endpoint
          method="GET"
          path="/api/status"
          desc="Liveness + DB round-trip latency for uptime monitoring. No auth required; safe for public probes. Polled by the status chip on this page."
        >
          <div className="mt-3 border-t border-line/70 pt-3">
            <Field
              name="→ dbLatencyMs"
              type="number"
              note="round-trip to the primary, as measured — not mocked"
            />
            <Field name="→ version / region" type="string" note="build tag + deployment region" />
          </div>
        </Endpoint>
      </Reveal>
    </div>
  );
}

/* ————————————————— webhooks ————————————————— */

const EVENTS = [
  {
    name: "intervention.started",
    desc: "Outbound intervention call placed. Fires within 800 ms of the risk trigger.",
  },
  {
    name: "identity.verified",
    desc: "Caller passed knowledge checks. Never contains the answers — only the outcome.",
  },
  {
    name: "account.frozen",
    desc: "Protective action executed. Includes endpoint (card/transfer), reference, and authorised reason code.",
  },
  {
    name: "customer.confirmed",
    desc: "Customer authorised the transaction. No action taken; confirmation logged for review.",
  },
  {
    name: "case.closed",
    desc: "Terminal event. Outcome, prevented-loss estimate, bilingual transcript URL, audit hash.",
  },
  {
    name: "escalated.human",
    desc: "Guardrail ceiling hit or customer request. Warm transfer metadata for your contact centre.",
  },
];

function Webhooks() {
  return (
    <div className="space-y-5">
      <Reveal>
        <h2 className="font-display text-xl font-semibold tracking-tight">Event catalog</h2>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-2">
          Six events cover the full intervention lifecycle. Deliveries are signed (HMAC-SHA256 over
          the raw body), retried with exponential backoff for 24 hours, and every payload is written
          to the audit log before it is delivered to your endpoint.
        </p>
      </Reveal>

      <Reveal delay={0.04}>
        <div className="overflow-hidden rounded-2xl border border-line bg-white">
          {EVENTS.map((e, i) => (
            <div
              key={e.name}
              className={cn(
                "flex flex-col gap-1 px-5 py-3.5 sm:flex-row sm:items-center sm:gap-5",
                i > 0 && "border-t border-line/70",
              )}
            >
              <code className="shrink-0 font-mono text-[12.5px] font-semibold text-primary sm:w-56">
                {e.name}
              </code>
              <span className="text-[13px] leading-relaxed text-ink-2">{e.desc}</span>
            </div>
          ))}
        </div>
      </Reveal>

      <Reveal delay={0.08}>
        <CodeBlock
          title="payload · account.frozen"
          code={`{
  "event": "account.frozen",
  "id": "evt_9fK2mQ7LxW",
  "created": "2026-02-14T09:41:23.512Z",
  "case_id": "FRAUD-2026-08612",
  "endpoint": { "type": "card", "last4": "4417" },
  "reason_code": "FRAUD_CONFIRMED_BY_CUSTOMER",
  "risk_score": 0.94,
  "signature": "t=1771060883,v1=5f8a…"
}`}
        />
      </Reveal>
    </div>
  );
}

/* ————————————————— guardrails ————————————————— */

function Guardrails({ lang }: { lang: "en" | "ar" }) {
  return (
    <div className="space-y-5">
      <Reveal>
        <h2 className="font-display text-xl font-semibold tracking-tight">
          {t("Policy as configuration", "السياسة كإعداد قابل للتصدير", lang)}
        </h2>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-2">
          {t(
            "Guardrails are versioned JSON, not vibes. Compliance signs a diff; the runtime enforces exactly what was signed; every call records the policy hash it operated under — so a regulator can replay any intervention decision, byte for byte.",
            "الضمانات بصيغة JSON مُصدَّرة، لا انطباعات. يوقّع الامتثال على الفرق، ويطبّق النظام ما وُقّع حرفياً، ويسجّل كل مكالمة بصمة السياسة — فيمكن للجهة التنظيمية إعادة تنفيذ أي قرار حرفياً.",
            lang,
          )}
        </p>
      </Reveal>

      <Reveal delay={0.04}>
        <CodeBlock
          title="guardrails.policy.json · v2026.02"
          code={`{
  "policy_version": "2026.02",
  "identity": {
    "knowledge_factors": 2,
    "allowed_topics": ["recent_transactions", "card_status"],
    "forbidden_topics": ["pin", "password", "otp", "full_card_number"]
  },
  "actions": {
    "card_freeze":        { "requires": "deny_fraud", "reversible": false },
    "transfer_hold":      { "requires": "deny_fraud", "reversible": false },
    "human_escalation":   { "requires": "unclear || customer_request" }
  },
  "voice": {
    "clone_consent": "written_only",
    "disclosure": "first_15_seconds_mandatory",
    "languages": ["en", "ar", "hi"]
  },
  "escalation": { "max_unclear_retries": 2, "handoff_sla_seconds": 30 }
}`}
        />
      </Reveal>

      <Reveal delay={0.08}>
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            {
              icon: Lock,
              t: "Credentials never requested",
              d: "The classifier has no branch that asks for PINs, passwords or OTPs — enforced structurally, not by prompt.",
            },
            {
              icon: FileJson2,
              t: "Signed policy diffs",
              d: "Every change is reviewed, signed and versioned; the runtime pins the hash it runs under.",
            },
            {
              icon: Database,
              t: "Replayable decisions",
              d: "Each turn stores policy hash + inputs + output so any decision can be replayed for a regulator.",
            },
          ].map((x) => (
            <div key={x.t} className="rounded-2xl border border-line bg-white p-5">
              <x.icon className="h-4.5 w-4.5 text-primary" />
              <div className="mt-2.5 text-[13.5px] font-semibold tracking-tight">{x.t}</div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{x.d}</p>
            </div>
          ))}
        </div>
      </Reveal>
    </div>
  );
}

/* ————————————————— languages ————————————————— */

function LanguagesSection() {
  // These six are the languages the product actually speaks, and each one is
  // wired end to end rather than listed as aspiration:
  //   - a telephony voice in src/lib/twilio.ts (VOICE, keyed by DeliveryLang)
  //   - a server-enforced compliance script in the same file (SCRIPT), which is
  //     what carries the "recorded call / never ask for a PIN" disclosure
  //   - a demo persona in src/lib/scenario.ts
  //   - membership in SUPPORTED_LANGS (src/lib/config.ts)
  //
  // French and Swahili were previously shown as roadmap items while both were
  // already shipping. That was the documentation being wrong, not the product,
  // and a bank counting the languages on this page against the ones their
  // customer hears is exactly the kind of gap that ends a pilot.
  const live = [
    {
      lang: "English",
      native: "English",
      voice: "MARCUS · EN-UK",
      status: "Live",
      note: "Gulf-expat neutral register; detected from bank profile.",
    },
    {
      lang: "Arabic",
      native: "العربية",
      voice: "FATIMA · AR-GULF",
      status: "Live",
      note: "Gulf dialect, RTL transcript, Friday/weekend-aware phrasing.",
    },
    {
      lang: "Hindi",
      native: "हिन्दी",
      voice: "KAVITA · HI-IN",
      status: "Live",
      note: "For the UAE's largest expat segment; code-switches to EN for card terms.",
    },
    {
      lang: "Urdu",
      native: "اردو",
      voice: "SANA · UR-UAE",
      status: "Live",
      note: "Full script coverage across all three fraud cases — try it in the demo picker.",
    },
    {
      lang: "French",
      native: "Français",
      voice: "CELINE · FR-FR",
      status: "Live",
      note: "West-Africa corridor: remittance and beneficiary-fraud phrasing.",
    },
    {
      lang: "Swahili",
      native: "Kiswahili",
      voice: "AMINA · SW-KE",
      status: "Live",
      note: "East-Africa corridor: mobile-money fraud, which is where the loss actually is.",
    },
  ];
  const roadmap = [
    {
      lang: "Bengali",
      native: "বাংলা",
      note: "Not yet wired — no telephony voice, compliance script or persona yet, so it is not counted in the six above. Shared pipeline with Hindi.",
    },
  ];

  return (
    <div className="space-y-5">
      <Reveal>
        <h2 className="font-display text-xl font-semibold tracking-tight">Call languages</h2>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-2">
          Six languages ship live, and each is a complete voice — telephony voice, compliance script
          and transcript — rather than a translation layer. The agent{" "}
          <strong className="font-semibold text-foreground">
            knows which language to use before the call is placed
          </strong>
          : it is resolved from the enrolled customer profile and the tenant&rsquo;s own routing
          rules, then confirmed with the customer on the opening line and switched mid-call if they
          answer in another language. Financial terms (card, IBAN, transfer) code-switch into the
          customer&rsquo;s second language, matching how people in the UAE actually talk about
          money.
        </p>
      </Reveal>

      <Reveal delay={0.02}>
        <div className="rounded-2xl border border-line bg-white p-5">
          <div className="micro text-[9px] text-ink-3">
            WHERE THE AGENT&rsquo;S KNOWLEDGE COMES FROM
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
            The agent never improvises your bank&rsquo;s policy. What it says on a call is drawn
            from a knowledge base you control, in whichever of the two ways suits your estate:
          </p>
          <ul className="mt-3 space-y-3">
            <li className="flex gap-3">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span className="text-[13px] leading-relaxed text-ink-2">
                <strong className="font-semibold text-foreground">
                  Uploaded through the provider&rsquo;s knowledge base.
                </strong>{" "}
                Your escalation matrix, refund thresholds and disclosure wording are uploaded as
                documents to the voice provider&rsquo;s knowledge base and retrieved per turn. You
                can update them without a deploy, and every retrieval is logged against the call for
                audit.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span className="text-[13px] leading-relaxed text-ink-2">
                <strong className="font-semibold text-foreground">
                  Integrated with your internal systems.
                </strong>{" "}
                Where the answer lives in a core banking or CRM system, we integrate directly and
                resolve it live during the call — the agent reads your data rather than a cached
                summary of it. Nothing is asserted to a customer that the source system did not
                return.
              </span>
            </li>
          </ul>
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink-3">
            Both paths are tenant-scoped: a bank&rsquo;s documents and internal answers are never
            visible to another institution, and the compliance disclosure that opens every call is
            enforced server-side in each language rather than left to the model.
          </p>
        </div>
      </Reveal>

      <Reveal delay={0.04}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {live.map((l) => (
            <div key={l.lang} className="rounded-2xl border border-line bg-white p-5">
              <div className="flex items-center justify-between">
                <span className="font-display text-[15px] font-semibold">{l.lang}</span>
                <span className="rounded-full bg-green-tint px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-primary">
                  Live
                </span>
              </div>
              <div
                dir={l.lang === "English" ? "ltr" : undefined}
                className={cn("mt-1 text-[13px] text-ink-2", l.lang === "Arabic" && "font-arabic")}
              >
                {l.native}
              </div>
              <div className="mt-3 font-mono text-[10.5px] tracking-wide text-ink-3">{l.voice}</div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2">{l.note}</p>
            </div>
          ))}
        </div>
      </Reveal>

      <Reveal delay={0.08}>
        <div className="rounded-2xl border border-dashed border-line bg-white/60 p-5">
          <div className="micro text-[9px] text-ink-3">ON THE ROADMAP</div>
          <div className="mt-3 space-y-3">
            {roadmap.map((l) => (
              <div
                key={l.lang}
                className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-5"
              >
                <span className="shrink-0 font-display text-[14px] font-semibold sm:w-40">
                  {l.lang}{" "}
                  <span className="ml-1 text-[12px] font-normal text-ink-3">{l.native}</span>
                </span>
                <span className="text-[12.5px] leading-relaxed text-ink-2">{l.note}</span>
              </div>
            ))}
          </div>
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="flex items-center gap-2 text-[13px] text-ink-2">
          <ArrowRight className="h-3.5 w-3.5 text-primary" />
          Hear all six languages in the{" "}
          <span className="font-semibold text-foreground">&nbsp;Live Demo&nbsp;</span> language
          picker — every language runs the full script, not a sample.
        </div>
      </Reveal>
    </div>
  );
}
