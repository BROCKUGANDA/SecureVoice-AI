"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  GitBranch,
  Network,
  ShieldCheck,
  BarChart3,
  Webhook,
  Database,
  PhoneCall,
  BrainCircuit,
  FileCheck2,
  Lock,
  Clock,
  HeartPulse,
  ArrowDown,
  Zap,
  CheckCheck,
} from "lucide-react";
import { useApp } from "@/lib/store";
import { KPIS } from "@/lib/data";
import { Reveal, Chip, StatusPill } from "@/components/fx/core";
import { CompareBar } from "@/components/fx/charts";
import { cn } from "@/lib/utils";

const SUBS = [
  { id: "flow", en: "Call Flow", ar: "مسار المكالمة", icon: GitBranch },
  { id: "architecture", en: "Architecture", ar: "البنية", icon: Network },
  { id: "guardrails", en: "Guardrails", ar: "الضمانات", icon: ShieldCheck },
  { id: "metrics", en: "Metrics", ar: "المؤشرات", icon: BarChart3 },
] as const;

type SubId = (typeof SUBS)[number]["id"];

export function Product() {
  const [sub, setSub] = useState<SubId>("flow");
  const { lang } = useApp();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <span className="micro text-primary">Deep dive</span>
            <span className="h-px w-10 bg-line" />
            <span dir="rtl" className="font-arabic text-[13px] text-ink-3">تفاصيل التصميم</span>
          </div>
          <h1 className="font-display mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Inside the intervention machine
          </h1>
        </div>
      </div>

      <div className="mt-8 flex gap-1 overflow-x-auto rounded-2xl border border-line bg-white p-1 sv-scroll">
        {SUBS.map((x) => (
          <button
            key={x.id}
            onClick={() => setSub(x.id)}
            className={cn(
              "relative flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-semibold transition",
              sub === x.id ? "text-white" : "text-ink-2 hover:text-foreground"
            )}
          >
            {sub === x.id && (
              <motion.span
                layoutId="prod-tab"
                className="absolute inset-0 rounded-xl bg-[#0c110e]"
                transition={{ type: "spring", stiffness: 400, damping: 34 }}
              />
            )}
            <x.icon className={cn("relative h-4 w-4", sub === x.id && "text-green-bright")} />
            <span className="relative whitespace-nowrap">{lang === "ar" ? x.ar : x.en}</span>
          </button>
        ))}
      </div>

      <motion.div
        key={sub}
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="mt-8"
      >
        {sub === "flow" && <Flow />}
        {sub === "architecture" && <Architecture />}
        {sub === "guardrails" && <Guardrails />}
        {sub === "metrics" && <Metrics />}
      </motion.div>
    </div>
  );
}

/* ————————————————— CALL FLOW ————————————————— */

const FLOW = [
  {
    n: "1",
    icon: Zap,
    en: "Immediate Outbound Call",
    ar: "اتصال صادر فوري",
    t: "T+0 → 60s SLA",
    body: "Agent calls within 60 seconds of the fraud signal, introducing itself transparently as the bank's AI security assistant in the customer's preferred language.",
    script: "“Hello, this is your bank's AI security assistant calling about recent activity on your account. Is this Ahmed?”",
    rail: "Time-zone check against customer profile before dialing",
  },
  {
    n: "2",
    icon: FileCheck2,
    en: "Identity Verification",
    ar: "التحقق من الهوية",
    t: "challenge 2-of-3",
    body: "Bank-approved challenge flow — recent merchants, amounts, dates. No PINs, no passwords, ever. Questions drawn only from the approved bank in the knowledge base.",
    script: "“Which of these recent transactions do you recognize: AED 45.50 at Carrefour… AED 2,500 at Electronics World?”",
    rail: "System prompt prohibition + KB-scoped questions",
  },
  {
    n: "3",
    icon: BrainCircuit,
    en: "Fraud Confirmation",
    ar: "تأكيد الاحتيال",
    t: "plain-language",
    body: "The agent states the detected activity clearly and asks the one question that matters. Sentiment analysis runs continuously on the response.",
    script: "“We've flagged AED 2,500.00 at Electronics World. Did you authorize this transaction?”",
    rail: "Distress signal → priority human handoff",
  },
  {
    n: "4",
    icon: Lock,
    en: "Protective Action",
    ar: "إجراء الحماية",
    t: "POST /freeze",
    body: "If fraud is confirmed, the agent executes the single pre-approved action — a temporary card freeze — and explains exactly what happens next.",
    script: "“I'll place a temporary freeze on your card now. It's easily reversed once your account is secured.”",
    rail: "Tool scoping: one write action, nothing irreversible",
  },
  {
    n: "5",
    icon: PhoneCall,
    en: "Human Handoff",
    ar: "التسليم لأخصائي",
    t: "warm transfer",
    body: "For irreversible actions or on request, the agent transfers to a fraud specialist — passing verification status, full transcript, and sentiment flags.",
    script: "“I'm connecting you with Sara, a fraud specialist who will help secure your account.”",
    rail: "Context envelope + case creation in CRM",
  },
];

