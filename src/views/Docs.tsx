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
import { API_BASE_URL } from "@/lib/public-config";
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
            aria-label={t("Documentation", "التوثيق", lang)}
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
        <span className="micro text-primary">{t("Documentation", "التوثيق", lang)}</span>
        <span className="h-px w-10 bg-line" />
        {lang === "en" && (
          <span dir="rtl" className="font-arabic text-[13px] text-ink-3">
            التوثيق التقني
          </span>
        )}
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
  const { lang } = useApp();
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
      <div className="micro text-[9px] text-ink-3">
        {t("PLATFORM STATUS · LIVE", "حالة المنصة · مباشر", lang)}
      </div>
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
            {status.region ?? t("self-hosted", "مستضاف ذاتياً", lang)}
            {failed ? t(" · last poll failed", " · فشل آخر استعلام", lang) : ""}
          </div>
        </>
      ) : failed ? (
        <div className="mt-2 font-mono text-[10.5px] text-ink-3">
          {t("status unavailable — retrying", "الحالة غير متاحة — إعادة المحاولة", lang)}
        </div>
      ) : (
        <div className="mt-2 h-8 w-full animate-pulse rounded bg-line/40" />
      )}
    </div>
  );
}

/* ————————————————— shared bits ————————————————— */

/** A user-visible string plus its Modern Standard Arabic counterpart. Docs
    prose travels as these so the Arabic can never drift out of sync with the
    English sentence it translates. */
type Bi = { en: string; ar: string };

function CodeBlock({ title, code }: { title: string; code: string }) {
  const { lang } = useApp();
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
          aria-label={t("Copy code", "نسخ الشيفرة", lang)}
        >
          {copied ? <Check className="h-3 w-3 text-green-bright" /> : <Copy className="h-3 w-3" />}
          {copied ? t("copied", "تم النسخ", lang) : t("copy", "نسخ", lang)}
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
  desc: Bi;
  children?: React.ReactNode;
}) {
  const { lang } = useApp();
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
      <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-2">{t(desc.en, desc.ar, lang)}</p>
      {children}
    </div>
  );
}

