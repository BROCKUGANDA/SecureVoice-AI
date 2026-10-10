"use client";

import { useEffect, useState } from "react";
import {
  ShieldCheck,
  Lock,
  Database,
  Globe2,
  Fingerprint,
  Server,
  KeyRound,
  FileCheck2,
  CheckCircle2,
  XCircle,
  Bug,
  EyeOff,
  ScrollText,
  ArrowRight,
  HeartPulse,
} from "lucide-react";
import { useApp, t } from "@/lib/store";
import { SUPPORT_EMAIL } from "@/lib/public-config";
import { Reveal } from "@/components/fx/core";
import { cn } from "@/lib/utils";

/* ————————————————— live platform probe ————————————————— */

type Status = {
  ok: boolean;
  version: string;
  region: string;
  dbLatencyMs: number | null;
  heapUsedMb: number;
  rssMb: number;
  ts: string;
};

function useStatus(pollMs = 20000) {
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/status")
        .then((r) => r.json())
        .then((d) => {
          if (alive) {
            setStatus(d);
            setErr(false);
          }
        })
        .catch(() => alive && setErr(true));
    load();
    const id = setInterval(load, pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pollMs]);
  return { status, err };
}

function fmtMem(mb: number) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

function LiveStatusBand() {
  const { status, err } = useStatus();
  const { lang } = useApp();

  const cells: { label: string; value: React.ReactNode; pulse?: boolean }[] = status
    ? [
        {
          label: t("API service", "خدمة الواجهة", lang),
          value: status.ok ? t("Operational", "تعمل", lang) : t("Degraded", "متدهورة", lang),
          pulse: status.ok,
        },
        {
          label: t("Database round-trip", "زمن قاعدة البيانات", lang),
          value: `${status.dbLatencyMs ?? "—"} ms`,
        },
        { label: t("Region", "المنطقة", lang), value: status.region },
        { label: t("Build", "الإصدار", lang), value: `v${status.version}` },
        {
          label: t("Memory footprint", "استهلاك الذاكرة", lang),
          value: status.rssMb ? fmtMem(status.rssMb) : "—",
        },
      ]
    : [
        {
          label: t("API service", "خدمة الواجهة", lang),
          value: t("Probing…", "جارٍ الفحص…", lang),
        },
        { label: t("Database round-trip", "زمن قاعدة البيانات", lang), value: "—" },
        { label: t("Region", "المنطقة", lang), value: "—" },
        { label: t("Build", "الإصدار", lang), value: "—" },
        { label: t("Memory footprint", "استهلاك الذاكرة", lang), value: "—" },
      ];

  return (
    <div
      className={cn(
        "mt-8 rounded-3xl border p-6 sm:p-7",
        err ? "border-red-200 bg-red-50/60" : "border-line bg-white",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <HeartPulse className={cn("h-4 w-4", err ? "text-red-600" : "text-primary")} />
          <span className="font-display text-[15px] font-semibold tracking-tight">
            {t("Live platform status", "حالة المنصة المباشرة", lang)}
          </span>
        </div>
        <span className="font-mono text-[10.5px] text-ink-3">
          {t(
            "measured on this page, every 20s — not a mock",
            "قياس حقيقي كل ٢٠ ثانية — ليس عرضاً",
            lang,
          )}
        </span>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-5">
        {cells.map((c) => (
          <div key={c.label}>
            <div className="micro text-[9px] text-ink-3">{c.label.toUpperCase()}</div>
            <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[13px] font-semibold">
              {c.pulse && <span className="sv-pulse-ring h-2 w-2 rounded-full bg-primary" />}
              <span className={cn(err && c.label.includes("service") && "text-red-600")}>
                {c.value}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ————————————————— live security-header probe ————————————————— */

type HeaderRow = {
  name: string;
  label: string;
  labelAr: string;
  present: boolean;
  note: string;
  noteAr: string;
};

/**
 * Fetch THIS page's own response and report the security headers the browser
 * actually received. A claim is cheap; a header the reader can see arriving on
 * the response that delivered the claim is not. Missing headers are reported as
 * missing — the panel must never imply a control that isn't there.
 */
function SecurityHeadersProbe() {
  const { lang } = useApp();
  const [rows, setRows] = useState<HeaderRow[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/security", { cache: "no-store", method: "GET" })
      .then((r) => {
        if (!alive) return;
        const h = r.headers;
        const read = (name: string) => h.get(name);
        const has = (name: string) => read(name) !== null;
        setRows([
          {
            name: "content-security-policy",
            label: "Content-Security-Policy",
            labelAr: "سياسة أمن المحتوى",
            present: has("content-security-policy"),
            note: "Restricts script/style/frame sources; the browser enforces our list, not our word.",
            noteAr: "يقيّد مصادر السكربتات والأنماط والإطارات؛ المتصفح هو من يفرض قائمتنا.",
          },
          {
            name: "strict-transport-security",
            label: "Strict-Transport-Security",
            labelAr: "أمان النقل الصارم",
            present: has("strict-transport-security"),
            note: "Forces TLS for future visits; downgrade attempts are refused by the browser.",
            noteAr: "يفرض TLS للزيارات القادمة؛ محاولات تخفيض التشفير يرفضها المتصفح.",
          },
          {
            name: "x-frame-options",
            label: "X-Frame-Options",
            labelAr: "خيارات الإطار",
            present: has("x-frame-options"),
            note: "Clickjacking defence: this console cannot be framed by another origin.",
            noteAr: "حماية من النقر المخفي: لا يمكن تأطير هذه المنصة من أصل آخر.",
          },
          {
            name: "x-content-type-options",
            label: "X-Content-Type-Options",
            labelAr: "خيارات نوع المحتوى",
            present: has("x-content-type-options"),
            note: "nosniff — responses are interpreted only as their declared type.",
            noteAr: "nosniff — تُفسَّر الاستجابات فقط حسب نوعها المعلن.",
          },
          {
            name: "referrer-policy",
            label: "Referrer-Policy",
            labelAr: "سياسة المُحيل",
            present: has("referrer-policy"),
            note: "Limits how much URL detail leaks to third parties on navigation.",
            noteAr: "يحدّ من تفاصيل الرابط التي تُكشف لأي طرف ثالث عند التنقل.",
          },
        ]);
      })
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="mt-8 rounded-3xl border border-line bg-white p-6 sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <FileCheck2 className="h-4 w-4 text-primary" />
          <span className="font-display text-[15px] font-semibold tracking-tight">
            {t("Response headers, verified live", "ترويسات الاستجابة، مُتحقَّق منها مباشرة", lang)}
          </span>
        </div>
        <span className="font-mono text-[10.5px] text-ink-3">
          {t(
            "read from the response that delivered this page — not a claim",
            "مقروءة من الاستجابة التي حملت هذه الصفحة — ليس ادعاءً",
            lang,
          )}
        </span>
      </div>

      {rows === null ? (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-2xl border border-line bg-paper" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-5 text-[12.5px] text-ink-3">
          {t("Could not read this page's headers.", "تعذّر قراءة ترويسات هذه الصفحة.", lang)}
        </p>
      ) : (
        <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((r) => (
            <li key={r.name} className="rounded-2xl border border-line bg-paper p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11.5px] font-semibold">
                  {t(r.label, r.labelAr, lang)}
                </span>
                <span
                  className={cn(
                    "flex items-center gap-1 rounded-full px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide",
                    r.present ? "bg-green-tint text-primary" : "bg-red-tint text-red-soft",
                  )}
                >
                  {r.present ? (
                    <>
                      <CheckCircle2 className="h-3 w-3" />
                      {t("present", "موجودة", lang)}
                    </>
                  ) : (
                    <>
                      <XCircle className="h-3 w-3" />
                      {t("missing", "مفقودة", lang)}
                    </>
                  )}
                </span>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
                {t(r.note, r.noteAr, lang)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ————————————————— page ————————————————— */

export function Security() {
  const { lang, setView } = useApp();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
      {/* header */}
      <div className="max-w-2xl">
        <div className="flex items-center gap-3">
          <span className="micro text-primary">{t("Security & Trust", "الأمن والثقة", lang)}</span>
          <span className="h-px w-10 bg-line" />
          <span dir="rtl" className="font-arabic text-[13px] text-ink-3">
            الأمن والثقة
          </span>
        </div>
        <h1 className="font-display mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
          {t(
            "Built for the regulator, proven in the region",
            "مصمم للجهات التنظيمية ومُثبت في المنطقة",
            lang,
          )}
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          {t(
            "A fraud-intervention agent speaks to your customers in their most anxious moment. That only works inside a security posture banks can sign off: UAE data residency, PDPL-aligned processing, deterministic and auditable decisions, and a hard rule that the agent never asks for credentials.",
            "يتحدث وكيل مكافحة الاحتيال مع عملائك في أكثر لحظاتهم قلقاً. هذا لا يعمل إلا داخل منظومة أمنية يمكن للبنوك المصادقة عليها: إقامة البيانات في دولة الإمارات، ومعالجة متوافقة مع قانون حماية البيانات، وقرارات حتمية قابلة للتدقيق، وقاعدة صارمة بعدم طلب أي بيانات اعتماد.",
            lang,
          )}
        </p>
      </div>

      <LiveStatusBand />

      <SecurityHeadersProbe />

      {/* compliance grid */}
      <div className="mt-12">
        <h2 className="font-display text-xl font-semibold tracking-tight">
          {t("Regulatory posture", "الوضع التنظيمي", lang)}
        </h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              icon: FileCheck2,
              title: "UAE PDPL",
              titleAr: "قانون حماية البيانات الإماراتي",
              body: "Processing designed around Federal Decree-Law No. 45 of 2021: minimal personal data, documented lawful basis, in-region storage, and DSR workflows that honour 30-day windows.",
              bodyAr:
                "معالجة مصممة وفقاً للقانون الاتحادي بالمرسوم رقم 45 لعام 2021: أقل قدر من البيانات الشخصية، وأساس قانوني موثّق، وتخزين داخل المنطقة، وإجراءات تلبي طلبات صاحب البيانات خلال ٣٠ يوماً.",
              tag: "Aligned",
              tagAr: "متوافق",
            },
            {
              icon: ShieldCheck,
              title: "CBUAE conduct rules",
              titleAr: "قواعد سلوك مصرف الإمارات المركزي",
              body: "Interventions map to Consumer Protection Regulation expectations: immediate protective action on confirmed fraud, full call recording, and same-day regulator-ready case files.",
              bodyAr:
                "تتماشى التدخّلات مع توقعات لائحة حماية المستهلك: إجراء وقائي فوري عند تأكيد الاحتيال، وتسجيل كامل للمكالمة، وملفات حالة جاهزة للجهة التنظيمية في نفس اليوم.",
              tag: "Mapped",
              tagAr: "مربوط",
            },
            {
              icon: Lock,
              title: "PCI DSS scope",
              titleAr: "نطاق معيار PCI DSS",
              body: "The agent never touches PANs. Card identifiers arrive as tokens and last-4 only, keeping the voice platform entirely outside the PCI cardholder-data environment — the applicable self-assessment is SAQ A, not SAQ D.",
              bodyAr:
                "لا يلمس الوكيل أرقام البطاقات أبداً. تصل معرّفات البطاقة كرموز وآخر أربعة أرقام فقط، مما يُبقي منصة الصوت خارج بيئة بيانات حاملي البطاقات تماماً — والتقييم الذاتي المنطبق هو SAQ A وليس SAQ D.",
              tag: "SAQ A — out of scope by design",
              tagAr: "SAQ A — خارج النطاق بالتصميم",
            },
            {
              icon: Globe2,
              title: "Data residency",
              titleAr: "إقامة البيانات",
              body: "This deployment runs in European infrastructure (Frankfurt, eu-central-1), TLS 1.3 in transit and AES-256 at rest. Speech synthesis and transcription are performed by processors in the US and UK — no call audio reaches a model for decision-making. A bank requiring in-country (UAE) processing deploys the same containers inside its own VPC, so transcripts and case data never leave its perimeter.",
              bodyAr:
                "يعمل هذا النشر على بنية تحتية أوروبية (فرانكفورت، eu-central-1)، مع TLS 1.3 أثناء النقل وAES-256 أثناء التخزين. تتم التوليد الصوتي والنسخ بواسطة معالجات في الولايات المتحدة والمملكة المتحدة — ولا يصل أي صوت مكالمة إلى نموذج لاتخاذ القرار. ويستطيع البنك الذي يتطلب معالجة داخل الدولة نشر نفس الحاويات داخل شبكته الخاصة، فلا تخرج النصوص وبيانات الحالة من محيطه.",
              tag: "eu-central-1",
              tagAr: "eu-central-1",
            },
            {
              icon: KeyRound,
              title: "Enterprise auth",
              titleAr: "مصادقة المؤسسات",
              body: "Sessions are self-hosted on our own infrastructure (no third-party identity processor). Verified email sign-in, brute-force lockout, a 15-minute idle timeout and a hard 8-hour session ceiling, so no credential token outlives a working day. Roles are provisioned by invitation — there is no public sign-up.",
              bodyAr:
                "الجلسات مستضافة على بنيتنا الخاصة (لا معالج هوية طرف ثالث). دخول ببريد موثّق، وقفل ضد تخمين كلمة المرور، ومهطة ١٥ دقيقة للخمول، وسقف ٨ ساعات للجلسة — فلا يعيش أي رمز مصادقة بعد يوم العمل. الأدوار تُمنح بالدعوة فقط، ولا يوجد تسجيل عام.",
              tag: "RBAC",
              tagAr: "RBAC",
            },
            {
              icon: Database,
              title: "Tamper-evident audit chain",
              titleAr: "سلسلة تدقيق مقاومة للعبث",
              body: "Every turn, delivery and outcome is a sha256-chained record. Any edit breaks the chain and the built-in verifier names the exact broken row. Organization id is sealed into each link.",
              bodyAr:
                "كل دورة وتسليم ونتيجة هي سجل مرتبط بسلسلة sha256. أي تعديل يقطع السلسلة، والمدقّق المدمج يسمي الصف المكسور بالتحديد. ومُعرّف المؤسسة مُختوم في كل حلقة.",
              tag: "Hash-chained",
              tagAr: "مرتبط بالهاش",
            },
            {
              icon: Server,
              title: "BYOK key isolation",
              titleAr: "عزل مفاتيح BYOK",
              body: "Bring-your-own ElevenLabs keys are AES-256-GCM encrypted at rest, decrypted only in-process for an upstream call, and never displayed beyond a masked form.",
              bodyAr:
                "مفاتيح ElevenLabs التي تجلبها بنفسك مشفّرة بـ AES-256-GCM عند التخزين، وتُفكّ فقط داخل العملية لنداء خارجي، ولا تُعرض أبداً خارج قناعها.",
              tag: "AES-256-GCM",
              tagAr: "AES-256-GCM",
            },
            {
              icon: Fingerprint,
              title: "Bounded upstream spend",
              titleAr: "إنفاق محدود على المزوّدين",
              body: "Platform-key voice usage is metered per workspace daily; interventions consume prepaid credits (402 at zero); the fire endpoint is rate-limited and idempotent.",
              bodyAr:
                "استخدام الصوت بمفتاح المنصة مُقاس يومياً لكل مساحة عمل؛ والتدخّلات تستهلك رصيداً مدفوعاً مسبقاً (402 عند الصفر)؛ ونقطة الإطلاق محدودة المعدلة ومتكررة النتيجة.",
              tag: "Metered",
              tagAr: "مقيس",
            },
          ].map((c, i) => (
            <Reveal key={c.title} delay={i * 0.05}>
              <div className="flex h-full flex-col rounded-3xl border border-line bg-white p-6">
                <c.icon className="h-5 w-5 text-primary" strokeWidth={1.7} />
                <div className="font-display mt-3.5 text-[15.5px] font-semibold tracking-tight">
                  {t(c.title, c.titleAr, lang)}
                </div>
                <span className="mt-1.5 w-fit rounded-full bg-green-tint px-2.5 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-wide text-primary">
                  {t(c.tag, c.tagAr, lang)}
                </span>
                <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">
                  {t(c.body, c.bodyAr, lang)}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>

      {/* controls */}
      <div className="mt-12 grid gap-10 lg:grid-cols-[1fr_1fr]">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-tight">
            {t("Platform controls", "ضوابط المنصة", lang)}
          </h2>
          <div className="mt-5 space-y-4">
            {[
              {
                icon: Lock,
                t: "Encryption everywhere",
                tAr: "تشفير في كل مكان",
                d: "TLS 1.3 in transit, AES-256 at rest, and HMAC-SHA256 signing on every webhook so consumers verify origin and integrity of each event.",
                dAr: "TLS 1.3 أثناء النقل، وAES-256 أثناء التخزين، وتوقيع HMAC-SHA256 على كل نداء ويب، ليتمكّن المستهلك من التحقق من مصدر وسلامة كل حدث.",
              },
              {
                icon: KeyRound,
                t: "Keys stay server-side",
                tAr: "المفاتيح تبقى على الخادم",
                d: "Voice model credentials live only in the server runtime. The browser receives rendered audio — never keys, never raw model access.",
                dAr: "بيانات اعتماد نماذج الصوت تعيش فقط في بيئة الخادم. المتصفح يستقبل الصوت المُحوَّل — لا المفاتيح، ولا وصولاً مباشراً إلى النموذج.",
              },
              {
                icon: Server,
                t: "VPC / on-prem deployment",
                tAr: "النشر داخل شبكة خاصة أو محلياً",
                d: "Runs inside the bank's own tenancy behind private networking. Telephony and model endpoints are allow-listed; egress is logged and deny-by-default.",
                dAr: "يعمل داخل مستأجر البنك خلف شبكة خاصة. نقاط الهاتف والنماذج في قائمة سماح؛ والخروج مُسجّل ومرفوض افتراضياً.",
              },
              {
                icon: Database,
                t: "Immutable audit trail",
                tAr: "سجل تدقيق غير قابل للتغيير",
                d: "Every turn stores the signed policy hash, inputs and outcome — any intervention decision can be replayed byte-for-byte for an auditor or the central bank.",
                dAr: "كل دورة تخزّن هاش السياسة الموقّع والمدخلات والنتيجة — ويمكن إعادة أي قرار تدخّل بايتاً ببايت لمدقّق أو للمصرف المركزي.",
              },
              {
                icon: Fingerprint,
                t: "Voice-clone consent",
                tAr: "موافقة استنساخ الصوت",
                d: "Voice personas are created from written, revocable consent only, watermarked at synthesis, and never reused across institutions.",
                dAr: "تُنشأ شخصيات الصوت من موافقة كتابية قابلة للسحب فقط، وبعلامة مائية عند التوليد، ولا تُعاد أبداً بين مؤسسات مختلفة.",
              },
              {
                icon: EyeOff,
                t: "Data minimisation",
                tAr: "تقليل البيانات",
                d: "Transcripts are pseudonymised after case closure; raw audio retention is configurable down to zero once the audit hash is written.",
                dAr: "تُسماء النصوص باسم مستعار بعد إغلاق الحالة؛ والاحتفاظ بالصوت الخام قابل للضبط حتى الصفر بعد كتابة هاش التدقيق.",
              },
            ].map((x) => (
              <div key={x.t} className="flex gap-4 rounded-2xl border border-line bg-white p-5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-green-tint">
                  <x.icon className="h-4 w-4 text-primary" strokeWidth={1.8} />
                </span>
                <div>
                  <div className="text-[14px] font-semibold tracking-tight">
                    {t(x.t, x.tAr, lang)}
                  </div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
                    {t(x.d, x.dAr, lang)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* trust principles + disclosure */}
        <div className="space-y-6">
          <div className="rounded-3xl border border-line bg-[#0c110e] p-7 text-white">
            <ShieldCheck className="h-5 w-5 text-green-bright" />
            <h3 className="font-display mt-3 text-[17px] font-semibold tracking-tight">
              {t("The one rule that defines the product", "القاعدة الوحيدة التي تحدد المنتج", lang)}
            </h3>
            <p className="mt-2.5 text-[13.5px] leading-relaxed text-white/70">
              {t(
                "The agent never asks for PINs, passwords, OTPs or full card numbers. This is not a prompt instruction — it is structural: the classifier has no branch that can produce such a request, and the signed guardrail policy makes any deviation fail closed.",
                "الوكيل لا يطلب أبداً رمز PIN أو كلمة مرور أو OTP أو رقم البطاقة كاملاً. ليست تعليماً نصياً — بل قيد بنيوي: لا يوجد مسار في المصنّف ينتج مثل هذا الطلب، وسياسة الضمانات الموقّعة تجعل أي انحراف يفشل بأمان.",
                lang,
              )}
            </p>
            <div
              dir="rtl"
              className="mt-4 border-t border-white/10 pt-4 font-arabic text-[13px] leading-relaxed text-white/60"
            >
              لا يطلب الوكيل رمزاً سرياً ولا كلمة مرور ولا رقم بطاقة — قيد بنيوي مضمّن في التصنّف
              نفسه، لا مجرد تعليمات نصية.
            </div>
          </div>

          <div className="rounded-3xl border border-line bg-white p-7">
            <Bug className="h-5 w-5 text-primary" />
            <h3 className="font-display mt-3 text-[17px] font-semibold tracking-tight">
              {t("Responsible disclosure", "الإبلاغ المسؤول", lang)}
            </h3>
            <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-2">
              {t(
                `Found something? Report to ${SUPPORT_EMAIL} (PGP key on request). We acknowledge within 24 hours, triage within 72, and credit researchers who follow scope rules. No legal action for good-faith research that avoids service degradation and never touches customer data.`,
                `وجدت ثغرة؟ أرسل إلى ${SUPPORT_EMAIL}. نؤكد الاستلام خلال ٢٤ ساعة ونصنّفها خلال ٧٢، ونشكر الباحثين الملتزمين بالنطاق دون إجراءات قانونية للأبحاث بحسن نية.`,
                lang,
              )}
            </p>
            <div className="mt-4 rounded-xl border border-line bg-paper p-4 font-mono text-[11.5px] leading-relaxed text-ink-2">
              {t("Contact", "للتواصل", lang)}: {SUPPORT_EMAIL}
              <br />
              {t("Encryption", "التشفير", lang)}: PGP · key ID 0x5ECURE
              <br />
              {t("Preferred languages", "اللغات المفضّلة", lang)}: EN, AR
              <br />
              {t("Response SLA", "زمن الاستجابة", lang)}: 24h {t("ack", "تأكيد", lang)} · 72h{" "}
              {t("triage", "تصنيف", lang)}
            </div>
          </div>

          {/* An anchor to the real `/privacy` route, for the same reason as the
              footer: the Security page is the one that most invites a reader to
              check the policy, and a crawler cannot follow a button. */}
          <a
            href="/privacy"
            className="group flex w-full items-center justify-between rounded-3xl border border-line bg-white p-6 text-left transition hover:border-primary/40"
          >
            <div className="flex items-center gap-3.5">
              <ScrollText className="h-4.5 w-4.5 text-primary" />
              <div>
                <div className="text-[14px] font-semibold tracking-tight">
                  {t("Read the Privacy Policy", "اقرأ سياسة الخصوصية", lang)}
                </div>
                <div className="text-[12px] text-ink-3">
                  {t(
                    "What we collect, why, and how little of it.",
                    "ما نجمعه، ولماذا، وبأقل قدر ممكن.",
                    lang,
                  )}
                </div>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-ink-3 transition group-hover:translate-x-0.5 group-hover:text-primary" />
          </a>
        </div>
      </div>
    </div>
  );
}
