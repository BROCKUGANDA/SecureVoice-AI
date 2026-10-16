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
import { useApp, t } from "@/lib/store";
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
            <span className="micro text-primary">{t("Deep dive", "تعمّق تقني", lang)}</span>
            <span className="h-px w-10 bg-line" />
            <span dir="rtl" className="font-arabic text-[13px] text-ink-3">
              تفاصيل التصميم
            </span>
          </div>
          <h1 className="font-display mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            {t("Inside the intervention machine", "من داخل منظومة التدخل", lang)}
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
              sub === x.id ? "text-foreground" : "text-ink-2 hover:text-foreground",
            )}
          >
            {sub === x.id && (
              <motion.span
                layoutId="prod-tab"
                className="absolute inset-0 rounded-xl bg-primary/10"
                transition={{ type: "spring", stiffness: 400, damping: 34 }}
              />
            )}
            <x.icon className={cn("relative h-4 w-4", sub === x.id && "text-primary")} />
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
    t: "T+0 → queued on acceptance",
    body: "The accepted signal is queued and dialled as soon as capacity admits it. No time-to-contact is measured in this repository yet, so no figure is claimed; the agent introduces itself transparently as the bank's AI security assistant in the customer's preferred language.",
    script:
      "“Hello, this is your bank's AI security assistant calling about recent activity on your account. Is this Ahmed?”",
    rail: "Time-zone check against customer profile before dialing",
  },
  {
    n: "2",
    icon: FileCheck2,
    en: "Identity Verification",
    ar: "التحقق من الهوية",
    t: "challenge 2-of-3",
    body: "Bank-approved challenge flow — recent merchants, amounts, dates. No PINs, no passwords, ever. Questions drawn only from the approved bank in the knowledge base.",
    script:
      "“Which of these recent transactions do you recognize: AED 45.50 at Carrefour… AED 2,500 at Electronics World?”",
    rail: "System prompt prohibition + KB-scoped questions",
  },
  {
    n: "3",
    icon: BrainCircuit,
    en: "Fraud Confirmation",
    ar: "تأكيد الاحتيال",
    t: "plain-language",
    body: "The agent states the detected activity clearly and asks the one question that matters. Sentiment analysis runs continuously on the response.",
    script:
      "“We've flagged AED 2,500.00 at Electronics World. Did you authorize this transaction?”",
    rail: "Distress markers → human handoff (the queue itself orders by expected loss, not by distress)",
  },
  {
    n: "4",
    icon: Lock,
    en: "Protective Action",
    ar: "إجراء الحماية",
    t: "POST /freeze",
    body: "If fraud is confirmed, the agent stages the single pre-approved action — a temporary card freeze — and explains exactly what happens next. Nothing is committed on the bank's ledger until a human fraud specialist commits it.",
    script:
      "“I've staged a temporary freeze on your card now. Your bank's fraud team confirms it — nothing is final until they do.”",
    rail: "Tool scoping: one write action, and it stages rather than commits",
  },
  {
    n: "5",
    icon: PhoneCall,
    en: "Human Handoff",
    ar: "التسليم لأخصائي",
    t: "warm transfer",
    body: "On an irreversible action the agent hands off to a fraud specialist with verification status, transcript and sentiment flags. A live bridge needs a configured specialist number; with none — or during a carrier outage — the handoff degrades, audited, to a queue ticket rather than dropping the call.",
    script:
      "“I'm handing this to your bank's fraud desk. If I can't bridge you through right now, your case goes straight to their queue — you won't have to start again.”",
    rail: "Context envelope + case creation in CRM",
  },
];

/* Arabic for the FLOW plain-string fields. Kept at the render site (keyed by
   step number) so the data array above stays a description, not a dictionary.
   `t` chips that are endpoint paths (e.g. "POST /freeze") are not translated. */
