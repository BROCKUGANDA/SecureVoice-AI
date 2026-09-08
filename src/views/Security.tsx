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
  Bug,
  EyeOff,
  ScrollText,
  ArrowRight,
  HeartPulse,
} from "lucide-react";
import { useApp, t } from "@/lib/store";
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
        { label: t("Database round-trip", "زمن قاعدة البيانات", lang), value: `${status.dbLatencyMs ?? "—"} ms` },
        { label: t("Region", "المنطقة", lang), value: status.region },
        { label: t("Build", "الإصدار", lang), value: `v${status.version}` },
        { label: t("Memory footprint", "استهلاك الذاكرة", lang), value: status.rssMb ? fmtMem(status.rssMb) : "—" },
      ]
    : [
        { label: t("API service", "خدمة الواجهة", lang), value: t("Probing…", "جارٍ الفحص…", lang) },
        { label: t("Database round-trip", "زمن قاعدة البيانات", lang), value: "—" },
        { label: t("Region", "المنطقة", lang), value: "—" },
        { label: t("Build", "الإصدار", lang), value: "—" },
        { label: t("Memory footprint", "استهلاك الذاكرة", lang), value: "—" },
      ];

  return (
    <div className={cn(
      "mt-8 rounded-3xl border p-6 sm:p-7",
      err ? "border-red-200 bg-red-50/60" : "border-line bg-white"
    )}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <HeartPulse className={cn("h-4 w-4", err ? "text-red-600" : "text-primary")} />
          <span className="font-display text-[15px] font-semibold tracking-tight">
            {t("Live platform status", "حالة المنصة المباشرة", lang)}
          </span>
        </div>
        <span className="font-mono text-[10.5px] text-ink-3">
          {t("measured on this page, every 20s — not a mock", "قياس حقيقي كل ٢٠ ثانية — ليس عرضاً", lang)}
        </span>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-5">
        {cells.map((c) => (
          <div key={c.label}>
            <div className="micro text-[9px] text-ink-3">{c.label.toUpperCase()}</div>
            <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[13px] font-semibold">
              {c.pulse && <span className="sv-pulse-ring h-2 w-2 rounded-full bg-primary" />}
              <span className={cn(err && c.label.includes("service") && "text-red-600")}>{c.value}</span>
            </div>
          </div>
        ))}
      </div>
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
          <span className="micro text-primary">Security &amp; Trust</span>
          <span className="h-px w-10 bg-line" />
          <span dir="rtl" className="font-arabic text-[13px] text-ink-3">الأمن والثقة</span>
        </div>
        <h1 className="font-display mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
          {t("Built for the regulator, proven in the region", "مصمم للجهات التنظيمية ومُثبت في المنطقة", lang)}
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
          {t(
            "A fraud-intervention agent speaks to your customers in their most anxious moment. That only works inside a security posture banks can sign off: UAE data residency, PDPL-aligned processing, deterministic and auditable decisions, and a hard rule that the agent never asks for credentials.",
            "يتحدث وكيل مكافحة الاحتيال مع عملائك في أكثر لحظاتهم قلقاً. هذا لا يعمل إلا داخل منظومة أمنية يمكن للبنوك المصادقة عليها: إقامة البيانات في دولة الإمارات، ومعالجة متوافقة مع قانون حماية البيانات، وقرارات حتمية قابلة للتدقيق، وقاعدة صارمة بعدم طلب أي بيانات اعتماد.",
            lang
          )}
        </p>
      </div>

      <LiveStatusBand />

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
              body: "Processing designed around Federal Decree-Law No. 45 of 2021: minimal personal data, documented lawful basis, in-region storage, and DSR workflows that honour 30-day windows.",
              tag: "Aligned",
            },
            {
              icon: ShieldCheck,
              title: "CBUAE conduct rules",
              body: "Interventions map to Consumer Protection Regulation expectations: immediate protective action on confirmed fraud, full call recording, and same-day regulator-ready case files.",
              tag: "Mapped",
            },
            {
              icon: Lock,
              title: "PCI DSS scope",
              body: "The agent never touches PANs. Card identifiers arrive as tokens and last-4 only, keeping the voice platform outside the PCI cardholder-data environment entirely.",
              tag: "Out of scope by design",
            },
            {
              icon: Globe2,
              title: "Data residency",
              body: "All speech, transcripts and case data stay in-country (me-central-1) — inside your tenancy for VPC deployments. Nothing crosses the border, including model prompts.",
              tag: "me-central-1",
            },
            {
              icon: KeyRound,
              title: "Enterprise auth",
              body: "Sessions run on Clerk: verified email/phone sign-in, brute-force lockout, and a 15-minute idle-timeout guard. Roles are provisioned — there is no public sign-up.",
              tag: "RBAC",
            },
            {
              icon: Database,
              title: "Tamper-evident audit chain",
              body: "Every turn, delivery and outcome is a sha256-chained record. Any edit breaks the chain and the built-in verifier names the exact broken row. Organization id is sealed into each link.",
              tag: "Hash-chained",
            },
            {
              icon: Server,
              title: "BYOK key isolation",
              body: "Bring-your-own ElevenLabs keys are AES-256-GCM encrypted at rest, decrypted only in-process for an upstream call, and never displayed beyond a masked form.",
              tag: "AES-256-GCM",
            },
            {
              icon: Fingerprint,
              title: "Bounded upstream spend",
              body: "Platform-key voice usage is metered per workspace daily; interventions consume prepaid credits (402 at zero); the fire endpoint is rate-limited and idempotent.",
              tag: "Metered",
            },
          ].map((c, i) => (
            <Reveal key={c.title} delay={i * 0.05}>
              <div className="flex h-full flex-col rounded-3xl border border-line bg-white p-6">
                <c.icon className="h-5 w-5 text-primary" strokeWidth={1.7} />
                <div className="font-display mt-3.5 text-[15.5px] font-semibold tracking-tight">{c.title}</div>
                <span className="mt-1.5 w-fit rounded-full bg-green-tint px-2.5 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-wide text-primary">
                  {c.tag}
                </span>
                <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">{c.body}</p>
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
                d: "TLS 1.3 in transit, AES-256 at rest, and HMAC-SHA256 signing on every webhook so consumers verify origin and integrity of each event.",
              },
              {
                icon: KeyRound,
                t: "Keys stay server-side",
                d: "Voice model credentials live only in the server runtime. The browser receives rendered audio — never keys, never raw model access.",
              },
              {
                icon: Server,
                t: "VPC / on-prem deployment",
                d: "Runs inside the bank's own tenancy behind private networking. Telephony and model endpoints are allow-listed; egress is logged and deny-by-default.",
              },
              {
                icon: Database,
                t: "Immutable audit trail",
                d: "Every turn stores the signed policy hash, inputs and outcome — any intervention decision can be replayed byte-for-byte for an auditor or the central bank.",
              },
              {
                icon: Fingerprint,
                t: "Voice-clone consent",
                d: "Voice personas are created from written, revocable consent only, watermarked at synthesis, and never reused across institutions.",
              },
              {
                icon: EyeOff,
                t: "Data minimisation",
                d: "Transcripts are pseudonymised after case closure; raw audio retention is configurable down to zero once the audit hash is written.",
              },
            ].map((x) => (
              <div key={x.t} className="flex gap-4 rounded-2xl border border-line bg-white p-5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-green-tint">
                  <x.icon className="h-4 w-4 text-primary" strokeWidth={1.8} />
                </span>
                <div>
                  <div className="text-[14px] font-semibold tracking-tight">{x.t}</div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{x.d}</p>
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
                lang
              )}
            </p>
            <div dir="rtl" className="mt-4 border-t border-white/10 pt-4 font-arabic text-[13px] leading-relaxed text-white/60">
              لا يطلب الوكيل رمزاً سرياً ولا كلمة مرور ولا رقم بطاقة — قيد بنيوي مضمّن في التصنّف نفسه، لا مجرد تعليمات نصية.
            </div>
          </div>

          <div className="rounded-3xl border border-line bg-white p-7">
            <Bug className="h-5 w-5 text-primary" />
            <h3 className="font-display mt-3 text-[17px] font-semibold tracking-tight">
              {t("Responsible disclosure", "الإبلاغ المسؤول", lang)}
            </h3>
            <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink-2">
              {t(
                "Found something? Report to otemaach@gmail.com (PGP key on request). We acknowledge within 24 hours, triage within 72, and credit researchers who follow scope rules. No legal action for good-faith research that avoids service degradation and never touches customer data.",
                "وجدت ثغرة؟ أرسل إلى otemaach@gmail.com. نؤكد الاستلام خلال ٢٤ ساعة ونصنّفها خلال ٧٢، ونشكر الباحثين الملتزمين بالنطاق دون إجراءات قانونية للأبحاث بحسن نية.",
                lang
              )}
            </p>
            <div className="mt-4 rounded-xl border border-line bg-paper p-4 font-mono text-[11.5px] leading-relaxed text-ink-2">
              Contact: otemaach@gmail.com<br />
              Encryption: PGP · key ID 0x5ECURE<br />
              Preferred languages: EN, AR<br />
              Response SLA: 24h ack · 72h triage
            </div>
          </div>

          <button
            onClick={() => setView("privacy")}
            className="group flex w-full items-center justify-between rounded-3xl border border-line bg-white p-6 text-left transition hover:border-primary/40"
          >
            <div className="flex items-center gap-3.5">
              <ScrollText className="h-4.5 w-4.5 text-primary" />
              <div>
                <div className="text-[14px] font-semibold tracking-tight">
                  {t("Read the Privacy Policy", "اقرأ سياسة الخصوصية", lang)}
                </div>
                <div className="text-[12px] text-ink-3">
                  {t("What we collect, why, and how little of it.", "ما نجمعه، ولماذا، وبأقل قدر ممكن.", lang)}
                </div>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-ink-3 transition group-hover:translate-x-0.5 group-hover:text-primary" />
          </button>
        </div>
      </div>
    </div>
  );
}
