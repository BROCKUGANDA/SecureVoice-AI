"use client";

import { motion } from "framer-motion";
import {
  PhoneCall,
  HandCoins,
  FileCheck2,
  HeartHandshake,
  Globe2,
  Play,
  Check,
  X,
  ArrowRight,
  UserRound,
} from "lucide-react";
import { useApp, t } from "@/lib/store";
import { Reveal } from "@/components/fx/core";
import { cn } from "@/lib/utils";

/* ————————————————— data — the five briefs ————————————————— */

type Status = { label: string; sub: string; live?: boolean };

const USE_CASES: {
  id: string;
  icon: typeof PhoneCall;
  en: string;
  ar: string;
  pitch: string;
  agent: string[];
  inScope: string[];
  outScope: string[];
  personas: string[];
  status: Status;
}[] = [
  {
    id: "fraud",
    icon: PhoneCall,
    en: "Real-Time Fraud Intervention",
    ar: "التدخل الفوري في الاحتيال",
    pitch:
      "When a bank detects a suspicious login, a stolen card or an anomalous payment, outbound contact is often too slow to change the outcome. The agent calls the customer the moment a risk signal is raised, in their language — identifies itself as the institution's AI, verifies through the bank's approved challenge flow without requesting a PIN or password, executes a pre-approved protective step such as a temporary card freeze, and hands to a human agent for anything irreversible.",
    agent: [
      "Outbound call within 60 seconds of the risk signal — 61s signal-to-freeze in this demo",
      "Identity verified by transaction challenge — PINs, passwords and OTPs are structurally impossible to request",
      "Pre-approved protective actions only: temporary card freeze, transfer hold, payee block",
      "Warm handoff to the human fraud desk with full bilingual context",
    ],
    inScope: [
      "Time-critical calls triggered by a live risk signal",
      "Pre-approved protective actions from the signed policy",
      "Verification through the bank's approved challenge flow",
    ],
    outScope: [
      "Irreversible account actions — decided by the bank's human fraud team",
      "Routine reminders and scheduled calls",
    ],
    personas: ["Head of Fraud, retail bank", "Head of Cards, retail bank"],
    status: { label: "Shipped", sub: "Live in this platform — run the demo", live: true },
  },
  {
    id: "collections",
    icon: HandCoins,
    en: "Governed Collections & Early Arrears Resolution",
    ar: "التحصيل الخاضع للحوكمة",
    pitch:
      "Missed loan payments, insurance renewals, expiring ID documents and payment-plan check-ins are commonly outsourced to third-party agencies, which creates conduct risk under CBUAE consumer protection rules. And contact in the customer's own language is not consistently available across a largely expatriate borrower base. This voice channel follows approved treatment strategies without deviation, operates in the languages that base speaks — from Emirati Arabic to Urdu — and records every call.",
    agent: [
      "Executes the approved treatment strategy exactly — no deviation, no improvisation",
      "Four languages live today (EN · AR-Gulf · HI · UR) across an expatriate borrower base",
      "Permitted calling hours enforced by configuration; every opt-out honoured and logged",
      "Every call recorded with an immutable audit trail",
    ],
    inScope: [
      "Scheduled, routine calls about an outstanding or expiring obligation",
      "Approved wording only, within permitted calling hours",
      "No pressure — every opt-out honoured",
    ],
    outScope: [
      "Disputes, hardship claims and vulnerability signals — passed to a human agent",
    ],
    personas: ["Head of Collections & Recoveries", "Chief Distribution Officer, insurer", "Head of Compliance Operations"],
    status: { label: "Pilot pipeline", sub: "Arabic, Hindi & Urdu voices shipping today — same guardrail engine" },
  },
  {
    id: "preauth",
    icon: FileCheck2,
    en: "Provider Pre-Authorisation Intake & Triage",
    ar: "استقبال التراخيص الطبية وفرزها",
    pitch:
      "Health cover is mandatory across Dubai. Business-to-business callers can hold for extended periods on a pre-authorisation while a patient waits — although a large share of those requests are rule-based decisions. The agent answers the business caller — a clinic, a broker, or a supplier checking onboarding — takes the full request, checks it against the applicable rules, and prepares the decision for a qualified employee to approve, so the caller receives an answer on the same call. A later phase allows the clinic's agent to call the insurer's agent directly, subject to separate written authorisation.",
    agent: [
      "Takes the complete pre-auth request over one call — no hold queues for rule-based cases",
      "Checks the request against written rules and prepares the recommendation",
      "A qualified employee approves every authorisation or denial before it is issued",
      "Caller hears the decision on the same call",
    ],
    inScope: [
      "Business-to-business calls where the answer follows from written rules",
      "Agent prepares the recommendation; humans approve the outcome",
    ],
    outScope: [
      "Agent-to-agent dialling — removes the human from the call and requires its own written sign-off",
    ],
    personas: ["Chief Claims Officer, health insurer", "Head of Broker Distribution", "Head of SME Banking"],
    status: { label: "Reference build", sub: "Same guardrail engine, B2B intake flow" },
  },
  {
    id: "hard-moments",
    icon: HeartHandshake,
    en: "Support Through Difficult Moments",
    ar: "الدعم في اللحظات الصعبة",
    pitch:
      "Bereavement, serious illness and job loss trigger account freezes, succession requirements and claims processes. These are typically handled by separate departments, requiring the customer to repeat their circumstances at each step. One agent handles the case end to end: the customer explains once, the agent retains the context, tracks required documents and status, provides updates over the duration of the case, and refers any legal or financial question to a qualified person.",
    agent: [
      "The customer explains once — context carries across every later call",
      "Document checklist and case status tracked and proactively updated",
      "States the institution's published process and document requirements as fact",
      "Legal and financial advice questions are handed to a qualified person",
    ],
    inScope: [
      "Long-running, sensitive cases handled across multiple calls",
      "Process information stated from the institution's published facts",
    ],
    outScope: [
      "Legal or financial advice — always routed to a qualified person",
    ],
    personas: ["Head of Customer Experience, retail & private bank", "Chief Claims Officer, life insurer"],
    status: { label: "Reference build", sub: "Case-state engine, multi-call memory" },
  },
  {
    id: "servicing",
    icon: Globe2,
    en: "Multilingual Everyday Servicing",
    ar: "خدمة يومية متعددة اللغات",
    pitch:
      "The UAE is one of the world's largest outbound remittance markets. Retail phone channels typically operate in English and Arabic, which leaves a substantial share of customers unable to obtain a factual answer to a routine question. This line answers everyday queries in the language the caller uses: the posted remittance rate, the status of a transfer, or the entitlements attached to a salary card.",
    agent: [
      "Answers in the caller's language — four live today, selected per customer profile",
      "Factual answers only, sourced from published information",
      "Posted remittance rates, transfer status, salary-card entitlements",
      "One call, one answer — no queue, no language surcharge",
    ],
    inScope: [
      "Factual questions answered in a single call from published information",
    ],
    outScope: [
      "Product recommendations or financial decisions — advice requests and complaints route to a human agent",
    ],
    personas: ["Chief Operating Officer, exchange house", "Chief Customer Officer, insurer", "Head of Retail Banking"],
    status: { label: "Pilot pipeline", sub: "All four voices live in the demo today" },
  },
];