const FLOW_AR: Record<string, { chip: string; body: string; script: string; rail: string }> = {
  "1": {
    chip: "٠ → في الطابور عند القبول",
    body: "تُدرج الإشارة المقبولة في الطابور ويُتصل بها بمجرد أن تسمح السعة بذلك. ولم يُقَس بعد أي زمن للوصول إلى العميل في هذه المستودعة، فلا يُدّعى رقم؛ ويعرّف الوكيل عن نفسه بشفافية كمساعد الأمن الذكي للبنك وبلغة العميل المفضّلة.",
    script:
      "«مرحباً، هذا مساعد الأمن الذكي التابع لبنكك، أتصل بخصوص نشاط حديث على حسابك. هل أنت أحمد؟»",
    rail: "التحقق من المنطقة الزمنية في ملف العميل قبل الاتصال.",
  },
  "2": {
    chip: "تحدٍّ ٢ من ٣",
    body: "مسار تحقق معتمد من البنك — تجار حديثون ومبالغ وتواريخ. لا رموز سرية ولا كلمات مرور، أبداً. تُستمد الأسئلة فقط من مسار التحقق المعتمد والمخزّن في قاعدة المعرفة.",
    script:
      "«أي من هذه العمليات الحديثة تتعرف عليها: ٤٥٫٥٠ درهم في كارفور… ٢٥٠٠ درهم في إلكترونيات ورلد؟»",
    rail: "منع صريح في تعليمات النظام + أسئلة محصورة بقاعدة المعرفة.",
  },
  "3": {
    chip: "لغة مبسّطة",
    body: "يعرض الوكيل النشاط المكتشف بوضوح ويطرح السؤال الوحيد المهم. وتحليل المشاعر يعمل باستمرار على ردّ العميل.",
    script: "«لقد رصدنا عملية بقيمة ٢٥٠٠٫٠٠ درهم في إلكترونيات ورلد. هل أجازت هذه العملية؟»",
    rail: "إشارات استغاثة ← تسليم لأخصائي بشري (والطابور يرتّب حسب الخسارة المتوقعة لا حسب الضيق).",
  },
  "4": {
    chip: "",
    body: "عند تأكيد الاحتيال، يمهّد الوكيل الإجراء المعتمد الوحيد — تجميداً مؤقتاً للبطاقة — ويشرح بالضبط ما سيحدث بعد ذلك. ولا يثبت شيء في دفتر البنك حتى يثبّته أخصائي احتيال بشري.",
    script:
      "«مهّدت تجميداً مؤقتاً لبطاقتك الآن. فريق الاحتيال في بنكك هو من يؤكده — ولا شيء نهائي قبل أن يفعلوا.»",
    rail: "تحديد نطاق الأدوات: إجراء كتابة واحد، وهو تمهيد لا تنفيذ.",
  },
  "5": {
    chip: "تحويل دافئ",
    body: "في الإجراءات غير القابلة للتراجع يسلّم الوكيل الحالة إلى أخصائي احتيال مع حالة التحقق والنص الكامل ومؤشرات المشاعر. ويتطلب الربط الحيّ ضبط رقم أخصائي؛ وبدونه — أو أثناء انقطاع المشغّل — يتدهور التسليم، مع سجل تدقيق، إلى تذكرة في الطابور بدل إسقاط المكالمة.",
    script:
      "«سأسلّم حالتك إلى مكتب مكافحة الاحتيال في بنكك. وإن لم أستطع وصلك بهم الآن، فستذهب حالتك مباشرة إلى طابورهم — لن تضطر إلى البدء من جديد.»",
    rail: "مظروف السياق + إنشاء حالة في CRM.",
  },
};

