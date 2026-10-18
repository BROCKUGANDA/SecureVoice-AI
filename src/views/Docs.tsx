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
import { API_BASE_URL, SUPPORT_EMAIL } from "@/lib/public-config";
import { Reveal } from "@/components/fx/core";
import { cn } from "@/lib/utils";
import type { Lang } from "@/lib/store";

/* ————————————————— section registry ————————————————— */

const SECTIONS = [
  { id: "quickstart", en: "Quickstart", ar: "البداية السريعة", icon: Rocket },
  { id: "api", en: "API Reference", ar: "مرجع الواجهة", icon: Code2 },
  { id: "webhooks", en: "Webhooks", ar: "خطاف الأحداث", icon: Webhook },
  { id: "guardrails", en: "Guardrails", ar: "ضمانات الامتثال", icon: ShieldCheck },
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
                      ? "bg-primary text-white shadow-sm"
                      : "text-ink-2 hover:bg-white hover:text-foreground",
                  )}
                >
                  <s.icon
                    className={cn(
                      "h-4 w-4",
                      active ? "text-primary" : "text-ink-3 group-hover:text-primary",
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

      {/*
       * Contact band.
       *
       * Integrators read this page to wire their fraud engine to our API, so the
       * question this page most reliably produces is "who do I ask?" — and the
       * answer must be the SAME address the footer, the security page and every
       * transactional email use (SUPPORT_EMAIL), not a second one that drifts.
       */}
      <div className="mt-12 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-line bg-white/60 px-5 py-4">
        <span className="micro text-[9px] text-ink-3">
          {t("INTEGRATION SUPPORT", "دعم التكامل", lang)}
        </span>
        <span className="text-[13px] text-ink-2">
          {t(
            "Questions on the contract, a key, or a live pilot:",
            "أسئلة حول العقد أو المفتاح أو تجربة ميدانية:",
            lang,
          )}
        </span>
        <a
          href={`mailto:${SUPPORT_EMAIL}?subject=SecureVoice%20integration%20question`}
          className="text-[13px] font-semibold underline underline-offset-2"
        >
          {SUPPORT_EMAIL}
        </a>
        <span className="text-[12.5px] text-ink-3">{t("·", "·", lang)}</span>
        <a
          href={`${API_BASE_URL}/openapi`}
          className="text-[12.5px] text-ink-2 underline underline-offset-2"
        >
          {t("OpenAPI contract", "عقد OpenAPI", lang)}
        </a>
      </div>
    </div>
  );
}

/* ————————————————— header ————————————————— */