function Flow() {
  return (
    <div className="relative">
      {/* vertical spine */}
      <div className="absolute left-[27px] top-6 bottom-6 hidden w-[2px] bg-gradient-to-b from-green-tint via-primary/40 to-green-tint sm:block" />
      <div className="space-y-4">
        {FLOW.map((f, i) => (
          <Reveal key={f.n} delay={i * 0.05}>
            <div className="relative flex gap-5">
              <div className="relative z-10 hidden sm:block">
                <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/25 bg-white shadow-[0_10px_26px_-16px_rgba(11,122,85,0.5)]">
                  <f.icon className="h-6 w-6 text-primary" strokeWidth={1.6} />
                </span>
              </div>
              <div className="flex-1 rounded-2xl border border-line bg-white p-5 transition hover:border-primary/30 sm:p-6">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="num flex h-7 w-7 items-center justify-center rounded-lg bg-[#0c110e] text-[11px] font-bold text-green-bright sm:hidden">
                    {f.n}
                  </span>
                  <h3 className="font-display text-[16.5px] font-semibold tracking-tight">{f.en}</h3>
                  <span dir="rtl" className="font-arabic text-[12px] text-ink-3">{f.ar}</span>
                  <Chip className="ml-auto">{f.t}</Chip>
                </div>
                <p className="mt-3 max-w-2xl text-[13.5px] leading-relaxed text-ink-2">{f.body}</p>
                <div className="mt-4 grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
                  <div className="rounded-xl bg-[#0c110e] px-4 py-3">
                    <p className="micro !text-[8.5px] text-green-bright">Script</p>
                    <p className="mt-1.5 text-[12.5px] leading-relaxed text-white/85">{f.script}</p>
                  </div>
                  <div className="flex items-start gap-2 rounded-xl bg-green-tint/60 px-4 py-3">
                    <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-deep" />
                    <p className="text-[11.5px] leading-relaxed text-green-deep">{f.rail}</p>
                  </div>
                </div>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </div>
  );
}

/* ————————————————— ARCHITECTURE ————————————————— */

const LAYERS = [
  {
    icon: Webhook,
    en: "Event Ingestion Layer",
    ar: "استيعاب الأحداث",
    body: "Real-time webhook listener for fraud alerts · event queue with priority handling · alert validation and enrichment",
    chip: "POST /api/v1/fraud/alerts",
  },
  {
    icon: BrainCircuit,
    en: "Agent Orchestration Layer",
    ar: "تنسيق الوكيل",
    body: "ElevenLabs Agent Workflow engine · conversation state management · context retention across turns",
    chip: "workflow · state · RAG context",
  },
  {
    icon: Database,
    en: "Integration Layer",
    ar: "التكامل",
    body: "Banking API gateway (authenticated, rate-limited) · transaction history · card freeze execution · case management logging",
    chip: "OAuth 2.0 + mutual TLS",
  },
  {
    icon: PhoneCall,
    en: "Telephony Layer",
    ar: "الهاتف",
    body: "Twilio outbound calling · call quality monitoring · fallback number handling · pre-warmed channels for the 60s SLA",
    chip: "twilio · SIP fallback",
  },
  {
    icon: FileCheck2,
    en: "Analytics & Audit Layer",
    ar: "التحليلات والتدقيق",
    body: "Call recording + bilingual transcription · conversation analytics · compliance reporting · performance monitoring",
    chip: "immutable · AES-256",
  },
];

const APIS = [
  {
    title: "fraud_alert_endpoint",
    lines: [
      "POST /api/v1/fraud/alerts",
      "auth: OAuth 2.0 · client credentials",
      "payload: account_id, customer_id,",
      "  risk_score, transaction_details,",
      "  contact_number, preferred_language",
    ],
  },
  {
    title: "card_freeze_endpoint",
    lines: [
      "POST /api/v1/cards/{card_id}/freeze",
      "auth: OAuth 2.0 · JWT",
      "payload: freeze_type: \"temporary\",",
      "  reason: \"fraud_suspicion\",",
      "  agent_id, verification_method",
    ],
  },
  {
    title: "transaction_history_endpoint",
    lines: [
      "GET /api/v1/accounts/{id}/transactions",
      "auth: OAuth 2.0 · JWT",
      "query: limit=5, type=\"recent\"",
      "used for: verification challenges",
    ],
  },
];

function Architecture() {
  return (
    <div className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
      <div>
        {LAYERS.map((l, i) => (
          <Reveal key={l.en} delay={i * 0.05}>
            <div className="flex items-stretch gap-0">
              <div className="flex-1 rounded-2xl border border-line bg-white p-5 transition hover:border-primary/30">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-green-tint">
                    <l.icon className="h-4.5 w-4.5 h-[18px] w-[18px] text-green-deep" strokeWidth={1.7} />
                  </span>
                  <h3 className="text-[14.5px] font-semibold">{l.en}</h3>
                  <span dir="rtl" className="font-arabic text-[11.5px] text-ink-3">{l.ar}</span>
                  <Chip className="ml-auto">{l.chip}</Chip>
                </div>
                <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink-2">{l.body}</p>
              </div>
            </div>
            {i < LAYERS.length - 1 && (
              <div className="flex justify-center py-1">
                <ArrowDown className="h-4 w-4 text-[#b9c4bb]" />
              </div>
            )}
          </Reveal>
        ))}
      </div>

      <div className="space-y-5">
        <Reveal delay={0.1}>
          <div className="rounded-2xl border border-line bg-white p-5">
            <h3 className="text-[14px] font-semibold">Data flow</h3>
            <p dir="rtl" className="font-arabic mt-1 text-[11px] text-ink-3">تدفق البيانات</p>
            <div className="mt-4 space-y-1.5">
              {[
                "Fraud Detection System",
                "Webhook Listener",
                "Event Queue",
                "Agent Orchestrator",
                "ElevenLabs Agent ↔ Twilio",
                "Core Banking APIs",
                "Case Management",
                "Analytics & Audit",
              ].map((n, i) => (
                <div key={n}>
                  <div
                    className={cn(
                      "rounded-lg border px-3.5 py-2 text-[12px] font-medium",
                      i === 3
                        ? "border-primary/40 bg-green-tint text-green-deep"
                        : "border-line bg-paper text-ink-2"
                    )}
                  >
                    {n}
                  </div>
                  {i < 7 && <div className="sv-dots mx-auto h-[6px] w-[2px]" style={{ backgroundImage: "radial-gradient(circle, #b9c4bb 1.2px, transparent 1.2px)", backgroundSize: "2px 8px" }} />}
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        {APIS.map((a, i) => (
          <Reveal key={a.title} delay={0.14 + i * 0.05}>
            <div className="rounded-2xl border border-line bg-[#0c110e] p-4.5 p-5">
              <p className="num text-[11px] font-semibold text-green-bright">{a.title}</p>
              <pre className="num mt-2 overflow-x-auto text-[10.5px] leading-[1.7] text-white/70">
{a.lines.join("\n")}
              </pre>
            </div>
          </Reveal>
        ))}
      </div>
    </div>
  );
}

/* ————————————————— GUARDRAILS ————————————————— */

const GUARD = [
  {
    icon: Lock,
    en: "No PIN / password requests",
    ar: "لا رموز سرية",
    mech: "System prompt explicitly prohibits it; verification questions drawn only from the pre-approved challenge flow stored in the knowledge base. Zero requests logged across all calls.",
  },
  {
    icon: ShieldCheck,
    en: "Pre-approved actions only",
    ar: "إجراءات معتمدة فقط",
    mech: "Tool scoping restricts the agent to a single write action — the temporary freeze. Irreversible actions require human handoff, enforced by a hard flag in the workflow graph.",
  },
  {
    icon: CheckCheck,
    en: "Language consistency",
    ar: "ثبات اللغة",
    mech: "Agent detects the customer's language in the first response and locks to it for the entire call; dialect selection driven by customer profile (Gulf, MSA, Urdu, Hindi, Filipino, Malayalam).",
  },
  {
    icon: FileCheck2,
    en: "Audit completeness",
    ar: "اكتمال التدقيق",
    mech: "Every call recorded and transcribed; metadata — verification method, actions taken, handoff reason — stored in an immutable log with hash-chained entries, AES-256 at rest.",
  },
  {
    icon: Clock,
    en: "Calling-hour compliance",
    ar: "أوقات الاتصال",
    mech: "Time-zone check against customer profile before initiating any call; calls outside permitted hours are queued automatically for the next permitted window.",
  },
  {
    icon: HeartPulse,
    en: "Vulnerability handling",
    ar: "حماية الفئات الهشة",
    mech: "Sentiment analysis detects distress signals in real time; automatic priority handoff to a human specialist with the vulnerability flag set and full context attached.",
  },
];

function Guardrails() {
  return (
    <div className="overflow-hidden rounded-3xl border border-line bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-paper px-6 py-4">
        <div>
          <h3 className="text-[15px] font-semibold">The six guardrails</h3>
          <p className="text-[12px] text-ink-3">Enforced in architecture, not in policy documents</p>
        </div>
        <StatusPill tone="green">CBUAE-aligned · 0 violations / 30 days</StatusPill>
      </div>
      <div className="divide-y divide-line">
        {GUARD.map((g, i) => (
          <Reveal key={g.en} delay={i * 0.04}>
            <div className="grid gap-4 px-6 py-5 transition hover:bg-paper/60 lg:grid-cols-[300px_1fr] lg:gap-8">
              <div className="flex items-start gap-3.5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-green-tint">
                  <g.icon className="h-[18px] w-[18px] text-green-deep" strokeWidth={1.7} />
                </span>
                <div>
                  <p className="text-[14px] font-semibold leading-snug">{g.en}</p>
                  <p dir="rtl" className="font-arabic mt-0.5 text-[11.5px] text-ink-3">{g.ar}</p>
                  <p className="num mt-1.5 text-[10px] text-ink-3">GUARDRAIL {String(i + 1).padStart(2, "0")}</p>
                </div>
              </div>
              <p className="text-[13.5px] leading-relaxed text-ink-2">{g.mech}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </div>
  );
}

/* ————————————————— METRICS ————————————————— */

function Metrics() {
  const maxes: Record<string, number> = { prevention: 100, delay: 2400, verify: 100, csat: 5 };
  const notes: Record<string, string> = {
    prevention: "Measured as share of confirmed-fraud attempts blocked after detection. Automation lifts the ceiling that human callback speed imposes.",
    delay: "From fraud signal to live customer contact. The 25× compression is where the prevented losses come from — fraudsters lose their window.",
    verify: "Share of calls completing identity verification without falling back to manual channels. Multilingual voices drive this up.",
    csat: "Post-call survey. Transparent AI introduction + one-word human escape protects the score even when the news is bad.",
  };
  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-2">
        {KPIS.map((k, i) => (
          <Reveal key={k.key} delay={i * 0.05}>
            <div className="h-full rounded-2xl border border-line bg-white p-6">
              <div className="flex items-baseline justify-between">
                <h3 className="text-[14.5px] font-semibold">{k.en}</h3>
                <span dir="rtl" className="font-arabic text-[11.5px] text-ink-3">{k.ar}</span>
              </div>
              <div className="mt-5">
                <CompareBar
                  baseline={k.baseline}
                  current={k.current}
                  target={k.target}
                  max={maxes[k.key]}
                  good={k.good}
                  unit={k.unit}
                  delay={i * 0.08}
                />
              </div>
              <p className="mt-4 border-t border-line pt-3.5 text-[12px] leading-relaxed text-ink-2">
                {notes[k.key]}
              </p>
            </div>
          </Reveal>
        ))}
      </div>
      <Reveal delay={0.15}>
        <div className="rounded-2xl bg-[#0c110e] p-6 text-white sm:p-8">
          <p className="micro text-green-bright">Measurement plan · خطة القياس</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            {[
              { t: "30 days", d: "Baseline re-measure · false-positive calibration · dialect tuning cycle 1" },
              { t: "90 days", d: "Full KPI read vs. baseline · CSAT longitudinal study · compliance audit dry-run" },
              { t: "12 months", d: "Target confirmation · loss-run report vs. AED 340M baseline · board review pack" },
            ].map((m) => (
              <div key={m.t} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="num text-[13px] font-bold text-green-bright">{m.t}</p>
                <p className="mt-2 text-[12px] leading-relaxed text-white/65">{m.d}</p>
              </div>
            ))}
          </div>
        </div>
      </Reveal>
    </div>
  );
}