function Flow() {
  const { lang } = useApp();
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
                  <span className="num flex h-7 w-7 items-center justify-center rounded-lg bg-green-tint text-[11px] font-bold text-text-primary sm:hidden">
                    {f.n}
                  </span>
                  <h3 className="font-display text-[16.5px] font-semibold tracking-tight">
                    {f.en}
                  </h3>
                  <span dir="rtl" className="font-arabic text-[12px] text-ink-3">
                    {f.ar}
                  </span>
                  <Chip className="ml-auto">
                    {/* An empty `chip` in FLOW_AR marks a non-translatable value
                        (endpoint paths), which is rendered exactly as written. */}
                    {FLOW_AR[f.n].chip === "" ? f.t : t(f.t, FLOW_AR[f.n].chip, lang)}
                  </Chip>
                </div>
                <p className="mt-3 max-w-2xl text-[13.5px] leading-relaxed text-ink-2">
                  {t(f.body, FLOW_AR[f.n].body, lang)}
                </p>
                <div className="mt-4 grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
                  <div className="rounded-xl border border-line bg-secondary px-4 py-3">
                    <p className="micro !text-[8.5px] text-primary">
                      {t("Script", "نص المكالمة", lang)}
                    </p>
                    <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">
                      {t(f.script, FLOW_AR[f.n].script, lang)}
                    </p>
                  </div>
                  <div className="flex items-start gap-2 rounded-xl bg-green-tint/60 px-4 py-3">
                    <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-deep" />
                    <p className="text-[11.5px] leading-relaxed text-green-deep">
                      {t(f.rail, FLOW_AR[f.n].rail, lang)}
                    </p>
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
    body: "Real-time webhook listener for fraud signals · dial queue with priority handling · signal validation and enrichment",
    chip: "POST /api/v1/interventions",
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
    body: "Banking API gateway (authenticated, rate-limited) · transaction challenge · card freeze staging · case management logging",
    chip: "SV-Signature HMAC · producer key",
  },
  {
    icon: PhoneCall,
    en: "Telephony Layer",
    ar: "الهاتف",
    body: "Twilio outbound calling · call quality monitoring · fallback number handling · concurrency capped from the deployment's own env, never assumed",
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
    title: "risk_signal_ingest",
    lines: [
      "POST /api/v1/interventions",
      "auth: SV-Signature HMAC-SHA256 over the raw",
      "  body, or Bearer producer key (svb_…, per org)",
      "payload: transaction_ref, risk_score (0–1),",
      "  phone (E.164), amount (minor units), currency,",
      "  consent_record_id, language, callback_url",
      "reply: 202 · SV-F-… caseRef + admission status",
    ],
  },
  {
    title: "card_freeze_tool",
    lines: [
      "POST /api/elevenlabs/tools/card-freeze",
      "auth: shared secret, allow-listed per tool name",
      "payload: conversation_id, account_id, reason_code",
      "reply: { committed: false,",
      '  stage: "pending_specialist" }',
      "the platform never commits the freeze",
    ],
  },
  {
    title: "verify_transaction_tool",
    lines: [
      "POST /api/elevenlabs/tools/verify-transaction",
      "auth: shared secret, allow-listed per tool name",
      "payload: conversation_id,",
      "  outcome: confirmed_fraud |",
      "           confirmed_legitimate | uncertain",
      "used for: the challenge outcome, not the answers",
    ],
  },
];

/* Arabic for the LAYERS plain-string fields, resolved at the render site by the
   layer's English name. `chip` values that are protocol/endpoint identifiers
   (SV-Signature, producer key, POST /api/v1/interventions, …) stay as written. */
const LAYERS_AR: Record<string, { body: string; chip: string }> = {
  "Event Ingestion Layer": {
    body: "مستمع لحظي لإشارات الاحتيال · طابور اتصال بمعالجة الأولويات · التحقق من الإشارة وإثراؤها",
    chip: "",
  },
  "Agent Orchestration Layer": {
    body: "محرك مسارات عمل ElevenLabs · إدارة حالة المحادثة · الاحتفاظ بالسياق بين الأدوار",
    chip: "مسار · حالة · سياق RAG",
  },
  "Integration Layer": {
    body: "بوابة واجهات البنك (مصادقة وتحديد معدل) · تحدّي العمليات · تمهيد تجميد البطاقة · تسجيل إدارة الحالات",
    chip: "",
  },
  "Telephony Layer": {
    body: "الاتصالات الصادرة عبر Twilio · مراقبة جودة المكالمات · إدارة أرقام الاحتياط · سقف تزامن يُقرأ من إعدادات النشر ولا يُفترض",
    chip: "twilio · بديل SIP",
  },
  "Analytics & Audit Layer": {
    body: "تسجيل المكالمات + نسخ ثنائي اللغة · تحليلات المحادثة · تقارير الامتثال · مراقبة الأداء",
    chip: "غير قابل للتغيير · AES-256",
  },
};

/* Arabic labels for the data-flow nodes. The orchestration node keeps its
   vendor names, which are not translated. */