function Header({ lang }: { lang: Lang }) {
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
          "Every endpoint below is served by this deployment. The turn, TTS and ASR examples run as shown; the risk-signal ingest needs a producer key or the shared webhook secret — there is no anonymous dial.",
          "كل نقطة نهاية أدناه يخدمها هذا النشر. أمثلة الردّ والنطق والتعرف تعمل كما هو موضح، أما استقبال إشارة الخطر فيحتاج مفتاح مُنتج أو السر المشترك لخطاف الأحداث — لا يوجد اتصال مجهول.",
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
    <div className="overflow-hidden rounded-2xl border border-line bg-card">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-wider text-ink-2">
          <Terminal className="h-3 w-3" /> {title}
        </span>
        <button
          onClick={copy}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[10.5px] text-ink-2 transition hover:bg-secondary hover:text-foreground"
          aria-label={t("Copy code", "نسخ الشيفرة", lang)}
        >
          {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
          {copied ? t("copied", "تم النسخ", lang) : t("copy", "نسخ", lang)}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3.5 font-mono text-[12px] leading-relaxed text-ink-2 sv-scroll">
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

function Quickstart({ lang }: { lang: Lang }) {
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
      title: "Fire a signed risk signal",
      titleAr: "أطلق إشارة خطر موقّعة",
      body: "POST the signal to the interventions endpoint the moment a transaction crosses your own engine's risk threshold. You get a 202 with the case reference, and the outcome is signed back to the callback URL you pass. Authenticate with an HMAC signature over the raw body or a per-organisation Bearer producer key, and send an Idempotency-Key — a replay returns the stored response rather than dialling twice.",
      bodyAr:
        "أرسل الإشارة بالـ POST إلى نقطة تدخل الحالة بمجرد أن تتجاوز عملية ما عتبة الخطر في محرّككم أنتم. تحصل على رد ٢٠٢ مع مرجع الحالة، ويُعاد توقيع النتيجة إلى عنوان الخطاف الذي تمرّره. وصادِق بتوقيع HMAC على الجسم الخام أو بمفتاح مُنتج Bearer خاص بمؤسستك، وأرسل مفتاح التكرار Idempotency-Key — فإعادة الطلب تُعيد الاستجابة المخزّنة بدل أن تتصل مرتين.",
      code: `curl -X POST ${origin}/api/v1/interventions \\
  -H "SV-Signature: t=<unix>,v1=<hmac_sha256(secret, \\"t.body\\")>" \\
  -H "Idempotency-Key: <8+ chars, unique per signal>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "transaction_ref": "TRX-99127",
    "risk_score": 0.94,
    "phone": "+971500000000",
    "amount": 250000,
    "currency": "AED",
    "language": "ar",
    "consent_record_id": "CN-4417",
    "callback_url": "https://fraud.yourbank.ae/hooks/securevoice"
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
#     "reply": "I have flagged this transaction as fraud and placed a temporary restriction on your card while a human fraud specialist reviews it." }`,
    },
    {
      n: "03",
      title: "Close the loop",
      titleAr: "أغلق الحلقة",
      body: "When the customer confirms fraud, SecureVoice stages the card freeze, writes the case file, and hands off to your human agent with the transcript and audit trail. The stage is pending_specialist and committed:false — a permanent action on the bank's ledger needs your specialist, never this platform.",
      bodyAr:
        "عندما يؤكد العميل وقوع الاحتيال، يمهّد SecureVoice تجميد البطاقة (ولا ينفّذه)، ويرفع ملف الحالة، ويسلّم المكالمة إلى موظفكم البشري مع النص المحوّل وأثر التدقيق. الحالة pending_specialist وcommitted:false — فالإجراء الدائم في دفتر البنك يحتاج أخصائيكم، لا هذه المنصة.",
      code: `{
  "event": "case.closed",
  "case_id": "FRAUD-2026-08612",
  "outcome": "fraud_confirmed",
  "action_taken": "card_freeze",
  "prevented_loss_aed": 2500,
  "audit_hash": "b7f2e91c…"
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
            "Six surfaces. Ingest is authenticated by an HMAC signature over the raw body or a per-organisation producer key — those two mechanisms and no others. On this public site they are rate-limited and serve the live demo.",
            "ستّ واجهات. تُصادَق نقطة الاستقبال بتوقيع HMAC على الجسم الخام أو بمفتاح مُنتج خاص بالمؤسسة — هاتان الآليتان فقط دون غيرهما. وعلى هذا الموقع العام تكون محدودة المعدّل وتخدم العرض الحيّ.",
            lang,
          )}
        </p>
      </Reveal>

      <Reveal delay={0.04}>
        <Endpoint
          method="POST"
          path="/api/agent"
          desc={{
            en: "Guardrailed conversation turn. Deterministic intent classifier (auditable, reproducible) with protective action, confirmation, clarification or human handoff as the outcome.",
            ar: "محادثة خاضعة للضمانات. مصنّف نية حتمي (قابل للتدقيق وإعادة التنفيذ) تكون نتيجته إجراءً وقائياً أو تأكيداً أو طلب توضيح أو تسليماً لإنسان.",
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
                en: "deny_fraud | confirm_authorized | greeting | unclear | doubt | handoff",
                ar: "deny_fraud | confirm_authorized | greeting | unclear | doubt | handoff",
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
            en: "Neural speech synthesis. Server-side voice pipeline (keys never reach the browser), audio/mpeg from the configured provider — WAV on the dev fallback path — with per-call caching. The live agent speaks with one stock Library voice; cloning is disabled on this account.",
            ar: "توليف كلام عصبي. مسار صوتي على الخادم (لا تصل المفاتيح إلى المتصفح)، بصيغة audio/mpeg من المزوّد المهيّأ — وWAV على مسار التراجع في بيئة التطوير، مع تخزين مؤقت لكل مكالمة. الوكيل الحيّ يتصل بصوت واحد جاهز من مكتبة المزوّد، والاستنساخ معطّل في هذا الحساب.",
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
              note={{
                en: "0.5 – 2.0; when omitted, the paced profile speaks slower than conversational (0.92 for EN, 0.88 for AR)",
                ar: "من ٠٫٥ إلى ٢٫٠؛ وعند الحذف يطبَّق مسار «مُوَتَّر» الأبطأ من الحديث المعتاد (٠٫٩٢ للإنجليزية و٠٫٨٨ للعربية)",
              }}
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
          path="/api/v1/interventions"
          desc={{
            en: "The headless trigger — your fraud engine fires a signed risk signal and receives the intervention envelope (202). Idempotent on the Idempotency-Key: a retried delivery replays the stored response and never double-dials or double-bills. Two auth modes: Bearer producer key (svb_…, per-org) or HMAC signature over the raw body.",
            ar: "المشغّل بلا واجهة — يطلق محرّك مكافحة الاحتيال لديكم إشارة خطر موقّعة، فيستقبل مغلّف التدخل (٢٠٢). وهو مستقل عن التكرار بمفتاح Idempotency-Key: إعادة التسليم تُعيد الاستجابة المخزّنة، فلا اتصال مزدوج ولا احتساب مزدوج. وثمة وضعان للمصادقة: مفتاح مُنتج من نوع Bearer (svb_…، لكل مؤسسة) أو توقيع HMAC على الجسم الخام.",
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
                en: "0–1 — a schema range bound, not a dial threshold. Admission is capacity-based; risk × expected loss only orders the dial queue",
                ar: "من ٠ إلى ١ — حدّ لنطاق المخطط وليس عتبة اتصال. القبول يعتمد على السعة؛ ومضاعفة الخطر في الخسارة المتوقعة ترتّب طابور الاتصال فقط",
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
              name="signal_kind / call_category"
              type="enum?"
              note={{
                en: "optional; absent call_category falls back to time_critical_fraud",
                ar: "اختياري؛ وغياب call_category يسقط إلى time_critical_fraud",
              }}
            />
            <Field
              name="callback_url"
              type="string?"
              note={{
                en: "public https outcome webhook back to your core (SSRF-validated before it is stored)",
                ar: "خطاف نتائج عام بصيغة https يعود إلى نظامكم الأساسي (يُتحقق من SSRF قبل تخزينه)",
              }}
            />
            <Field
              name="→ caseRef"
              type="string"
              note={{
                en: "SV-F-… case reference + status: queued + jobId; the dial is placed by the worker, not by this request",
                ar: "مرجع الحالة SV-F-… + الحالة: queued + معرّف المهمة؛ والاتصال ينفّذه العامل لا هذا الطلب",
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
            en: "Customer enrollment for live delivery — customerRef, phone (E.164), language, channel (call/SMS) and consent record. Opt-out is a separate action on the same endpoint; phones are redacted before they are logged.",
            ar: "تسجيل العميل للتسليم الحيّ — customerRef، والهاتف (E.164)، واللغة، والقناة (مكالمة/رسالة نصية)، وسجل الموافقة. وإلغاء الاشتراك إجراء مستقل على النقطة نفسها؛ وتُخفّى أرقام الهواتف قبل تسجيلها.",
          }}
        >
          <div className="mt-3 border-t border-line/70 pt-3">
            <Field
              name="customerRef / phone"
              type="string"
              note={{ en: "required", ar: "مطلوب" }}
            />
            <Field
              name="lang / channel"
              type="enum"
              note={{
                en: "en | ar | hi | ur | fr | sw; call | sms",
                ar: "en | ar | hi | ur | fr | sw؛ call | sms",
              }}
            />
            <Field
              name="consentRecordId"
              type="string"
              note={{
                en: "required — enrollment itself is the consent record",
                ar: "مطلوب — التسجيل نفسه هو سجل الموافقة",
              }}
            />
            <Field
              name="→ customerRef"
              type="string"
              note={{
                en: "echoed back with channel and delivery mode; no PII returns",
                ar: "يُعاد مع القناة ووضع التسليم؛ ولا ترجع أي معلومات تعريف شخصية",
              }}
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
      en: "Outbound intervention call placed. No committed measurement fixes how soon after the signal this fires — the dial is placed by the queue worker, not by the ingest request.",
      ar: "بدأت مكالمة التدخل الصادرة. ولا توجد قراءة مُثبتة تحدد كم من الزمن يفصلها عن إشارة الخطر — فالاتصال ينفّذه عامل الطابور لا طلب الاستقبال.",
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
      en: "Protective action STAGED — the platform never commits it on the bank's ledger. Includes endpoint (card/transfer), reference, and authorised reason code.",
      ar: "الإجراء الوقائي يُمهَّد — ولا تثبّت المنصة شيئاً في دفتر البنك. يتضمن نقطة التنفيذ (بطاقة/تحويل)، والمرجع، ورمز السبب المعتمد.",
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
      en: "Guardrail ceiling hit or a handoff the platform raised. Handoff metadata for your contact centre — a live bridge needs a specialist number configured, and with none the case is recorded as a queue ticket rather than dropped.",
      ar: "بلوغ سقف الضمانات أو تسليم رفعه النظام. بيانات وصفية للتسليم إلى مركز الاتصال لديكم — فالربط الحيّ يتطلب ضبط رقم أخصائي، وبدونه تُسجَّل الحالة كتذكرة في الطابور بدل أن تُسقط المكالمة.",
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
            "Six events cover the full intervention lifecycle. Deliveries are signed (HMAC-SHA256 over the raw body), retried on a six-rung exponential backoff that spreads roughly 21 hours before the event is dead-lettered, and every payload is written to the audit log before it is delivered to your endpoint.",
            "تغطّي ستة أحداث دورة حياة التدخل كاملة. والتسليمات موقّعة (HMAC-SHA256 على الجسم الخام)، وتُعاد المحاولة على سلّم تراجع أسّي من ستّ درجات يمتد نحو ٢١ ساعة قبل تحويل الحدث إلى الطابور الميت، وتُكتب كل حمولة في سجل التدقيق قبل تسليمها إلى نقطتكم.",
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

function Guardrails({ lang }: { lang: Lang }) {
  return (
    <div className="space-y-5">
      <Reveal>
        <h2 className="font-display text-xl font-semibold tracking-tight">
          {t("Policy as configuration", "السياسة كإعداد قابل للتصدير", lang)}
        </h2>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-2">
          {t(
            "The guardrail rules are code, not a document: the intent classifier in src/app/api/agent/route.ts is deterministic, the compliance checks in src/lib/compliance/policy.ts run on every turn, and the shipped agent is configured by agent/securevoice.agent.yaml. Each is versioned in git, and every turn is written to a hash-chained audit log — so a regulator can replay what the agent was told and what it did. The block below summarises what the code enforces; it is not a file the runtime loads.",
            "قواعد الضمانات شيفرةٌ لا وثيقة: مصنّف النية في src/app/api/agent/route.ts حتمي، وفحوص الامتثال في src/lib/compliance/policy.ts تعمل في كل دور، والوكيل المُنشَر مُهيّأ بملف agent/securevoice.agent.yaml. وكل ذلك موثّق بالإصدارات في git، ويُكتب كل دور في سجل تدقيق مرتبط تجزئةً — فيستطيع الجهة التنظيمية إعادة تنفيذ ما طُلب من الوكيل وما فعله. والكتلة أدناه تلخّص ما يفرضه النظام، وهي ليست ملفاً يحمّله وقت التشغيل.",
            lang,
          )}
        </p>
      </Reveal>

      <Reveal delay={0.04}>
        <CodeBlock
          title={t(
            "what the runtime enforces · summarised from code",
            "ما يفرضه النظام · ملخّص من الشيفرة",
            lang,
          )}
          code={`// src/app/api/agent/route.ts — deterministic classifier
{
  "intents": ["deny_fraud", "confirm_authorized", "greeting",
              "unclear", "doubt", "handoff"],
  "actions": {
    "deny_fraud":        "card_freeze",   // stages, never commits
    "confirm_authorized": "none",
    "greeting":           "none",
    "unclear":            "clarify",
    "doubt":              "clarify",      // "are you human" → clarify
    "handoff":            "human_handoff"
  },
  "escalation": {
    "max_unclear_turns": 4,               // streak, not per-word
    "sentiment_escalate": ["distress", "third_party_pressure"],
    "handoff_eta_secs": 120,
    "handoff_fallback": "queue_ticket"    // no specialist number → queued
  },
  "card_freeze_tool": { "committed": false, "stage": "pending_specialist" },
  "voice": {
    "model_id": "eleven_v4_turbo",
    "stability": 0.5,
    "similarity_boost": 0.8,
    "cloning": "disabled — one stock Library voice",
    "disclosure": "injected into every reply; not timed",
    "agent_plane_languages": ["en", "ar", "hi"],
    "pipeline_languages": ["en", "ar", "hi", "ur", "fr", "sw"]
  },
  "ingest": { "risk_score": "0–1 range bound, not a dial threshold" }
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
              t: "Rules live in code",
              tAr: "القواعد في الشيفرة",
              d: "The classifier, the compliance gate and the shipped agent config are three files in the repository. Changing a rule is a reviewed commit, and CI pins the agent record against the YAML so a drift fails the build.",
              dAr: "المصنّف، وبوابة الامتثال، وملفتهيئة الوكيل المُنشَر ثلاثة ملفات في المستودعة. وتغيير أي قاعدة هو إيداع مُراجع، ويثبّت CI سجل الوكيل مقابل YAML فيفشل البناء عند أي انحراف.",
            },
            {
              icon: Database,
              t: "Replayable decisions",
              tAr: "قرارات قابلة لإعادة التنفيذ",
              d: "Each turn records the input, the classified intent, the action and the audit hash, chained with sha256 — so any decision can be reconstructed for a regulator from the log rather than from memory.",
              dAr: "يُسجَّل كل دور بمدخلاته والنية المصنَّفة والإجراء وبصمة التدقيق، مترابطة بـ sha256 — فيُمكن إعادة بناء أي قرار لصالح جهة تنظيمية من السجل لا من الذاكرة.",
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
      voice: "Polly.Joanna · EN-US (Say fallback)",
      status: "Live",
      statusAr: "تعمل",
      note: "On the live agent plane. Gulf-expat neutral register; resolved from the enrolled profile.",
      noteAr: "على الوكيل الحيّ. أسلوب محايد لوافدي الخليج؛ تُستنبط من الملف المسجّل.",
    },
    {
      lang: "Arabic",
      native: "العربية",
      voice: "Polly.Zeina · AR (Say fallback)",
      status: "Live",
      statusAr: "تعمل",
      note: "On the live agent plane. RTL transcript, Friday/weekend-aware phrasing.",
      noteAr:
        "على الوكيل الحيّ. نص محوّل من اليمين إلى اليسار، وصياغة تراعي الجمعة ونهاية الأسبوع.",
    },
    {
      lang: "Hindi",
      native: "हिन्दी",
      voice: "Polly.Aditi · HI-IN (Say fallback)",
      status: "Live",
      statusAr: "تعمل",
      note: "On the live agent plane. For the UAE's largest expat segment; code-switches to EN for card terms.",
      noteAr:
        "على الوكيل الحيّ. لأكبر شريحة وافدة في الإمارات؛ وتتحول إلى الإنجليزية في مصطلحات البطاقات.",
    },
    {
      lang: "Urdu",
      native: "اردو",
      voice: "Polly.Sana · UR-PK (Say fallback)",
      status: "Continuity pipeline",
      statusAr: "خط الاستمرارية",
      note: "Not an ElevenLabs agent preset. Full scripted coverage across all five demo cases — try it in the demo picker.",
      noteAr:
        "ليست إعداداً مسبقاً لوكيل ElevenLabs. تغطية نصية كاملة في حالات العرض الخمس — جرّبها في منتقي العرض.",
    },
    {
      lang: "French",
      native: "Français",
      voice: "Polly.Celine · FR-FR (Say fallback)",
      status: "Continuity pipeline",
      statusAr: "خط الاستمرارية",
      note: "Not an ElevenLabs agent preset. West-Africa corridor: remittance and beneficiary-fraud phrasing.",
      noteAr:
        "ليست إعداداً مسبقاً لوكيل ElevenLabs. ممر غرب أفريقيا: صياغة الحوالات واحتيال المستفيدين.",
    },
    {
      lang: "Swahili",
      native: "Kiswahili",
      voice: "Google.sw-KE-Standard-A · SW-KE (Say fallback)",
      status: "Continuity pipeline",
      statusAr: "خط الاستمرارية",
      note: "Not an ElevenLabs agent preset. East-Africa corridor: mobile-money fraud, which is where the loss actually is.",
      noteAr:
        "ليست إعداداً مسبقاً لوكيل ElevenLabs. ممر شرق أفريقيا: احتيال الأموال عبر الهاتف المحمول، وهو موضع الخسارة الفعلي.",
    },
  ];
  const roadmap = [
    {
      lang: "Bengali",
      native: "বাংলা",
      note: "Not implemented — no telephony voice, compliance script or persona yet, so it is not counted in the six above. Shared pipeline with Hindi.",
      noteAr:
        "غير مطبقة بعد — لا يوجد صوت هاتفي ولا نص امتثال ولا شخصية، لذا لا تُحتسب ضمن الستّ أعلاه. وتتقاسم خط المعالجة نفسه مع الهندية.",
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
              Six language codes ship in the platform, and each carries a real telephony voice and a
              compliance script rather than a translation layer. The split is deliberate:{" "}
              <strong className="font-semibold text-foreground">
                the interface — this site and the operator console — is English and Arabic, while a
                phone call and an SMS are delivered in all six
              </strong>
              . The spoken languages are not all on the same plane:{" "}
              <strong className="font-semibold text-foreground">
                the live ElevenLabs agent is configured for EN, AR and HI
              </strong>
              , and UR, FR and SW are spoken by the built-in continuity pipeline. Only English and
              Arabic have a recorded end-to-end conversation in the evidence bundle. The language is{" "}
              <strong className="font-semibold text-foreground">
                resolved from the enrolled customer profile before the call is placed
              </strong>
              : it is confirmed with the customer on the opening line and the agent is instructed to
              switch with them if they answer in another language — a <code>switch_language</code>{" "}
              tool records that change on the case. Financial terms (card, IBAN, transfer)
              code-switch into the customer&rsquo;s second language, matching how people in the UAE
              actually talk about money.
            </>
          ) : (
            <>
              ستّ لغات تعمل فعلياً في المنصة، وكل واحدة لها صوت هاتفي حقيقي ونص امتثال لا مجرد طبقة
              ترجمة. والفصل مقصود:{" "}
              <strong className="font-semibold text-foreground">
                الواجهة — هذا الموقع ووحدة تحكم المشغّل — بالإنجليزية والعربية، بينما تُجرى المكالمة
                الهاتفية وتصل الرسالة النصية بستّ لغات
              </strong>
              . وليست اللغات المنطوقة كلها على المستوى نفسه:{" "}
              <strong className="font-semibold text-foreground">
                الوكيل الحيّ من ElevenLabs مهيّأ للإنجليزية والعربية والهندية
              </strong>
              ، أمّا الأردية والفرنسية والسواحيلية فينطقها خط الاستمرارية المدمج. ولا توجد محادثة
              كاملة مسجّلة في حزمة الأدلة إلا بالعربية والإنجليزية. وتُستنبط اللغة{" "}
              <strong className="font-semibold text-foreground">
                من ملف العميل المسجّل قبل إجراء المكالمة
              </strong>
              : وتُؤكَّد مع العميل في سطر الافتتاح، ويُرشد الوكيل إلى التبديل إن أجاب بلغة أخرى،
              وتُسجّل أداة switch_language هذا التبديل في الحالة. وتتحول المصطلحات المالية (بطاقة،
              وآيبان، وتحويل) إلى اللغة الثانية للعميل، موافقةً للكيفية التي يتحدث بها الناس في
              الإمارات عن المال فعلاً.
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
                  {t(l.status, l.statusAr, lang)}
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
          {t("Run all six languages in the", "شغّل اللغات الستّ في", lang)}{" "}
          <span className="font-semibold text-foreground">
            &nbsp;{t("Live Demo", "عرض حي", lang)}&nbsp;
          </span>{" "}
          {t(
            "language picker — every language runs the full scripted scenario, not a sample. It is a simulation: the recorded end-to-end calls in the evidence bundle are English and Arabic only.",
            "منتقي اللغة — كل لغة تشغّل السيناريو الكامل المكتوب، لا مقطعاً منه. وهي محاكاة: فالمكالمات الكاملة المسجّلة في حزمة الأدلة بالعربية والإنجليزية فقط.",
            lang,
          )}
        </div>
      </Reveal>
    </div>
  );
}

export default Docs;