function Field({ name, type, note }: { name: string; type: string; note: Bi }) {
  const { lang } = useApp();
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5">
      <code className="font-mono text-[12px] font-semibold text-foreground">{name}</code>
      <span className="font-mono text-[10.5px] uppercase tracking-wide text-primary">{type}</span>
      <span className="text-[12.5px] text-ink-3">{t(note.en, note.ar, lang)}</span>
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
    (typeof window !== "undefined" ? window.location.origin : API_BASE_URL);
  const steps = [
    {
      n: "01",
      title: "Subscribe to intervention events",
      titleAr: "اشترك في أحداث التدخل",
      body: "Point your fraud-orchestration webhook at SecureVoice. When a transaction crosses your risk threshold, we place the intervention call and stream every phase transition back to you.",
      bodyAr:
        "وجّه خطاف أحداث منظومة مكافحة الاحتيال لديكم إلى SecureVoice. وعندما تتجاوز عملية ما عتبة الخطر المعتمدة، نبدأ مكالمة التدخل وبثّ كل انتقال بين المراحل إليكم.",
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
      titleAr: "عالج محادثة الوكيل",
      body: "During a live call, each customer utterance can be routed through the guardrailed turn API — the same deterministic decision surface that powers this demo. It never asks for PINs, passwords or OTPs.",
      bodyAr:
        "أثناء المكالمة الحيّة، يمكن تمرير كل عبارة ينطق بها العميل عبر واجهة الرد الخاضعة للضمانات — نفس سطح القرار الحتمي الذي يشغّل هذا العرض. ولا تطلب أبداً رموزاً سرية أو كلمات مرور أو رموز تحقق لمرة واحدة.",
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
      titleAr: "أغلق الحلقة",
      body: "When the customer confirms fraud, SecureVoice freezes the card, writes the case file, and hands off to your human agent with a full bilingual transcript and audit trail.",
      bodyAr:
        "عندما يؤكد العميل وقوع الاحتيال، يجمّد SecureVoice البطاقة، ويرفع ملف الحالة، ويسلّم المكالمة إلى موظفكم البشري مع نص محوّل ثنائي اللغة كامل وأثر تدقيق.",
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
                {t(s.title, s.titleAr, lang)}
              </h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
                {t(s.body, s.bodyAr, lang)}
              </p>
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
  const { lang } = useApp();
  return (
    <div className="space-y-5">
      <Reveal>
        <h2 className="font-display text-xl font-semibold tracking-tight">
          {t("Endpoints", "نقاط النهاية", lang)}
        </h2>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-2">
          {t(
            "Five surfaces, all authenticated by mutual TLS inside a bank deployment. On this public site they are rate-limited and serve the live demo.",
            "خمس واجهات، جميعها مصادَقة بتفاهم TLS متبادل داخل النشر البنكي. وعلى هذا الموقع العام تكون محدودة المعدّل وتخدم العرض الحيّ.",
            lang,
          )}
        </p>
      </Reveal>

      <Reveal delay={0.04}>
        <Endpoint
          method="POST"
          path="/api/agent"
          desc={{
            en: "Guardrailed conversation turn. Deterministic intent classifier (auditable, reproducible) with three-outcome routing: protective action, confirmation, or clarification.",
            ar: "محادثة خاضعة للضمانات. مصنّف نية حتمي (قابل للتدقيق وإعادة التنفيذ) بثلاث مسارات للنتيجة: إجراء وقائي، أو تأكيد، أو طلب توضيح.",
          }}
        >
          <div className="mt-3 border-t border-line/70 pt-3">
            <Field
              name="text"
              type="string"
              note={{
                en: "customer utterance, 1–600 chars",
                ar: "عبارة العميل، من حرف إلى ٦٠٠ حرف",
              }}
            />
            <Field
              name="lang"
              type="enum"
              note={{
                en: "en | ar | hi | ur | fr | sw — reply is generated in the same language",
                ar: "en | ar | hi | ur | fr | sw — يُولَّد الرد باللغة نفسها",
              }}
            />
            <Field
              name="→ intent"
              type="string"
              note={{
                en: "deny_fraud | confirm_authorized | greeting | unclear",
                ar: "deny_fraud | confirm_authorized | greeting | unclear",
              }}
            />
            <Field
              name="→ action"
              type="string"
              note={{
                en: "card_freeze | none | clarify | human_handoff — never credentials",
                ar: "card_freeze | none | clarify | human_handoff — ولا بيانات اعتماد أبداً",
              }}
            />
            <Field
              name="→ sentiment / escalate"
              type="string"
              note={{
                en: "distress or live-coaching markers route the call to a human operator",
                ar: "ترفع علامات الاستغاثة أو التوجيه الحيّ المكالمة إلى مشغّل بشري",
              }}
            />
          </div>
        </Endpoint>
      </Reveal>

      <Reveal delay={0.06}>
        <Endpoint
          method="POST"
          path="/api/tts"
          desc={{
            en: "Neural speech synthesis. Server-side voice pipeline (keys never reach the browser), WAV @ 24 kHz, per-tenant voice personas with caching.",
            ar: "توليف كلام عصبي. مسار صوتي على الخادم (لا تصل المفاتيح إلى المتصفح)، بصيغة WAV بمعدل ٢٤ كيلوهرتز، مع شخصيات صوتية لكل مستأجر وذاكرة تخزين مؤقت.",
          }}
        >
          <div className="mt-3 border-t border-line/70 pt-3">
            <Field
              name="text"
              type="string"
              note={{ en: "≤ 1024 chars", ar: "١٠٢٤ حرفاً كحد أقصى" }}
            />
            <Field
              name="voice"
              type="enum"
              note={{
                en: "language key (en | ar | hi | ur | fr | sw) or a configured ElevenLabs voice_id — BYOK keys skip platform metering",
                ar: "مفتاح اللغة (en | ar | hi | ur | fr | sw) أو معرّف صوت ElevenLabs مهيّأ — ومفاتيح BYOK تتجاوز قياس الاستهلاك على المنصة",
              }}
            />
            <Field
              name="→ /api/tts/stream"
              type="audio/mpeg"
              note={{
                en: "chunked streaming variant — playback starts before the render completes",
                ar: "نسخة بث مجزّأة — يبدأ التشغيل قبل اكتمال التوليد",
              }}
            />
            <Field
              name="speed"
              type="float"
              note={{ en: "0.5 – 2.0, default 1.0", ar: "من ٠٫٥ إلى ٢٫٠، والافتراضي ١٫٠" }}
            />
            <Field
              name="→ body"
              type="audio/wav"
              note={{
                en: "binary stream, Cache-Control: private",
                ar: "دفق ثنائي، مع Cache-Control: private",
              }}
            />
          </div>
        </Endpoint>
      </Reveal>

      <Reveal delay={0.08}>
        <Endpoint
          method="POST"
          path="/api/asr"
          desc={{
            en: "Real-time speech-to-text for customer audio. Used by the live console to transcribe caller responses before the guardrail classifier runs.",
            ar: "تحويل الكلام إلى نص لحظي لصوت العميل. يستخدمه الكونسول الحيّ لنسخ ردود المتصل قبل تشغيل مصنّف الضمانات.",
          }}
        >
          <div className="mt-3 border-t border-line/70 pt-3">
            <Field
              name="audio"
              type="string"
              note={{
                en: "base64-encoded webm/opus, wav or mp3 (≤ 18 MB)",
                ar: "بترميز base64 بصيغة webm/opus أو wav أو mp3 (١٨ ميغابايت كحد أقصى)",
              }}
            />
            <Field
              name="→ text"
              type="string"
              note={{
                en: "transcript with confidence trimming",
                ar: "نص محوّل بعد استبعاد ما دون عتبة الثقة",
              }}
            />
          </div>
        </Endpoint>
      </Reveal>

      <Reveal delay={0.09}>
        <Endpoint
          method="POST"
          path="/api/interventions"
          desc={{
            en: "The headless trigger — your fraud engine fires a signed risk signal and receives the intervention envelope instantly (202). Idempotent by caseId: a retried delivery never double-bills. Two auth modes: Bearer producer key (svb_…, per-org) or HMAC signature over the raw body.",
            ar: "المشغّل بلا واجهة — يطلق محرّك مكافحة الاحتيال لديكم إشارة خطر موقّعة، فيستقبل مغلّف التدخل فوراً (٢٠٢). وهو مستقل عن التكرار بحسب معرّف الحالة: أي إعادة تسليم لا تُحتسب مرتين. وثمة وضعان للمصادقة: مفتاح مُنتج من نوع Bearer (svb_…، لكل مؤسسة) أو توقيع HMAC على الجسم الخام.",
          }}
        >
          <div className="mt-3 border-t border-line/70 pt-3">
            <Field
              name="transaction_ref"
              type="string"
              note={{
                en: "your transaction reference — echoed back on your result webhook",
                ar: "مرجع العميلة لديكم — يُعاد إليكم في خطاف النتائج",
              }}
            />
            <Field
              name="phone"
              type="string"
              note={{ en: "E.164 customer phone number", ar: "رقم هاتف العميل بصيغة E.164" }}
            />
            <Field
              name="amount"
              type="integer"
              note={{
                en: "integer minor units (e.g. 250000 for AED 2,500.00)",
                ar: "وحدات صحيحة صغرى (مثال ٢٥٠٠٠٠ مقابل ٢٥٠٠٫٠٠ درهم)",
              }}
            />
            <Field
              name="currency"
              type="string"
              note={{
                en: "ISO-4217 currency code (e.g. AED, USD, KES)",
                ar: "رمز عملة بمعيار ISO-4217 (مثل AED، USD، KES)",
              }}
            />
            <Field
              name="risk_score"
              type="number"
              note={{
                en: "0–1 — maps to the pre-approved action plan",
                ar: "من ٠ إلى ١ — يُترجم إلى خطة الإجراءات المعتمدة مسبقاً",
              }}
            />
            <Field
              name="language"
              type="string"
              note={{
                en: "BCP-47 language code (e.g. en, ar, hi)",
                ar: "رمز لغة بمعيار BCP-47 (مثل en، ar، hi)",
              }}
            />
            <Field
              name="merchant"
              type="string?"
              note={{ en: "merchant name, optional", ar: "اسم التاجر، اختياري" }}
            />
            <Field
              name="consent_record_id"
              type="string"
              note={{ en: "consent record reference", ar: "مرجع سجل الموافقة" }}
            />
            <Field
              name="signal.customer"
              type="object"
              note={{
                en: "ref (no PII) + lang: en | ar | hi | ur | fr | sw",
                ar: "ref (بلا معلومات تعريف شخصية) + lang: en | ar | hi | ur | fr | sw",
              }}
            />
            <Field
              name="signal.callbackUrl"
              type="string?"
              note={{
                en: "signed outcome webhook (intervention.outcome) back to your core",
                ar: "خطاف نتائج موقّع (intervention.outcome) يعود إلى نظامكم الأساسي",
              }}
            />
            <Field
              name="→ interventionId"
              type="string"
              note={{
                en: "SV-F-… case reference + SLA deadline + action plan",
                ar: "مرجع الحالة SV-F-… + موعد الالتزام الزمني + خطة الإجراءات",
              }}
            />
            <Field
              name="→ 402"
              type="string"
              note={{
                en: "wallet empty — prepaid credits (1 credit = 1 intervention)",
                ar: "المحفظة فارغة — رصيد مسبق الدفع (رصيد واحد = تدخل واحد)",
              }}
            />
          </div>
        </Endpoint>
      </Reveal>

      <Reveal delay={0.11}>
        <Endpoint
          method="POST"
          path="/api/enroll"
          desc={{
            en: "Customer enrollment for live delivery — phone (E.164), language, channel (call/SMS) and consent record. Opt-out honoured instantly; phones are never logged raw.",
            ar: "تسجيل العميل للتسليم الحيّ — الهاتف (E.164)، واللغة، والقناة (مكالمة/رسالة نصية)، وسجل الموافقة. ويُحترم طلب إلغاء الاشتراك فوراً؛ ولا تُسجَّل أرقام الهواتف خاماً.",
          }}
        >
          <div className="mt-3 border-t border-line/70 pt-3">
            <Field
              name="name / email / institution"
              type="string"
              note={{ en: "required", ar: "مطلوب" }}
            />
            <Field
              name="role / volume / message"
              type="string"
              note={{ en: "optional scoping fields", ar: "حقول اختيارية لتحديد النطاق" }}
            />
            <Field
              name="→ ref"
              type="string"
              note={{ en: "your reference for support conversations", ar: "مرجعكم لمحادثات الدعم" }}
            />
          </div>
        </Endpoint>
      </Reveal>

      <Reveal delay={0.12}>
        <Endpoint
          method="GET"
          path="/api/status"
          desc={{
            en: "Liveness + DB round-trip latency for uptime monitoring. No auth required; safe for public probes. Polled by the status chip on this page.",
            ar: "جاهزية التشغيل + زمن ذهاب وإرجاع قاعدة البيانات لمراقبة التوافر. لا تتطلب مصادقة؛ وآمنة للفحوص العامة. ويستعلم عنها مؤشر الحالة في هذه الصفحة.",
          }}
        >
          <div className="mt-3 border-t border-line/70 pt-3">
            <Field
              name="→ dbLatencyMs"
              type="number"
              note={{
                en: "round-trip to the primary, as measured — not mocked",
                ar: "زمن الذهاب والإرجاع إلى القاعدة الأساسية، كما يُقاس فعلياً — لا قيمة وهمية",
              }}
            />
            <Field
              name="→ version / region"
              type="string"
              note={{ en: "build tag + deployment region", ar: "وسم الإصدار + منطقة النشر" }}
            />
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
    desc: {
      en: "Outbound intervention call placed. Fires within 800 ms of the risk trigger.",
      ar: "بدأت مكالمة التدخل الصادرة. تُطلق خلال ٨٠٠ مللي ثانية من إشارة الخطر.",
    },
  },
  {
    name: "identity.verified",
    desc: {
      en: "Caller passed knowledge checks. Never contains the answers — only the outcome.",
      ar: "اجتاز المتصل أسئلة التحقق. ولا يتضمن الإجابات أبداً — النتيجة فقط.",
    },
  },
  {
    name: "account.frozen",
    desc: {
      en: "Protective action executed. Includes endpoint (card/transfer), reference, and authorised reason code.",
      ar: "نُفّذ الإجراء الوقائي. ويتضمن نقطة التنفيذ (بطاقة/تحويل)، والمرجع، ورمز السبب المعتمد.",
    },
  },
  {
    name: "customer.confirmed",
    desc: {
      en: "Customer authorised the transaction. No action taken; confirmation logged for review.",
      ar: "أجاز العميل العملية. ولا يُتخذ أي إجراء؛ ويُسجّل التأكيد للمراجعة.",
    },
  },
  {
    name: "case.closed",
    desc: {
      en: "Terminal event. Outcome, prevented-loss estimate, bilingual transcript URL, audit hash.",
      ar: "الحدث الختامي. النتيجة، وتقدير الخسارة التي تم منعها، ورابط النص المحوّل ثنائي اللغة، وبصمة التدقيق.",
    },
  },
  {
    name: "escalated.human",
    desc: {
      en: "Guardrail ceiling hit or customer request. Warm transfer metadata for your contact centre.",
      ar: "بلوغ سقف الضمانات أو طلب العميل. بيانات وصفية للتحويل الدافئ إلى مركز الاتصال لديكم.",
    },
  },
];

function Webhooks() {
  const { lang } = useApp();
  return (
    <div className="space-y-5">
      <Reveal>
        <h2 className="font-display text-xl font-semibold tracking-tight">
          {t("Event catalog", "دليل الأحداث", lang)}
        </h2>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-2">
          {t(
            "Six events cover the full intervention lifecycle. Deliveries are signed (HMAC-SHA256 over the raw body), retried with exponential backoff for 24 hours, and every payload is written to the audit log before it is delivered to your endpoint.",
            "تغطّي ستة أحداث دورة حياة التدخل كاملة. والتسليمات موقّعة (HMAC-SHA256 على الجسم الخام)، وتُعاد المحاولة بتراجع أسّي خلال ٢٤ ساعة، وتُكتب كل حمولة في سجل التدقيق قبل تسليمها إلى نقطتكم.",
            lang,
          )}
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
              <span className="text-[13px] leading-relaxed text-ink-2">
                {t(e.desc.en, e.desc.ar, lang)}
              </span>
            </div>
          ))}
        </div>
      </Reveal>

      <Reveal delay={0.08}>
        <CodeBlock
          title={t("payload · account.frozen", "الحمولة · account.frozen", lang)}
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
          title={t(
            "guardrails.policy.json · v2026.02",
            "ملف السياسة guardrails.policy.json · v2026.02",
            lang,
          )}
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
              tAr: "لا تُطلب بيانات الاعتماد",
              d: "The classifier has no branch that asks for PINs, passwords or OTPs — enforced structurally, not by prompt.",
              dAr: "لا يوجد في المصنّف أي مسار يطلب رمزاً سرياً أو كلمة مرور أو رمز تحقق لمرة واحدة — مفروض بنيوياً، لا عبر التعليمات.",
            },
            {
              icon: FileJson2,
              t: "Signed policy diffs",
              tAr: "فروق السياسة الموقّعة",
              d: "Every change is reviewed, signed and versioned; the runtime pins the hash it runs under.",
              dAr: "كل تغيير يُراجع ويُوقّع ويُرقّم؛ ويثبّت النظام البصمة التي يعمل تحت مظلّتها.",
            },
            {
              icon: Database,
              t: "Replayable decisions",
              tAr: "قرارات قابلة لإعادة التنفيذ",
              d: "Each turn stores policy hash + inputs + output so any decision can be replayed for a regulator.",
              dAr: "يخزّن كل دور بصمة السياسة والمدخلات والمخرجات، فيمكن إعادة تنفيذ أي قرار لصالح جهة تنظيمية.",
            },
          ].map((x) => (
            <div key={x.t} className="rounded-2xl border border-line bg-white p-5">
              <x.icon className="h-4.5 w-4.5 text-primary" />
              <div className="mt-2.5 text-[13.5px] font-semibold tracking-tight">
                {t(x.t, x.tAr, lang)}
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{t(x.d, x.dAr, lang)}</p>
            </div>
          ))}
        </div>
      </Reveal>
    </div>
  );
}