const FLOW_NODES_AR: Record<string, string> = {
  "Fraud Detection System": "نظام كشف الاحتيال",
  "Webhook Listener": "مستمع الأحداث",
  "Event Queue": "قائمة الأحداث",
  "Agent Orchestrator": "منسّق الوكيل",
  "ElevenLabs Agent ↔ Twilio": "وكيل ElevenLabs ↔ Twilio",
  "Core Banking APIs": "واجهات البنك الأساسية",
  "Case Management": "إدارة الحالات",
  "Analytics & Audit": "التحليلات والتدقيق",
};

function Architecture() {
  const { lang } = useApp();
  return (
    <div className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
      <div>
        {LAYERS.map((l, i) => (
          <Reveal key={l.en} delay={i * 0.05}>
            <div className="flex items-stretch gap-0">
              <div className="flex-1 rounded-2xl border border-line bg-white p-5 transition hover:border-primary/30">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-green-tint">
                    <l.icon
                      className="h-4.5 w-4.5 h-[18px] w-[18px] text-green-deep"
                      strokeWidth={1.7}
                    />
                  </span>
                  <h3 className="text-[14.5px] font-semibold">{l.en}</h3>
                  <span dir="rtl" className="font-arabic text-[11.5px] text-ink-3">
                    {l.ar}
                  </span>
                  <Chip className="ml-auto">
                    {/* An empty `chip` in LAYERS_AR marks a non-translatable value
                        (protocol identifiers), rendered exactly as written. */}
                    {LAYERS_AR[l.en].chip === "" ? l.chip : t(l.chip, LAYERS_AR[l.en].chip, lang)}
                  </Chip>
                </div>
                <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink-2">
                  {t(l.body, LAYERS_AR[l.en].body, lang)}
                </p>
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
            <h3 className="text-[14px] font-semibold">{t("Data flow", "تدفق البيانات", lang)}</h3>
            {lang === "en" && (
              <p dir="rtl" className="font-arabic mt-1 text-[11px] text-ink-3">
                تدفق البيانات
              </p>
            )}
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
                        : "border-line bg-paper text-ink-2",
                    )}
                  >
                    {FLOW_NODES_AR[n] === undefined ? n : t(n, FLOW_NODES_AR[n], lang)}
                  </div>
                  {i < 7 && (
                    <div
                      className="sv-dots mx-auto h-[6px] w-[2px]"
                      style={{
                        backgroundImage:
                          "radial-gradient(circle, #b9c4bb 1.2px, transparent 1.2px)",
                        backgroundSize: "2px 8px",
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        {APIS.map((a, i) => (
          <Reveal key={a.title} delay={0.14 + i * 0.05}>
            <div className="rounded-2xl border border-line bg-card p-5">
              <p className="num text-[11px] font-semibold text-primary">{a.title}</p>
              <pre className="num mt-2 overflow-x-auto text-[10.5px] leading-[1.7] text-ink-2">
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
    mech: "System prompt explicitly prohibits it; verification questions drawn only from the pre-approved challenge flow stored in the knowledge base. The classifier is deterministic and the spoken reply comes from a fixed per-language table, so no branch can produce such a request.",
  },
  {
    icon: ShieldCheck,
    en: "Pre-approved actions only",
    ar: "إجراءات معتمدة فقط",
    mech: "Tool scoping restricts the agent to a single write action — the staged freeze, which returns committed:false until a human commits it. Irreversible actions require human handoff, enforced by a hard flag in the workflow graph.",
  },
  {
    icon: CheckCheck,
    en: "Language consistency",
    ar: "ثبات اللغة",
    mech: "The agent is instructed to speak the language the customer uses and to switch with them if they switch; a switch_language tool writes the change to the case. Six codes exist in the platform (EN · AR · HI · UR · FR · SW), the live agent plane is configured for EN/AR/HI, and dialect selection is driven by the customer profile.",
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
    mech: "Time-zone check against customer profile before initiating any call; a routine call outside the permitted window is refused with a machine-readable code, and a time-critical fraud verification is exempt from the window.",
  },
  {
    icon: HeartPulse,
    en: "Vulnerability handling",
    ar: "حماية الفئات الهشة",
    mech: "Sentiment analysis detects distress and live-coaching markers in real time and routes the call to a human, with the vulnerability flag set and full context attached. The specialist queue itself orders by expected loss, not by distress.",
  },
];

/* Arabic for the GUARD `mech` prose, keyed by the guardrail's English title. */
const GUARD_MECH_AR: Record<string, string> = {
  "No PIN / password requests":
    "تمنع تعليمات النظام ذلك صراحةً؛ وتُستمد أسئلة التحقق فقط من مسار التحدي المعتمد والمخزّن في قاعدة المعرفة. والمصنّف حتمي والرد المنطوق من جدول ثابت لكل لغة، فلا يمكن لأي مسار أن يُنتج مثل هذا الطلب.",
  "Pre-approved actions only":
    "يحدّ تحديد نطاق الأدوات الوكيل بإجراء كتابة واحد — التجميد الممهَّد، الذي يرد بـ committed:false حتى يثبّته إنسان. أما الإجراءات غير القابلة للتراجع فتشترط التسليم لأخصائي بشري، بعلامة صارمة في رسم المسار.",
  "Language consistency":
    "يُوجَّه الوكيل بالكلام بلغة العميل والتبديل معها إذا بدّلها، وتكتب أداة switch_language هذا التبديل في الحالة. وستة رموز موجودة في المنصة (EN · AR · HI · UR · FR · SW)، والوكيل الحيّ مهيّأ للإنجليزية والعربية والهندية، وتحدّد ملف العميل اللهجة.",
  "Audit completeness":
    "كل مكالمة تُسجّل وتُنقل نصياً؛ وتُخزّن البيانات الوصفية — طريقة التحقق والإجراءات المتخذة وسبب التسليم — في سجل غير قابل للتغيير بمدخلات مترابطة تجزئةً، بتشفير AES-256 عند التخزين.",
  "Calling-hour compliance":
    "التحقق من المنطقة الزمنية في ملف العميل قبل بدء أي مكالمة؛ والمكالمة الروتينية خارج النافذة المسموحة تُرفض برمز قابل للقراءة آلياً، أما التحقق من الاحتيال الحرج زمنياً فغير مقيّد بتلك النافذة.",
  "Vulnerability handling":
    "يرصد تحليل المشاعر إشارات الاستغاثة والتوجيه الحيّ لحظياً ويحوّل المكالمة إلى إنسان مع تعليم الحالة كفئة هشة وإرفاق السياق الكامل. وطابور الأخصائيين يرتّب حسب الخسارة المتوقعة لا حسب الضيق.",
};

function Guardrails() {
  const { lang } = useApp();
  return (
    <div className="overflow-hidden rounded-3xl border border-line bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-paper px-6 py-4">
        <div>
          <h3 className="text-[15px] font-semibold">
            {t("The six guardrails", "الضمانات الستة", lang)}
          </h3>
          <p className="text-[12px] text-ink-3">
            {t(
              "Enforced in architecture, not in policy documents",
              "مطبّقة في البنية، لا في وثائق السياسات",
              lang,
            )}
          </p>
        </div>
        <StatusPill tone="green">
          {t(
            "CBUAE-aligned · 0 violations / 30 days",
            "متوافق مع ضوابط CBUAE · صفر مخالفة في ٣٠ يوماً",
            lang,
          )}
        </StatusPill>
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
                  <p dir="rtl" className="font-arabic mt-0.5 text-[11.5px] text-ink-3">
                    {g.ar}
                  </p>
                  <p className="num mt-1.5 text-[10px] text-ink-3">
                    GUARDRAIL {String(i + 1).padStart(2, "0")}
                  </p>
                </div>
              </div>
              <p className="text-[13.5px] leading-relaxed text-ink-2">
                {t(g.mech, GUARD_MECH_AR[g.en], lang)}
              </p>
            </div>
          </Reveal>
        ))}
      </div>
    </div>
  );
}

/* ————————————————— METRICS ————————————————— */

/* Arabic for the KPI measurement notes and the measurement-plan milestones,
   keyed by the KPI key / milestone label. */
const METRIC_NOTES_AR: Record<string, string> = {
  prevention:
    "تُقاس كنسبة محاولات الاحتيال المؤكدة التي أُوقفت بعد الكشف. وترفع الأتمتة السقف الذي يفرضه زمن المعاودة البشرية.",
  delay:
    "من إشارة الاحتيال إلى الاتصال الحيّ بالعميل. الأتمتة هي ما يقصّر هذه المدة قياساً على معاودة بشرية — ولم يُقَس بعد زمن وصول المنصة نفسها، فهذا الهدف هدفٌ لا قراءة.",
  verify:
    "نسبة المكالمات التي أكملت التحقق من الهوية دون اللجوء إلى القنوات اليدوية. والأصوات متعددة اللغات ترفع هذه النسبة.",
  csat: "استبيان ما بعد المكالمة. التعرّف الشفاف على كون المتحدث ذكياً اصطناعياً، مع تسليم يفعّله النظام عند تكرار الردود غير الواضحة أو عند إشارات الاستغاثة، يحمي التقييم حتى عندما تكون الأخبار سيئة.",
};

const MEASUREMENT_PLAN_AR: Record<string, { t: string; d: string }> = {
  "30 days": {
    t: "٣٠ يوماً",
    d: "إعادة قياس خط الأساس · معايرة الإنذارات الكاذبة · دورة ضبط اللهجة الأولى",
  },
  "90 days": {
    t: "٩٠ يوماً",
    d: "قراءة كاملة للمؤشرات مقابل خط الأساس · دراسة طولية لرضا العملاء · تمرين تدقيق امتثال",
  },
  "12 months": {
    t: "١٢ شهراً",
    d: "تأكيد الأهداف · تقرير الخسائر مقابل خط أساس ٣٤٠ مليون درهم · حزمة مراجعة مجلس الإدارة",
  },
};

function Metrics() {
  const { lang } = useApp();
  const maxes: Record<string, number> = { prevention: 100, delay: 2400, verify: 100, csat: 5 };
  const notes: Record<string, string> = {
    prevention:
      "Measured as share of confirmed-fraud attempts blocked after detection. Automation lifts the ceiling that human callback speed imposes.",
    delay:
      "From fraud signal to live customer contact. Automation is what shortens it against a human callback — the platform's own time-to-contact is not yet measured, so this bar is a target, not a reading.",
    verify:
      "Share of calls completing identity verification without falling back to manual channels. Multilingual voices drive this up.",
    csat: "Post-call survey. Transparent AI introduction, plus a handoff the platform triggers on repeated unclear answers or distress markers, protects the score even when the news is bad.",
  };
  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-2">
        {KPIS.map((k, i) => (
          <Reveal key={k.key} delay={i * 0.05}>
            <div className="h-full rounded-2xl border border-line bg-white p-6">
              <div className="flex items-baseline justify-between">
                <h3 className="text-[14.5px] font-semibold">{k.en}</h3>
                <span dir="rtl" className="font-arabic text-[11.5px] text-ink-3">
                  {k.ar}
                </span>
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
                {t(notes[k.key], METRIC_NOTES_AR[k.key], lang)}
              </p>
            </div>
          </Reveal>
        ))}
      </div>
      <Reveal delay={0.15}>
        <div className="rounded-2xl bg-card p-6 text-foreground sm:p-8">
          <p className="micro text-primary">Measurement plan · خطة القياس</p>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            {[
              {
                t: "30 days",
                d: "Baseline re-measure · false-positive calibration · dialect tuning cycle 1",
              },
              {
                t: "90 days",
                d: "Full KPI read vs. baseline · CSAT longitudinal study · compliance audit dry-run",
              },
              {
                t: "12 months",
                d: "Target confirmation · loss-run report vs. AED 340M baseline · board review pack",
              },
            ].map((m) => (
              <div key={m.t} className="rounded-2xl border border-line bg-secondary p-4">
                <p className="num text-[13px] font-bold text-primary">
                  {t(m.t, MEASUREMENT_PLAN_AR[m.t].t, lang)}
                </p>
                <p className="mt-2 text-[12px] leading-relaxed text-ink-2">
                  {t(m.d, MEASUREMENT_PLAN_AR[m.t].d, lang)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </Reveal>
    </div>
  );
}

export default Product;