/* ————————————————— page ————————————————— */

export function UseCases() {
  const { lang, launchDemo } = useApp();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
      {/* header */}
      <div className="max-w-2xl">
        <div className="flex items-center gap-3">
          <span className="micro text-primary">Use cases</span>
          <span className="h-px w-10 bg-line" />
          <span dir="rtl" className="font-arabic text-[13px] text-ink-3">حالات الاستخدام</span>
        </div>
        <h1 className="font-display mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
          {t("One platform, five regulated conversations", "منصة واحدة، خمس محادثات منظّمة", lang)}
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          {t(
            "Every deployment shares the same spine: the customer's own language, a guardrail policy the institution signs, protective actions that are pre-approved, and a human in the loop for anything the agent must not decide alone. Only the conversation changes.",
            "كل نشر يشترك في الأساس نفسه: لغة العميل، وسياسة ضمانات يوقّعها المؤسسة، وإجراءات محددة سلفاً، وبشر يعتمد كل ما لا يقرره الوكيل. يتغير الحوار فقط.",
            lang
          )}
        </p>
      </div>

      {/* cards */}
      <div className="mt-10 space-y-6">
        {USE_CASES.map((u, i) => (
          <Reveal key={u.id} delay={Math.min(i * 0.04, 0.12)}>
            <article className="overflow-hidden rounded-3xl border border-line bg-white">
              {/* head */}
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line/70 px-6 py-5 sm:px-8">
                <div className="flex items-start gap-4">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-green-tint">
                    <u.icon className="h-5 w-5 text-primary" strokeWidth={1.7} />
                  </span>
                  <div>
                    <div className="flex items-center gap-2.5">
                      <span className="font-mono text-[11px] font-bold tracking-widest text-ink-3">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <h2 className="font-display text-[18px] font-semibold tracking-tight">
                        {lang === "ar" ? u.ar : u.en}
                      </h2>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "rounded-full px-2.5 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-wide",
                          u.status.live ? "bg-primary text-white" : "bg-green-tint text-primary"
                        )}
                      >
                        {u.status.label}
                      </span>
                      <span className="text-[12px] text-ink-3">{u.status.sub}</span>
                    </div>
                  </div>
                </div>
                {u.status.live && (
                  <button
                    onClick={launchDemo}
                    className="group flex shrink-0 items-center gap-2 rounded-full bg-primary px-4 py-2 text-[12.5px] font-semibold text-white transition hover:bg-green-deep"
                  >
                    <Play className="h-3.5 w-3.5" />
                    {t("Run the live demo", "شغّل العرض الحي", lang)}
                  </button>
                )}
              </div>

              {/* body */}
              <div className="grid gap-8 px-6 py-6 sm:px-8 lg:grid-cols-[1.4fr_1fr]">
                <div>
                  <p className="text-[13.5px] leading-relaxed text-ink-2">{u.pitch}</p>
                  <div className="micro mt-5 text-[9px] text-ink-3">WHAT THE AGENT DOES</div>
                  <ul className="mt-2.5 space-y-2">
                    {u.agent.map((a) => (
                      <li key={a} className="flex gap-2.5 text-[13px] leading-relaxed text-ink-2">
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" strokeWidth={2.4} />
                        {a}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="space-y-4">
                  {/* scope */}
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                    <div className="rounded-2xl border border-line bg-paper p-4">
                      <div className="micro text-[9px] text-primary">IN SCOPE</div>
                      <ul className="mt-2 space-y-1.5">
                        {u.inScope.map((s) => (
                          <li key={s} className="flex gap-2 text-[12px] leading-relaxed text-ink-2">
                            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-primary" />
                            {s}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="rounded-2xl border border-dashed border-line bg-white p-4">
                      <div className="micro flex items-center gap-1 text-[9px] text-ink-3">
                        <X className="h-3 w-3 text-red-500" /> OUT OF SCOPE
                      </div>
                      <ul className="mt-2 space-y-1.5">
                        {u.outScope.map((s) => (
                          <li key={s} className="flex gap-2 text-[12px] leading-relaxed text-ink-2">
                            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-red-400" />
                            {s}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  {/* personas */}
                  <div className="rounded-2xl border border-line bg-paper p-4">
                    <div className="micro flex items-center gap-1.5 text-[9px] text-ink-3">
                      <UserRound className="h-3 w-3" /> BUILT FOR
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {u.personas.map((p) => (
                        <span key={p} className="rounded-full border border-line bg-white px-2.5 py-1 text-[11px] font-medium text-ink-2">
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </article>
          </Reveal>
        ))}
      </div>

      {/* closing band */}
      <Reveal delay={0.1}>
        <div className="mt-10 flex flex-col items-center justify-between gap-4 rounded-3xl bg-[#0c110e] px-8 py-7 text-white sm:flex-row">
          <div>
            <div className="font-display text-[17px] font-semibold tracking-tight">
              {t("Hear the platform speak", "استمع إلى المنصة تتحدث", lang)}
            </div>
            <p className="mt-1 text-[13px] text-white/60">
              {t(
                "Four languages, three triggerable fraud cases, one guardrailed engine — 61 seconds, signal to freeze.",
                "أربع لغات، ثلاث حالات احتيال قابلة للتفعيل، محرك واحد خاضع للضمانات — ٦١ ثانية من الإشارة إلى التجميد.",
                lang
              )}
            </p>
          </div>
          <div className="flex shrink-0 gap-2.5">
            <button
              onClick={launchDemo}
              className="flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-green-deep"
            >
              <Play className="h-4 w-4" />
              {t("Launch live demo", "ابدأ العرض الحي", lang)}
            </button>
            <button
              onClick={() => useApp.getState().setView("docs")}
              className="group flex items-center gap-2 rounded-full border border-white/20 px-5 py-2.5 text-[13px] font-semibold text-white/90 transition hover:bg-white/10"
            >
              {t("Read the docs", "اقرأ التوثيق", lang)}
              <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
            </button>
          </div>
        </div>
      </Reveal>
    </div>
  );
}