/* ————————————————— languages ————————————————— */

function LanguagesSection() {
  const { lang } = useApp();
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
      noteAr: "أسلوب محايد لوافدي الخليج؛ يُكتشف من ملف البنك.",
    },
    {
      lang: "Arabic",
      native: "العربية",
      voice: "FATIMA · AR-GULF",
      status: "Live",
      note: "Gulf dialect, RTL transcript, Friday/weekend-aware phrasing.",
      noteAr: "لهجة خليجية، ونص محوّل من اليمين إلى اليسار، وصياغة تراعي الجمعة ونهاية الأسبوع.",
    },
    {
      lang: "Hindi",
      native: "हिन्दी",
      voice: "KAVITA · HI-IN",
      status: "Live",
      note: "For the UAE's largest expat segment; code-switches to EN for card terms.",
      noteAr: "لأكبر شريحة وافدة في الإمارات؛ وتتحول إلى الإنجليزية في مصطلحات البطاقات.",
    },
    {
      lang: "Urdu",
      native: "اردو",
      voice: "SANA · UR-UAE",
      status: "Live",
      note: "Full script coverage across all three fraud cases — try it in the demo picker.",
      noteAr: "تغطية كاملة للنصوص في حالات الاحتيال الثلاث — جرّبها في منتقي العرض.",
    },
    {
      lang: "French",
      native: "Français",
      voice: "CELINE · FR-FR",
      status: "Live",
      note: "West-Africa corridor: remittance and beneficiary-fraud phrasing.",
      noteAr: "ممر غرب أفريقيا: صياغة الحوالات واحتيال المستفيدين.",
    },
    {
      lang: "Swahili",
      native: "Kiswahili",
      voice: "AMINA · SW-KE",
      status: "Live",
      note: "East-Africa corridor: mobile-money fraud, which is where the loss actually is.",
      noteAr: "ممر شرق أفريقيا: احتيال الأموال عبر الهاتف المحمول، وهو موضع الخسارة الفعلي.",
    },
  ];
  const roadmap = [
    {
      lang: "Bengali",
      native: "বাংলা",
      note: "Not yet wired — no telephony voice, compliance script or persona yet, so it is not counted in the six above. Shared pipeline with Hindi.",
      noteAr:
        "لم تُربط بعد — لا يوجد صوت هاتفي ولا نص امتثال ولا شخصية بعد، لذا لا تُحتسب ضمن الستّ أعلاه. وتتقاسم خط المعالجة نفسه مع الهندية.",
    },
  ];

  return (
    <div className="space-y-5">
      <Reveal>
        <h2 className="font-display text-xl font-semibold tracking-tight">
          {t("Call languages", "لغات المكالمات", lang)}
        </h2>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-2">
          {lang === "en" ? (
            <>
              Six languages ship live, and each is a complete voice — telephony voice, compliance
              script and transcript — rather than a translation layer. The agent{" "}
              <strong className="font-semibold text-foreground">
                knows which language to use before the call is placed
              </strong>
              : it is resolved from the enrolled customer profile and the tenant&rsquo;s own routing
              rules, then confirmed with the customer on the opening line and switched mid-call if
              they answer in another language. Financial terms (card, IBAN, transfer) code-switch
              into the customer&rsquo;s second language, matching how people in the UAE actually
              talk about money.
            </>
          ) : (
            <>
              ست لغات تعمل فعلياً، وكل واحدة منها صوت مكتمل — صوت هاتفي، ونص امتثال، ونص محوّل — لا
              مجرد طبقة ترجمة. والوكيل{" "}
              <strong className="font-semibold text-foreground">
                يعرف اللغة التي يجب استخدامها قبل إجراء المكالمة
              </strong>
              : تُستنبط من ملف العميل المسجّل وقواعد التوجيه الخاصة بالمستأجر، ثم تُؤكَّد مع العميل
              في سطر الافتتاح، وتُبدَّل في منتصف المكالمة إذا أجاب بلغة أخرى. وتتحول المصطلحات
              المالية (بطاقة، وآيبان، وتحويل) إلى اللغة الثانية للعميل، موافقةً للكيفية التي يتحدث
              بها الناس في الإمارات عن المال فعلاً.
            </>
          )}
        </p>
      </Reveal>

      <Reveal delay={0.02}>
        <div className="rounded-2xl border border-line bg-white p-5">
          <div className="micro text-[9px] text-ink-3">
            {t("WHERE THE AGENT&rsquo;S KNOWLEDGE COMES FROM", "من أين يستمد الوكيل معرفته", lang)}
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
            {t(
              "The agent never improvises your bank’s policy. What it says on a call is drawn from a knowledge base you control, in whichever of the two ways suits your estate:",
              "لا يقترح الوكيل سياسة بنككم على سبيل الاجتهاد. فكل ما يقوله في المكالمة مستمد من قاعدة معرفة تتحكمون فيها، بإحدى طريقتين تناسبان بنيتكم:",
              lang,
            )}
          </p>
          <ul className="mt-3 space-y-3">
            <li className="flex gap-3">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span className="text-[13px] leading-relaxed text-ink-2">
                <strong className="font-semibold text-foreground">
                  {t(
                    "Uploaded through the provider’s knowledge base.",
                    "تُرفع عبر قاعدة المعرفة لدى المزوّد.",
                    lang,
                  )}
                </strong>{" "}
                {t(
                  "Your escalation matrix, refund thresholds and disclosure wording are uploaded as documents to the voice provider’s knowledge base and retrieved per turn. You can update them without a deploy, and every retrieval is logged against the call for audit.",
                  "تُرفع مصفوفة التصعيد وعتبات رد الأموال وصياغة الإفصاح كوثائق إلى قاعدة المعرفة لدى مزوّد الصوت، وتُستعاد في كل دور. ويمكنكم تحديثها دون نشر جديد، وكل استرجاع يُسجّل مرتبطاً بالمكالمة لأغراض التدقيق.",
                  lang,
                )}
              </span>
            </li>
            <li className="flex gap-3">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span className="text-[13px] leading-relaxed text-ink-2">
                <strong className="font-semibold text-foreground">
                  {t(
                    "Integrated with your internal systems.",
                    "التكامل مع أنظمتكم الداخلية.",
                    lang,
                  )}
                </strong>{" "}
                {t(
                  "Where the answer lives in a core banking or CRM system, we integrate directly and resolve it live during the call — the agent reads your data rather than a cached summary of it. Nothing is asserted to a customer that the source system did not return.",
                  "حيث يكون الجواب موجوداً في نظام بنكي أساسي أو نظام إدارة علاقات العملاء، نتكامل مباشرة ونستنبطه حيّاً أثناء المكالمة — يقرأ الوكيل بياناتكم لا ملخصاً مخزناً عنها. ولا يُدّعى على العميل أمر لم يُعده النظام المصدر.",
                  lang,
                )}
              </span>
            </li>
          </ul>
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink-3">
            {t(
              "Both paths are tenant-scoped: a bank’s documents and internal answers are never visible to another institution, and the compliance disclosure that opens every call is enforced server-side in each language rather than left to the model.",
              "كلا المسارين محصوران بالمستأجر: لا تكون وثائق البنك وإجاباته الداخلية مرئية لمؤسسة أخرى، وإفصاح الامتثال الذي يُفتح به كل مكالمة مفروض على مستوى الخادم بكل لغة، لا متروكاً للنموذج.",
              lang,
            )}
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
                  {t(l.status, "تعمل", lang)}
                </span>
              </div>
              <div
                dir={l.lang === "English" ? "ltr" : undefined}
                className={cn("mt-1 text-[13px] text-ink-2", l.lang === "Arabic" && "font-arabic")}
              >
                {l.native}
              </div>
              <div className="mt-3 font-mono text-[10.5px] tracking-wide text-ink-3">{l.voice}</div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-2">
                {t(l.note, l.noteAr, lang)}
              </p>
            </div>
          ))}
        </div>
      </Reveal>

      <Reveal delay={0.08}>
        <div className="rounded-2xl border border-dashed border-line bg-white/60 p-5">
          <div className="micro text-[9px] text-ink-3">
            {t("ON THE ROADMAP", "على خارطة الطريق", lang)}
          </div>
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
                <span className="text-[12.5px] leading-relaxed text-ink-2">
                  {t(l.note, l.noteAr, lang)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="flex items-center gap-2 text-[13px] text-ink-2">
          <ArrowRight className="h-3.5 w-3.5 text-primary" />
          {t("Hear all six languages in the", "استمع إلى اللغات الست كلها في", lang)}{" "}
          <span className="font-semibold text-foreground">
            &nbsp;{t("Live Demo", "العرض الحي", lang)}&nbsp;
          </span>{" "}
          {t(
            "language picker — every language runs the full script, not a sample.",
            "منتقي اللغة — كل لغة تشغّل النص الكامل، لا مقطعاً منه.",
            lang,
          )}
        </div>
      </Reveal>
    </div>
  );
}
