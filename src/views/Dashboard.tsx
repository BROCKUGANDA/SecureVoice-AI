"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  LayoutDashboard,
  PhoneCall,
  BarChart3,
  SlidersHorizontal,
  ScrollText,
  Download,
  Snowflake,
  ShieldCheck,
  Languages,
  Timer,
  Search,
  Webhook,
  XCircle,
  BookOpen,
  Wrench,
  Boxes,
  Workflow,
} from "lucide-react";
import { useApp, t } from "@/lib/store";
import { RECENT_CALLS, AUDIT_LOG, KPIS, LANG_DIST, OUTCOME_DIST, TREND, VOICES } from "@/lib/data";
import { StatusPill, LiveDot, Skeleton, Chip } from "@/components/fx/core";
import { Counter } from "@/components/fx/core";
import { TrendChart, HBars, Donut, Gauge, CompareBar, Sparkline } from "@/components/fx/charts";
import { Pagination } from "@/components/fx/Pagination";
import { RecordingPlayer } from "@/components/dashboard/RecordingPlayer";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { WorkflowGraph } from "./WorkflowGraph";

type ProvidedWebhook = {
  id: string;
  label: string;
  description: string;
  path: string;
  url: string;
  method: string;
  auth: string;
};

function copyText(text: string, toast: ReturnType<typeof useToast>["toast"]) {
  const { lang } = useApp.getState();
  void navigator.clipboard.writeText(text).then(() => {
    toast({ title: t("Copied", "تم النسخ", lang), description: text });
  });
}

/**
 * The webhook list is FETCHED from /api/operator/webhooks rather than restated
 * here. That route is the machine-readable source of truth — the same one an
 * integrator scripts against — and a second hardcoded copy in the UI is a list
 * that is correct until the route changes. Fetching means the dashboard cannot
 * show an endpoint the platform does not actually serve.
 *
 * The origin is rebuilt client-side from `window.location.origin` when the API
 * answers with a placeholder: behind a proxy the server's own notion of the
 * public origin is exactly the thing that is wrong, so a literal copy-paste
 * would hand the operator a dead URL.
 */
function WebhookConfigSection() {
  const { lang } = useApp();
  const { toast } = useToast();
  const [hooks, setHooks] = useState<ProvidedWebhook[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/operator/webhooks", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { webhooks?: ProvidedWebhook[] }) => {
        if (cancelled) return;
        const list = d.webhooks ?? [];
        setHooks(
          list.map((h) => ({
            ...h,
            // Substitute the live origin so the copied string is one the
            // operator can paste into Twilio right now.
            url: h.url.startsWith("https://your-app.com")
              ? `${window.location.origin}${h.path}`
              : h.url,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-5">
      <div className="rounded-3xl border border-line bg-white p-6">
        <h2 className="font-display text-[17px] font-semibold tracking-tight">
          {t("Provided webhooks", "خطافات الأحداث المتوفرة", lang)}
        </h2>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-ink-2">
          {t(
            "Use these endpoints to integrate SecureVoice with your fraud engine, CRM, core banking, insurer systems, Twilio, and operator consoles.",
            "استخدم هذه النقاط للتكامل مع محرك الاحتيال أو CRM أو الأنظمة الأساسية أو أنظمة التأمين أو Twilio أو لوحات المشغل.",
            lang,
          )}
        </p>

        {!hooks && !error && (
          <p className="mt-4 text-[12.5px] text-ink-3">
            {t("Loading endpoints…", "جارٍ تحميل النقاط…", lang)}
          </p>
        )}

        {error && (
          <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[12.5px] text-red-700">
            {t(
              "Could not load the endpoint list. GET /api/operator/webhooks directly.",
              "تعذر تحميل قائمة النقاط. استدعِ GET /api/operator/webhooks مباشرة.",
              lang,
            )}
          </p>
        )}

        <div className="mt-4 space-y-3">
          {hooks?.map((item) => (
            <div
              key={item.id}
              className="flex flex-col gap-2 rounded-2xl border border-line bg-paper px-4 py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[12.5px] font-semibold text-foreground">{item.label}</div>
                  <div className="text-[11.5px] text-ink-3">{item.description}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full border border-line bg-white px-2.5 py-1 font-mono text-[10.5px] text-ink-3">
                    {item.method}
                  </span>
                  <span className="rounded-full bg-green-50 px-2.5 py-1 font-mono text-[10.5px] text-green-700">
                    {item.auth}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-xl bg-[#0c110e] px-3 py-2 font-mono text-[11.5px] text-white/85">
                  {item.url}
                </code>
                <button
                  onClick={() => copyText(item.url, toast)}
                  className="shrink-0 rounded-full border border-line bg-white px-3 py-2 text-[12px] font-semibold transition hover:bg-paper"
                >
                  {t("Copy", "نسخ", lang)}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const TABS = [
  { id: "monitor", en: "Call Monitor", ar: "مراقبة المكالمات", icon: PhoneCall },
  { id: "analytics", en: "Analytics", ar: "التحليلات", icon: BarChart3 },
  { id: "config", en: "Configuration", ar: "الإعدادات", icon: SlidersHorizontal },
  { id: "compliance", en: "Compliance", ar: "الامتثال", icon: ScrollText },
  { id: "webhooks", en: "Webhooks", ar: "التوقيع", icon: Webhook },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function Dashboard() {
  const { lang } = useApp();
  const [tab, setTab] = useState<TabId>("monitor");

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <span className="micro text-primary">
              {t("Agent operations", "عمليات الوكيل", lang)}
            </span>
            <span className="h-px w-10 bg-line" />
            <span dir="rtl" className="font-arabic text-[13px] text-ink-3">
              لوحة العمليات
            </span>
          </div>
          <h1 className="font-display mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            {t("Agent Management Dashboard", "لوحة إدارة الوكلاء", lang)}
          </h1>
        </div>
        <div className="flex items-center gap-2.5 rounded-full border border-line bg-white px-3.5 py-2">
          <LiveDot />
          <span className="text-[12px] font-medium text-ink-2">
            {t(
              "Demo bank · mock environment · all systems nominal",
              "مصرف تجريبي · بيئة محاكاة · جميع الأنظمة تعمل بكفاءة",
              lang,
            )}
          </span>
        </div>
      </div>

      {/* tabs */}
      <div className="mt-8 flex gap-1 overflow-x-auto rounded-2xl border border-line bg-white p-1 sv-scroll">
        {TABS.map((x) => (
          <button
            key={x.id}
            onClick={() => setTab(x.id)}
            className={cn(
              "relative flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-semibold transition",
              tab === x.id ? "text-white" : "text-ink-2 hover:text-foreground",
            )}
          >
            {tab === x.id && (
              <motion.span
                layoutId="dash-tab"
                className="absolute inset-0 rounded-xl bg-[#0c110e]"
                transition={{ type: "spring", stiffness: 400, damping: 34 }}
              />
            )}
            <x.icon className={cn("relative h-4 w-4", tab === x.id && "text-green-bright")} />
            <span className="relative whitespace-nowrap">{t(x.en, x.ar, lang)}</span>
          </button>
        ))}
      </div>

      <motion.div
        key={tab}
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="mt-6"
      >
        {tab === "monitor" && <Monitor />}
        {tab === "analytics" && <Analytics />}
        {tab === "config" && <Config />}
        {tab === "compliance" && <Compliance />}
        {tab === "webhooks" && (
          <div className="space-y-6">
            <WebhookConfigSection />
            <WebhooksDemo />
          </div>
        )}
      </motion.div>
    </div>
  );
}

/* ————————————————— MONITOR ————————————————— */

const OUTCOME_MAP: Record<
  string,
  { tone: "green" | "red" | "amber" | "gray"; en: string; ar: string }
> = {
  prevented: { tone: "green", en: "Fraud prevented", ar: "تم منع الاحتيال" },
  false_alarm: { tone: "gray", en: "False alarm", ar: "إنذار كاذب" },
  handoff: { tone: "amber", en: "Handoff", ar: "تسليم لأخصائي" },
  no_answer: { tone: "red", en: "No answer", ar: "لا يوجد رد" },
};

function Monitor() {
  const { lang } = useApp();
  const live = RECENT_CALLS[0];
  // Which row owns audio playback. Held here rather than inside each player so
  // the "only one recording plays at a time" rule has a single owner — see
  // RecordingPlayer.
  const [playingId, setPlayingId] = useState<string | null>(null);
  return (
    <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
      {/* live call */}
      <div className="overflow-hidden rounded-3xl border border-primary/30 bg-white shadow-[0_18px_44px_-28px_rgba(11,122,85,0.5)]">
        <div className="flex items-center justify-between bg-[#0c110e] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <LiveDot className="text-green-bright" />
            <span className="micro !text-[9.5px] text-white/70">
              {t("Active call", "مكالمة نشطة", lang)} · SV-8642
            </span>
          </div>
          <span className="num rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-semibold text-white">
            00:41
          </span>
        </div>
        <div className="px-5 py-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="font-display text-lg font-semibold">{live.customer}</p>
              <p className="num mt-1 text-[11px] text-ink-3">
                +971 •• ••• 4567 · {live.lang} · {t("card", "بطاقة", lang)} ••4417
              </p>
            </div>
            <StatusPill tone="red">{t("risk", "درجة الخطر", lang)} 0.94</StatusPill>
          </div>

          {/* state timeline */}
          <div className="mt-5 space-y-2.5">
            {[
              { en: "Alert received", ar: "تم استلام التنبيه", ok: true, t: "0.0s" },
              { en: "Call connected", ar: "تم توصيل المكالمة", ok: true, t: "1.2s" },
              { en: "Identity verified", ar: "تم التحقق من الهوية", ok: true, t: "33s" },
              { en: "Fraud confirmed", ar: "تم تأكيد الاحتيال", ok: true, t: "44s" },
              { en: "Card freeze executed", ar: "تم تنفيذ تجميد البطاقة", ok: true, t: "50s" },
              { en: "Warm handoff", ar: "تسليم مباشر", ok: false, t: "…" },
            ].map((r) => (
              <div key={r.en} className="flex items-center gap-2.5 text-[12.5px]">
                <span
                  className={cn(
                    "flex h-4 w-4 items-center justify-center rounded-full border",
                    r.ok ? "border-primary bg-primary" : "border-line bg-white",
                  )}
                >
                  {r.ok && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                </span>
                <span className={r.ok ? "text-foreground" : "text-ink-3"}>
                  {t(r.en, r.ar, lang)}
                </span>
                <span className="num ml-auto text-[10.5px] text-ink-3">{r.t}</span>
              </div>
            ))}
          </div>

          <div className="mt-5 flex items-center gap-2 rounded-xl bg-green-tint px-3.5 py-2.5">
            <Snowflake className="h-3.5 w-3.5 text-green-deep" />
            <span className="text-[12px] font-medium text-green-deep">
              {t(
                "Temporary freeze active on ••4417 — reversible after case review",
                "تجميد مؤقت نشط على ••4417 — قابل للإلغاء بعد مراجعة الحالة",
                lang,
              )}
            </span>
          </div>
        </div>
      </div>

      {/* recent calls table */}
      <div className="rounded-3xl border border-line bg-white">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex items-center gap-2.5">
            <LayoutDashboard className="h-4 w-4 text-primary" />
            <h3 className="text-[14px] font-semibold">
              {t("Recent intervention calls", "مكالمات التدخل الأخيرة", lang)}
            </h3>
          </div>
          <Chip>{t("last 2 hrs · mock data", "آخر ساعتين · بيانات تجريبية", lang)}</Chip>
        </div>
        <div className="sv-scroll max-h-[430px] overflow-y-auto">
          <table className="w-full text-left text-[12.5px]">
            <thead className="sticky top-0 bg-paper">
              <tr className="micro !text-[9px] text-ink-3">
                <th className="px-5 py-2.5 font-medium">{t("ID", "المعرّف", lang)}</th>
                <th className="px-2 py-2.5 font-medium">{t("Customer", "العميل", lang)}</th>
                <th className="px-2 py-2.5 font-medium">{t("Lang", "اللغة", lang)}</th>
                <th className="px-2 py-2.5 font-medium">{t("Trigger", "المُشغّل", lang)}</th>
                <th className="px-2 py-2.5 font-medium">{t("Outcome", "النتيجة", lang)}</th>
                <th className="px-2 py-2.5 font-medium">{t("Recording", "التسجيل", lang)}</th>
                <th className="px-5 py-2.5 text-right font-medium">{t("CSAT", "الرضا", lang)}</th>
              </tr>
            </thead>
            <tbody>
              {RECENT_CALLS.map((c) => {
                const o = OUTCOME_MAP[c.outcome];
                return (
                  <tr key={c.id} className="border-t border-line/70 transition hover:bg-paper/70">
                    <td className="num px-5 py-3 text-ink-3">{c.id}</td>
                    <td className="px-2 py-3 font-medium">{c.customer}</td>
                    <td className="num px-2 py-3 text-ink-2">{c.lang}</td>
                    <td className="max-w-[190px] truncate px-2 py-3 text-ink-2" title={c.trigger}>
                      {c.trigger}
                    </td>
                    <td className="px-2 py-3">
                      <StatusPill tone={o.tone}>{t(o.en, o.ar, lang)}</StatusPill>
                    </td>
                    <td className="px-2 py-3">
                      <RecordingPlayer
                        src={c.recordingUrl}
                        caseId={c.id}
                        playingId={playingId}
                        onPlay={setPlayingId}
                      />
                    </td>
                    <td className="num px-5 py-3 text-right text-ink-2">
                      {c.csat ? c.csat.toFixed(1) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ————————————————— ANALYTICS ————————————————— */

/** 12-week x-axis labels for the prevented-loss trend chart */
const WEEKS = Array.from({ length: 12 }, (_, i) => ({ en: `W${i + 1}`, ar: `أ${i + 1}` }));

function Analytics() {
  const { lang } = useApp();
  return (
    <div className="space-y-5">
      {/* KPI cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {KPIS.map((k, i) => {
          const pctGood =
            k.good === "up" ? (k.current / k.target) * 100 : (k.baseline / k.current) * 100;
          return (
            <motion.div
              key={k.key}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06, duration: 0.45 }}
              className="rounded-2xl border border-line bg-white p-5"
            >
              <div className="flex items-center justify-between">
                <p className="text-[12px] font-medium text-ink-2">{t(k.en, k.ar, lang)}</p>
                {k.key === "delay" && <Timer className="h-3.5 w-3.5 text-ink-3" />}
                {k.key === "csat" && <Languages className="h-3.5 w-3.5 text-ink-3" />}
                {k.key === "prevention" && <ShieldCheck className="h-3.5 w-3.5 text-ink-3" />}
                {k.key === "verify" && <Webhook className="h-3.5 w-3.5 text-ink-3" />}
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <Counter
                  to={k.current}
                  decimals={k.key === "csat" ? 1 : 0}
                  className="text-[30px] font-semibold tracking-tight"
                />
                <span className="num text-[12px] text-ink-3">{k.unit}</span>
                <span
                  className={cn(
                    "num ml-auto rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
                    k.good === "up"
                      ? "bg-green-tint text-green-deep"
                      : "bg-amber-tint text-amber-soft",
                  )}
                >
                  {t("base", "الأساس", lang)} {k.baseline}
                  {k.unit === "s" && k.baseline >= 60 ? "m→" : k.unit}
                </span>
              </div>
              <div className="mt-3">
                <Sparkline data={TREND.map((v) => v * (0.7 + i * 0.1))} up={k.good === "up"} />
              </div>
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-secondary">
                <motion.div
                  className="h-full rounded-full bg-primary"
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(100, pctGood)}%` }}
                  transition={{ duration: 1, delay: 0.3 }}
                />
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* charts row */}
      <div className="grid gap-5 lg:grid-cols-[1.25fr_0.75fr]">
        <div className="rounded-3xl border border-line bg-white p-5 sm:p-6">
          <div className="flex items-baseline justify-between">
            <h3 className="text-[14px] font-semibold">
              {t(
                "Prevented losses · 12 weeks (AED K)",
                "الخسائر المُنعّة · 12 أسبوعاً (ألف درهم)",
                lang,
              )}
            </h3>
            <span className="num text-[11px] text-green-deep">
              {t("+172% since launch", "+172% منذ الإطلاق", lang)}
            </span>
          </div>
          <TrendChart
            data={[...TREND]}
            labels={WEEKS.map((w) => t(w.en, w.ar, lang))}
            className="mt-4"
          />
        </div>
        <div className="rounded-3xl border border-line bg-white p-5 sm:p-6">
          <h3 className="text-[14px] font-semibold">
            {t("Call outcomes", "نتائج المكالمات", lang)}
          </h3>
          <div className="mt-4 flex items-center justify-center">
            <Donut items={OUTCOME_DIST} />
          </div>
          <div className="mt-5 space-y-2">
            {OUTCOME_DIST.map((o) => (
              <div key={o.label} className="flex items-center gap-2.5 text-[12px]">
                <span className="h-2.5 w-2.5 rounded-[4px]" style={{ background: o.color }} />
                <span className="text-ink-2">{t(o.label, o.labelAr, lang)}</span>
                <span className="num ml-auto font-semibold">{o.pct}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* language + gauges */}
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-3xl border border-line bg-white p-5 sm:p-6">
          <h3 className="text-[14px] font-semibold">
            {t("Calls by customer language", "توزيع المكالمات حسب لغة العميل", lang)}
          </h3>
          <HBars
            items={LANG_DIST.map((l) => ({ label: t(l.lang, l.langAr, lang), pct: l.pct }))}
            className="mt-5"
          />
        </div>
        <div className="rounded-3xl border border-line bg-white p-5 sm:p-6">
          <h3 className="text-[14px] font-semibold">
            {t("Verification quality", "جودة التحقق", lang)}
          </h3>
          <div className="mt-2 grid grid-cols-2 gap-4">
            <div className="flex flex-col items-center pt-4">
              <Gauge pct={87} label={t("challenge pass", "نجاح التحدي", lang)} />
            </div>
            <div className="flex flex-col items-center pt-4">
              <Gauge pct={93} label={t("language lock held", "تثبيت اللغة", lang)} />
            </div>
          </div>
          <div className="mt-4 rounded-xl bg-paper px-4 py-3 text-[12px] leading-relaxed text-ink-2">
            {t(
              "Zero PIN/password request attempts across",
              "صفر محاولات لطلب الرموز السرية أو كلمات المرور في",
              lang,
            )}{" "}
            <span className="num font-semibold">1,284</span>{" "}
            {t(
              "calls · 30-day window. Guardrail violations:",
              "مكالمة · نافذة 30 يوماً. مخالفات الضوابط:",
              lang,
            )}{" "}
            <span className="num font-semibold text-green-deep">0</span>.
          </div>
        </div>
      </div>
    </div>
  );
}

/* ————————————————— CONFIG ————————————————— */

const GUARDRAILS = [
  { en: "Block PIN / password requests", ar: "منع طلب الرموز السرية", on: true },
  { en: "Pre-approved actions only (freeze)", ar: "إجراءات معتمدة فقط", on: true },
  { en: "Language lock after first response", ar: "تثبيت اللغة", on: true },
  { en: "Seal immutable audit log", ar: "سجل تدقيق غير قابل للتغيير", on: true },
  { en: "Calling-hour compliance check", ar: "التحقق من أوقات الاتصال", on: true },
  { en: "Distress detection → priority handoff", ar: "اكتشاف الضيق", on: true },
];

/**
 * Knowledge Base + RAG and Tools & Actions — the agent's KNOWLEDGE and
 * CAPABILITY surfaces, rendered from the operator manifest.
 *
 * Fetched ONCE from /api/operator/manifest (a rate-limited route): the same
 * machine-readable truth an integrator could script against, per the
 * WebhookConfigSection precedent — no second hardcoded copy here. This is the
 * BYOK dashboard promise made visible: which documents ground the agent, and
 * which tools it can reach, bounded by the trust context that stops an agent
 * serving an untrusted caller from a privileged action.
 */
type ManifestTool = {
  name: string;
  label: string;
  backend: string;
  description: string;
  scoping: string;
  trust: string;
  trust_note: string;
};

type AgentManifest = {
  knowledge_base: Array<{
    title: string;
    lang: string;
    version: string;
    scope: string;
  }>;
  rag: { max_vector_distance: number; note: string };
  tools: ManifestTool[];
  mcp: { endpoint: string; note: string };
};

function AgentCapabilitiesSection() {
  const { lang } = useApp();
  const [data, setData] = useState<AgentManifest | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/operator/manifest", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: AgentManifest) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-5 lg:col-span-2">
      {/* Knowledge base + RAG + source attribution */}
      <div className="rounded-3xl border border-line bg-white p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-primary" />
          <h3 className="text-[14px] font-semibold">
            {t("Knowledge base + RAG", "قاعدة المعرفة والاسترجاع", lang)}
          </h3>
        </div>
        <p dir="rtl" className="font-arabic mt-1 text-[11px] text-ink-3">
          الوثائق التي يستند إليها الوكيل، مع نسب المصدر
        </p>

        {error && (
          <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[12.5px] text-red-700">
            {t(
              "Could not load the capability manifest. GET /api/operator/manifest directly.",
              "تعذر تحميل بيان القدرات. استدعِ GET /api/operator/manifest مباشرة.",
              lang,
            )}
          </p>
        )}
        {!data && !error && (
          <p className="mt-4 text-[12.5px] text-ink-3">{t("Loading…", "جارٍ التحميل…", lang)}</p>
        )}

        {data && (
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap gap-2">
              <span className="flex items-center gap-1 rounded-full border border-line bg-secondary px-2.5 py-1 text-[10.5px] font-semibold text-ink-2">
                <BookOpen className="h-3.5 w-3.5 text-primary" />
                {t("RAG enabled", "الاسترجاع مُفعّل", lang)}
              </span>
              <span className="rounded-full border border-line bg-secondary px-2.5 py-1 text-[10.5px] font-semibold text-ink-2">
                {t("Source attribution", "نسب المصدر", lang)}
              </span>
              <span className="num rounded-full border border-line px-2.5 py-1 text-[10.5px] text-ink-2">
                max_vector_distance {data.rag.max_vector_distance}
              </span>
            </div>
            <div className="space-y-3">
              {data.knowledge_base.map((doc) => (
                <div key={doc.lang} className="rounded-2xl border border-line bg-paper px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[12.5px] font-semibold text-foreground">{doc.title}</span>
                    <span className="num text-[10.5px] uppercase text-ink-3">
                      {doc.lang} · {doc.version}
                    </span>
                  </div>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-ink-2">{doc.scope}</p>
                </div>
              ))}
            </div>
            <p className="text-[11.5px] leading-relaxed text-ink-3">{data.rag.note}</p>
          </div>
        )}
      </div>

      {/* Tools & actions + trust context */}
      <div className="rounded-3xl border border-line bg-white p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4 text-primary" />
          <h3 className="text-[14px] font-semibold">
            {t("Tools & actions", "الأدوات والإجراءات", lang)}
          </h3>
        </div>
        <p dir="rtl" className="font-arabic mt-1 text-[11px] text-ink-3">
          الأدوات المتصلة عبر MCP، مع النطاق وسياق الثقة
        </p>

        {data && (
          <div className="mt-4 space-y-4">
            <p className="rounded-2xl border border-line bg-paper px-4 py-3 text-[11.5px] leading-relaxed text-ink-2">
              <span className="num font-semibold text-foreground">{data.mcp.endpoint}</span> —{" "}
              {data.mcp.note}
            </p>
            <div className="space-y-3">
              {data.tools.map((tool) => (
                <div key={tool.name} className="rounded-2xl border border-line bg-paper px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12.5px] font-semibold text-foreground">
                      {tool.label}
                    </span>
                    <span className="num text-[10.5px] text-ink-3">{tool.name}</span>
                    {tool.trust === "privileged" ? (
                      <span className="flex items-center gap-1 rounded-full border border-line bg-secondary px-2.5 py-1 text-[10.5px] font-semibold text-ink-2">
                        <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                        {t("privileged · trust-gated", "مقيّد بسياق الثقة", lang)}
                      </span>
                    ) : (
                      <span className="rounded-full border border-line px-2.5 py-1 text-[10.5px] font-semibold text-ink-3">
                        {t("safe", "آمن", lang)}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-ink-2">
                    {tool.description}
                  </p>
                  <p className="num mt-1 text-[10.5px] text-ink-3">
                    {t("backend", "الخلفية", lang)}: {tool.backend} · {t("scope", "النطاق", lang)}:{" "}
                    {tool.scoping}
                  </p>
                  <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-3">
                    {tool.trust_note}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Agent Testing / Evaluation — the Stage-2 evidence surface.
 *
 * Multi-run pass rates, the tool-call criterion, and which scenarios were
 * proven offline, read from the committed evidence artifacts via
 * /api/operator/evaluation. The honesty framing is rendered verbatim from the
 * API: an unverified run is shown as unverified, never as a pass, because a
 * rate the operator cannot reproduce is worse than no panel.
 */
type EvaluationArm = {
  language: string;
  runs_per_scenario: number;
  generated_at: string | null;
  agent_layer: { scored: number; passed: number; pass_rate: number };
  tool_call: { executed: number; pass_rate: number; criterion_met: boolean; unverified: number };
  coverage: { proven_offline: string[]; unverified: number };
  tool_scenarios: Array<{ id: string; title: string; kind: string | null; pass_rate: number }>;
};

type Evaluation = {
  ok: boolean;
  agent_id: string | null;
  endpoint: string | null;
  languages: EvaluationArm[];
  integrity_note: string;
};

const pct = (n: number) => `${Math.round(n * 100)}%`;

function EvaluationSection() {
  const { lang } = useApp();
  const [data, setData] = useState<Evaluation | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/operator/evaluation", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: Evaluation) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-5 lg:col-span-2">
      <div className="rounded-3xl border border-line bg-white p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          <h3 className="text-[14px] font-semibold">
            {t("Agent testing · evaluation", "اختبار الوكيل والتقييم", lang)}
          </h3>
        </div>
        <p dir="rtl" className="font-arabic mt-1 text-[11px] text-ink-3">
          نسب النجاح عبر تشغيلات متعددة، مع معيار استدعاء الأدوات
        </p>

        {error && (
          <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[12.5px] text-red-700">
            {t(
              "Could not load evaluation evidence. GET /api/operator/evaluation directly.",
              "تعذر تحميل أدلة التقييم. استدعِ GET /api/operator/evaluation مباشرة.",
              lang,
            )}
          </p>
        )}
        {!data && !error && (
          <p className="mt-4 text-[12.5px] text-ink-3">{t("Loading…", "جارٍ التحميل…", lang)}</p>
        )}
        {data && data.languages.length === 0 && (
          <p className="mt-4 rounded-xl border border-line bg-paper px-4 py-3 text-[12.5px] text-ink-2">
            {t(
              "No agent-testing evidence committed yet. Run the agent-test harness to produce it.",
              "لا توجد أدلة اختبار للوكيل بعد. شغّل اختبار الوكيل لإنتاجها.",
              lang,
            )}
          </p>
        )}

        {data?.languages.map((arm) => (
          <div
            key={arm.language}
            className="mt-4 rounded-2xl border border-line bg-paper px-4 py-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="num text-[12.5px] font-semibold text-foreground">
                {arm.language.toUpperCase()} · ×{arm.runs_per_scenario}{" "}
                {t("runs/scenario", "تشغيل لكل سيناريو", lang)}
              </span>
              {arm.generated_at && (
                <span className="num text-[10.5px] text-ink-3">
                  {arm.generated_at.slice(0, 10)}
                </span>
              )}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div>
                <div className="text-[10.5px] text-ink-3">
                  {t("Agent-layer pass rate", "نسبة نجاح طبقة الوكيل", lang)}
                </div>
                <div className="num text-[18px] font-semibold text-foreground">
                  {pct(arm.agent_layer.pass_rate)}
                </div>
                <div className="num text-[10.5px] text-ink-3">
                  {arm.agent_layer.passed}/{arm.agent_layer.scored} {t("passed", "ناجح", lang)}
                </div>
              </div>
              <div>
                <div className="text-[10.5px] text-ink-3">
                  {t("Tool-call criterion", "معيار استدعاء الأدوات", lang)}
                </div>
                <div className="num text-[18px] font-semibold text-foreground">
                  {pct(arm.tool_call.pass_rate)}
                </div>
                <div className="num text-[10.5px] text-ink-3">
                  {arm.tool_call.executed} {t("executed", "منفّذ", lang)}
                  {arm.tool_call.unverified
                    ? ` · ${arm.tool_call.unverified} ${t("unverified", "غير مُحقّق", lang)}`
                    : ""}
                </div>
              </div>
              <div>
                <div className="text-[10.5px] text-ink-3">
                  {t("Proven offline", "مُثبَت دون اتصال", lang)}
                </div>
                <div className="num text-[12px] font-semibold text-foreground">
                  {arm.coverage.proven_offline.length
                    ? arm.coverage.proven_offline.join(", ")
                    : "—"}
                </div>
              </div>
            </div>
            {arm.tool_scenarios.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {arm.tool_scenarios.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 text-[11px]">
                    <span className="num w-12 shrink-0 text-ink-3">{s.id}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-2">{s.title}</span>
                    <span className="num shrink-0 font-semibold text-foreground">
                      {pct(s.pass_rate)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        {data && data.languages.length > 0 && (
          <p className="mt-4 flex items-start gap-2 rounded-2xl border border-line bg-secondary px-4 py-3 text-[11px] leading-relaxed text-ink-2">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span>
              {data.integrity_note}
              {data.agent_id ? ` · ${t("agent", "الوكيل", lang)}: ${data.agent_id}` : ""}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Model layer — the voice stack is LLM-agnostic. Shows the agent-plane LLM and
 * the continuity-plane fallback cascade (by NAME only), read from
 * /api/operator/model-layer. No credential is ever fetched or rendered.
 */
type ModelLayer = {
  ok: boolean;
  agent_plane: { llm: string; note: string };
  fallback_cascade: { order: string[]; active: string | null; note: string };
  byok_note: string;
};

function ModelLayerSection() {
  const { lang } = useApp();
  const [data, setData] = useState<ModelLayer | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/operator/model-layer", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: ModelLayer) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-5 lg:col-span-2">
      <div className="rounded-3xl border border-line bg-white p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <Boxes className="h-4 w-4 text-primary" />
          <h3 className="text-[14px] font-semibold">
            {t("Model layer · LLM-agnostic", "طبقة النموذج · مستقل عن المزوّد", lang)}
          </h3>
        </div>
        <p dir="rtl" className="font-arabic mt-1 text-[11px] text-ink-3">
          نموذج الوكيل مع تدرّج احتياطي للطوارئ
        </p>

        {error && (
          <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[12.5px] text-red-700">
            {t(
              "Could not load the model layer. GET /api/operator/model-layer directly.",
              "تعذر تحميل طبقة النموذج. استدعِ GET /api/operator/model-layer مباشرة.",
              lang,
            )}
          </p>
        )}
        {!data && !error && (
          <p className="mt-4 text-[12.5px] text-ink-3">{t("Loading…", "جارٍ التحميل…", lang)}</p>
        )}

        {data && (
          <div className="mt-4 space-y-4">
            <div className="rounded-2xl border border-line bg-paper px-4 py-3">
              <div className="text-[10.5px] text-ink-3">
                {t("Agent plane (outbound)", "مستوى الوكيل (الصادر)", lang)}
              </div>
              <div className="num mt-0.5 text-[14px] font-semibold text-foreground">
                {data.agent_plane.llm}
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-2">
                {data.agent_plane.note}
              </p>
            </div>

            <div className="rounded-2xl border border-line bg-paper px-4 py-3">
              <div className="text-[10.5px] text-ink-3">
                {t(
                  "Fallback cascade (continuity plane)",
                  "التدرّج الاحتياطي (مستوى الاستمرارية)",
                  lang,
                )}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {data.fallback_cascade.order.map((p, i) => (
                  <span key={p} className="flex items-center gap-1.5">
                    {i > 0 && <span className="text-ink-3">→</span>}
                    <span
                      className={cn(
                        "num rounded-full border px-2.5 py-1 text-[11px] font-semibold",
                        p === data.fallback_cascade.active
                          ? "border-primary bg-green-tint text-primary"
                          : "border-line text-ink-2",
                      )}
                    >
                      {p}
                      {p === data.fallback_cascade.active ? ` · ${t("active", "نشط", lang)}` : ""}
                    </span>
                  </span>
                ))}
              </div>
              <p className="mt-2 text-[11.5px] leading-relaxed text-ink-2">
                {data.fallback_cascade.note}
              </p>
            </div>

            <p className="text-[11.5px] leading-relaxed text-ink-3">{data.byok_note}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Agent Workflows — the builder for multi-step, branching agent journeys with
 * per-node tool scoping and sub-agents.
 *
 * The component owns its own persistence and Run: Save posts the graph through
 * POST /api/console/workflows (server-side re-validation by the same schema and
 * validator the runner enforces), and Run executes it on the LIVE tool plane
 * through the guarded tool routes — a console run cannot reach an action the
 * guard would refuse the agent path. The intro line is rendered from here so
 * the operator knows what Run touches before pressing it.
 */
function AgentWorkflowsSection() {
  const { lang } = useApp();
  return (
    <div className="space-y-5 lg:col-span-2">
      <div className="rounded-3xl border border-line bg-white p-5 sm:p-6">
        <div className="flex items-center gap-2">
          <Workflow className="h-4 w-4 text-primary" />
          <h3 className="text-[14px] font-semibold">
            {t("Agent workflows builder", "بانٍ مسارات الوكيل", lang)}
          </h3>
        </div>
        <p dir="rtl" className="font-arabic mt-1 text-[11px] text-ink-3">
          مسارات متعددة الخطوات بتفريع الأدوات لكل عقدة
        </p>
        <p className="mt-3 text-[12.5px] leading-relaxed text-ink-2">
          {t(
            "Design, validate, save and run a journey. Run executes on the live tool plane through the same guarded routes an agent webhook hits — every tool call is authenticated, tenant-scoped and state-gated exactly as it is on a live call, and each one is audited by the tool route itself.",
            "صمّم مسارًا وتحقق منه واحفظه وشغّله. التشغيل ينفّذ على المستوى الحيّ عبر نفس المسارات المحمية التي يستخدمها نداء الوكيل — كل نداء أداة موثّق ومحدود بالمستأجر ومحكوم بالحالة كما في المكالمة الحيّة، وكلٌّ منها مسجّل في سلسلة التداول.",
            lang,
          )}
        </p>
        <div className="mt-4">
          <WorkflowGraph />
        </div>
      </div>
    </div>
  );
}

function Config() {
  const { lang } = useApp();
  const [guards, setGuards] = useState(GUARDRAILS.map((g) => g.on));
  const [threshold, setThreshold] = useState([0.8]);
  const [selectedVoice, setSelectedVoice] = useState("fatima");
  const { toast } = useToast();

  const preview = (id: string) => {
    try {
      const u = new SpeechSynthesisUtterance(
        id === "fatima"
          ? "مرحباً، أنا مساعد الأمان في مصرفك. أتصل بخصوص نشاط حديث على حسابك."
          : "Hello, this is your bank's AI security assistant calling about recent activity on your account.",
      );
      u.lang = id === "fatima" ? "ar-SA" : "en-US";
      const voices = window.speechSynthesis.getVoices();
      const v = voices.find((x) => x.lang.startsWith(id === "fatima" ? "ar" : "en"));
      if (v) u.voice = v;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
      toast({
        title: t("Voice preview", "معاينة الصوت", lang),
        description: `${t("Playing", "تشغيل", lang)} ${
          VOICES.find((v) => v.id === id)?.name
        } ${t("via browser TTS.", "عبر نطق المتصفح.", lang)}`,
      });
    } catch {
      toast({
        title: t("Voice preview unavailable", "معاينة الصوت غير متاحة", lang),
        description: t("Browser TTS not supported here.", "نطق المتصفح غير مدعوم هنا.", lang),
      });
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <AgentCapabilitiesSection />
      <EvaluationSection />
      <ModelLayerSection />
      <AgentWorkflowsSection />
      {/* voices */}
      <div className="rounded-3xl border border-line bg-white p-5 sm:p-6">
        <h3 className="text-[14px] font-semibold">
          {t("Voice personas", "الأصوات المعتمدة", lang)}
        </h3>
        <div className="mt-4 space-y-3">
          {VOICES.map((v) => (
            <button
              key={v.id}
              onClick={() => setSelectedVoice(v.id)}
              className={cn(
                "flex w-full items-center gap-4 rounded-2xl border p-4 text-left transition",
                selectedVoice === v.id
                  ? "border-primary bg-green-tint/50 shadow-[0_10px_26px_-18px_rgba(11,122,85,0.6)]"
                  : "border-line hover:border-primary/40",
              )}
            >
              <span
                className={cn(
                  "flex h-11 w-11 shrink-0 items-center justify-center rounded-full font-display text-[15px] font-bold",
                  selectedVoice === v.id ? "bg-primary text-white" : "bg-secondary text-ink-2",
                )}
              >
                {v.name[0]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold">{v.name}</span>
                  <span
                    className={cn("text-[12px]", v.id === "fatima" ? "font-arabic" : "text-ink-3")}
                  >
                    {v.lang}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[12px] text-ink-2">{v.desc}</span>
                <span className="num mt-1 block text-[10.5px] text-ink-3">{v.params}</span>
              </span>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  preview(v.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.stopPropagation();
                    preview(v.id);
                  }
                }}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-white text-primary transition hover:bg-primary hover:text-white"
                aria-label={`${t("Preview", "معاينة", lang)} ${v.name}`}
              >
                ▶
              </span>
            </button>
          ))}
        </div>
        <div className="mt-4 rounded-xl bg-paper px-4 py-3 text-[11.5px] leading-relaxed text-ink-2">
          {t(
            "Dialect variants tuned for Gulf Arabic, Urdu and Hindi today — Filipino and Malayalam are one voice registration away on the same pipeline. Fallback to English when language confidence drops below threshold.",
            "لهجات مضبوطة اليوم للعربية الخليجية والأردية والهندية — أما الفلبينية والمالايالامية فتفصلها تسجيل صوتي واحد على نفس خط المعالجة. ويتم التحول إلى الإنجليزية عند انخفاض ثقة اللغة عن الحد.",
            lang,
          )}
        </div>
      </div>

      <div className="space-y-5">
        {/* guardrails */}
        <div className="rounded-3xl border border-line bg-white p-5 sm:p-6">
          <h3 className="text-[14px] font-semibold">{t("Guardrails", "ضمانات الامتثال", lang)}</h3>
          <div className="mt-4 space-y-1">
            {GUARDRAILS.map((g, i) => (
              <div
                key={g.en}
                className="flex items-center justify-between gap-3 rounded-xl px-2 py-2.5 transition hover:bg-paper"
              >
                <div>
                  <p className="text-[13px] font-medium">{t(g.en, g.ar, lang)}</p>
                </div>
                <Switch
                  checked={guards[i]}
                  onCheckedChange={(v) => {
                    setGuards((prev) => prev.map((x, j) => (j === i ? v : x)));
                    if (!v) {
                      toast({
                        title: t("Guardrail disabled", "تم تعطيل ضمانة", lang),
                        description: t(
                          "This action is blocked in production for critical guardrails.",
                          "هذا الإجراء محظور في الإنتاج بالنسبة للضمانات الحرجة.",
                          lang,
                        ),
                        variant: "destructive",
                      });
                      setGuards((prev) => prev.map((x, j) => (j === i ? true : x)));
                    }
                  }}
                />
              </div>
            ))}
          </div>
        </div>

        {/* threshold */}
        <div className="rounded-3xl border border-line bg-white p-5 sm:p-6">
          <h3 className="text-[14px] font-semibold">
            {t("Intervention risk threshold", "حد مخاطر التدخل", lang)}
          </h3>
          <div className="mt-5 flex items-center gap-5">
            <Slider
              value={threshold}
              onValueChange={setThreshold}
              min={0.5}
              max={0.99}
              step={0.01}
              className="flex-1"
            />
            <span className="num w-16 rounded-lg bg-green-tint py-1.5 text-center text-[14px] font-bold text-green-deep">
              {threshold[0].toFixed(2)}
            </span>
          </div>
          <p className="mt-4 text-[12px] leading-relaxed text-ink-2">
            {t(
              "Agent triggers only above this risk score — keeps false positives off customers' phones. Current rate:",
              "لا يتخذ الوكيل إجراءً إلا فوق درجة الخطر هذه — مما يُبعد الإنذارات الكاذبة عن هواتف العملاء. المعدل الحالي:",
              lang,
            )}{" "}
            <span className="num font-semibold">3.1%</span>{" "}
            {t("of alerts suppressed.", "من التنبيهات تم كبتها.", lang)}
          </p>
        </div>
      </div>
    </div>
  );
}

/* ————————————————— COMPLIANCE ————————————————— */

const PAGE_SIZE = 5;

function Compliance() {
  const { lang } = useApp();
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const { toast } = useToast();

  useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 750);
    return () => clearTimeout(timer);
  }, []);

  const filtered = useMemo(
    () =>
      AUDIT_LOG.filter(
        (a) =>
          a.event.toLowerCase().includes(query.toLowerCase()) ||
          a.detail.toLowerCase().includes(query.toLowerCase()),
      ),
    [query],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const rows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <div className="rounded-3xl border border-line bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex items-center gap-2.5">
          <ScrollText className="h-4 w-4 text-primary" />
          <h3 className="text-[14px] font-semibold">
            {t("Immutable audit log", "سجل تدقيق غير قابل للتغيير", lang)}
          </h3>
          <Chip>{t("AES-256 · sealed", "AES-256 · مُغلّف", lang)}</Chip>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
              placeholder={t("Filter events…", "تصفية الأحداث…", lang)}
              className="h-9 w-44 rounded-lg border border-line bg-paper pl-8 pr-3 text-[12.5px] outline-none transition focus:border-primary/50 focus:bg-white"
            />
          </div>
          <button
            onClick={() =>
              toast({
                title: t("Compliance report queued", "تم جدولة تقرير الامتثال", lang),
                description: t(
                  "CSV export of 14 sealed entries will download shortly (demo).",
                  "سيتم تنزيل تصدير CSV لـ 14 مدخلة مُغلّفة بعد قليل (عرض توضيحي).",
                  lang,
                ),
              })
            }
            className="flex h-9 items-center gap-2 rounded-lg border border-line bg-white px-3 text-[12px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary"
          >
            <Download className="h-3.5 w-3.5" />
            {t("Export", "تصدير", lang)}
          </button>
        </div>
      </div>

      <div className="min-h-[300px] px-5 py-4">
        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-4">
                <Skeleton className="h-3.5 w-16" />
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-3.5 flex-1" />
                <Skeleton className="h-3.5 w-20" />
              </div>
            ))}
          </div>
        ) : (
          <table className="w-full text-left text-[12.5px]">
            <thead>
              <tr className="micro !text-[9px] text-ink-3">
                <th className="py-2.5 pr-3 font-medium">{t("Time", "الوقت", lang)}</th>
                <th className="py-2.5 pr-3 font-medium">{t("Event", "الحدث", lang)}</th>
                <th className="py-2.5 pr-3 font-medium">{t("Actor", "المنفّذ", lang)}</th>
                <th className="py-2.5 pr-3 font-medium">{t("Detail", "التفصيل", lang)}</th>
                <th className="py-2.5 text-right font-medium">{t("Hash", "البصمة", lang)}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr
                  key={a.ts + a.hash}
                  className="border-t border-line/70 align-top transition hover:bg-paper/60"
                >
                  <td className="num py-3 pr-3 text-ink-3">{a.ts}</td>
                  <td className="py-3 pr-3">
                    <span
                      className={cn(
                        "num rounded-md px-1.5 py-0.5 text-[10px] font-semibold",
                        a.event.includes("FROZEN") || a.event.includes("CONFIRMED")
                          ? "bg-green-tint text-green-deep"
                          : a.event.includes("ALERT")
                            ? "bg-red-tint text-red-soft"
                            : "bg-secondary text-ink-2",
                      )}
                    >
                      {a.event}
                    </span>
                  </td>
                  <td className="num py-3 pr-3 text-ink-2">{a.actor}</td>
                  <td className="max-w-[340px] py-3 pr-3 text-ink-2">{a.detail}</td>
                  <td className="num py-3 text-right text-[10.5px] text-ink-3">{a.hash}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3.5">
        <span className="text-[11.5px] text-ink-3">
          {t("Showing", "عرض", lang)}{" "}
          {loading
            ? "—"
            : `${(safePage - 1) * PAGE_SIZE + 1}–${Math.min(safePage * PAGE_SIZE, filtered.length)}`}{" "}
          {t("of", "من", lang)} {filtered.length} {t("sealed entries", "مدخلات مُغلّفة", lang)}
        </span>
        <Pagination page={safePage} pages={pages} onChange={setPage} />
      </div>
    </div>
  );
}

/* ————————————————— WEBHOOKS · live signing demo ————————————————— */

const WX_EVENTS = [
  "intervention.started",
  "identity.verified",
  "account.frozen",
  "customer.confirmed",
  "case.closed",
  "escalated.human",
] as const;

type WxState = {
  event: string;
  payload: string;
  header: string;
  secret: string;
  v1: string;
  t: string;
};

function WebhooksDemo() {
  const { lang } = useApp();
  const [event, setEvent] = useState<string>("account.frozen");
  const [busy, setBusy] = useState(false);
  const [signed, setSigned] = useState<WxState | null>(null);
  const [check, setCheck] = useState<{ valid: boolean; reason: string; tampered: boolean } | null>(
    null,
  );

  const sign = async () => {
    setBusy(true);
    setCheck(null);
    try {
      const r = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sign", event }),
      });
      const d = await r.json();
      if (d.ok) setSigned(d);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (tamper: boolean) => {
    if (!signed) return;
    setBusy(true);
    try {
      let payload = signed.payload;
      if (tamper) {
        // flip a value the way an attacker would — the digest must catch it
        try {
          const obj = JSON.parse(payload);
          if (typeof obj.risk_score === "number") obj.risk_score = 0.05;
          else if (typeof obj.prevented_loss_aed === "number") obj.prevented_loss_aed = 999999;
          else obj.verified = false;
          payload = JSON.stringify(obj);
        } catch {
          payload = payload.replace(/.$/, "}");
        }
      }
      const r = await fetch("/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", payload, header: signed.header }),
      });
      const d = await r.json();
      setCheck({ valid: !!d.valid, reason: d.reason ?? "", tampered: tamper });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
      {/* sign & verify */}
      <div className="space-y-5">
        <div className="rounded-3xl border border-line bg-white p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-[17px] font-semibold tracking-tight">
                {t("Signed delivery — try to forge it", "تسليم موقّع — جرّب تزويره", lang)}
              </h2>
              <p className="mt-1 max-w-lg text-[13px] leading-relaxed text-ink-2">
                {t(
                  "Real HMAC-SHA256, computed server-side with the same primitives as production deliveries. Sign an event, verify it, then flip a value and watch the signature reject it.",
                  "HMAC-SHA256 حقيقي يُحسب على الخادم بنفس طرائق الإنتاج. وقّع حدثاً، تحقق منه، ثم عدّل قيمة وشاهد التوقيع يرفضها.",
                  lang,
                )}
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {WX_EVENTS.map((e) => (
              <button
                key={e}
                onClick={() => setEvent(e)}
                className={cn(
                  "rounded-full border px-3 py-1.5 font-mono text-[11px] font-semibold transition",
                  event === e
                    ? "border-primary bg-green-tint text-primary"
                    : "border-line bg-paper text-ink-2 hover:text-foreground",
                )}
              >
                {e}
              </button>
            ))}
            <button
              onClick={sign}
              disabled={busy}
              className="ml-auto flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-[12.5px] font-semibold text-white transition hover:bg-green-deep disabled:opacity-50"
            >
              <Webhook className="h-3.5 w-3.5" />
              {busy ? t("Working…", "جارٍ…", lang) : t("Sign payload", "وقّع الحمولة", lang)}
            </button>
          </div>

          {signed && (
            <div className="mt-5 space-y-3">
              <div>
                <div className="micro mb-1.5 text-[9px] text-ink-3">
                  {t(
                    "RAW PAYLOAD · EXACTLY WHAT THE CONSUMER RECEIVES",
                    "الحمولة الخام · تماماً كما يستلمها المستهلك",
                    lang,
                  )}
                </div>
                <pre className="max-h-44 overflow-auto rounded-xl bg-[#0c110e] px-4 py-3 font-mono text-[11.5px] leading-relaxed text-white/85 sv-scroll">
                  {signed.payload}
                </pre>
              </div>
              <div>
                <div className="micro mb-1.5 text-[9px] text-ink-3">
                  {t("SIGNATURE HEADER · SV-SIGNATURE", "ترويسة التوقيع · SV-SIGNATURE", lang)}
                </div>
                <div className="overflow-x-auto rounded-xl border border-line bg-paper px-4 py-3 font-mono text-[11.5px] text-foreground sv-scroll">
                  <span className="text-ink-3">t={signed.t},</span>
                  <span className="font-semibold text-primary">v1={signed.v1}</span>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  onClick={() => verify(false)}
                  disabled={busy}
                  className="flex items-center gap-2 rounded-full bg-[#0c110e] px-4 py-2 text-[12.5px] font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  {t("Verify signature", "تحقق من التوقيع", lang)}
                </button>
                <button
                  onClick={() => verify(true)}
                  disabled={busy}
                  className="flex items-center gap-2 rounded-full border border-red-200 bg-red-50 px-4 py-2 text-[12.5px] font-semibold text-red-700 transition hover:bg-red-100 disabled:opacity-50"
                >
                  {t("Tamper & verify", "العبث ثم تحقق", lang)}
                </button>
              </div>

              {check && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={cn(
                    "flex items-start gap-2.5 rounded-xl border px-4 py-3",
                    check.valid
                      ? "border-green-200 bg-green-50 text-green-800"
                      : "border-red-200 bg-red-50 text-red-700",
                  )}
                >
                  {check.valid ? (
                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  )}
                  <div className="text-[12.5px] font-medium leading-relaxed">
                    {check.valid
                      ? t("SIGNATURE VALID — ", "التوقيع صحيح — ", lang)
                      : t("SIGNATURE REJECTED — ", "تم رفض التوقيع — ", lang)}
                    <span className="font-normal">{check.reason}</span>
                    {check.tampered && !check.valid && (
                      <span className="mt-0.5 block font-mono text-[11px] text-red-600/80">
                        {t(
                          "tamper: risk_score 0.94 → 0.05 · caught by digest",
                          "عبث: risk_score 0.94 → 0.05 · تم اكتشافه بالملخّص",
                          lang,
                        )}
                      </span>
                    )}
                  </div>
                </motion.div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* explainer */}
      <div className="space-y-4">
        <div className="rounded-3xl border border-line bg-white p-6">
          <div className="micro text-[9px] text-ink-3">
            {t("WHAT YOUR ENDPOINT DOES", "ما الذي يفعله نقطة الاستقبال", lang)}
          </div>
          <ol className="mt-3 space-y-2.5">
            {[
              {
                en: "Read the raw request body as bytes — never a re-serialized parse.",
                ar: "اقرأ جسم الطلب الخام كبايتات — لا كتحليل مُعاد تسلسله.",
              },
              {
                en: "Split the SV-Signature header into t and v1.",
                ar: "قسّم ترويسة SV-Signature إلى t و v1.",
              },
              {
                en: "Reject if t is older than 5 minutes (replay protection).",
                ar: "ارفض الطلب إذا كان t أقدم من 5 دقائق (حماية من إعادة التشغيل).",
              },
              {
                en: "Compute HMAC-SHA256(secret, `${t}.${rawBody}`) and compare to v1 in constant time.",
                ar: "احسب HMAC-SHA256(secret, `${t}.${rawBody}`) وقارنه بـ v1 بزمن ثابت.",
              },
            ].map((s, i) => (
              <li key={i} className="flex gap-2.5 text-[12.5px] leading-relaxed text-ink-2">
                <span className="font-mono text-[11px] font-bold text-primary">
                  {String(i + 1).padStart(2, "0")}
                </span>
                {t(s.en, s.ar, lang)}
              </li>
            ))}
          </ol>
          <p className="mt-4 border-t border-line/70 pt-3 text-[11.5px] leading-relaxed text-ink-3">
            {t(
              "The signing secret lives server-side — like the one behind this demo, it is never shipped to the browser. Verification here is constant-time (timingSafeEqual).",
              "سر التوقيع يعيش على الخادم — ومثل السر الذي يقف خلف هذا العرض، لا يُرسل إلى المتصفح أبداً. والتحقق هنا يتم بزمن ثابت (timingSafeEqual).",
              lang,
            )}
          </p>
        </div>
        <div className="rounded-3xl border border-line bg-[#0c110e] p-6 text-white">
          <div className="font-mono text-[10.5px] uppercase tracking-wider text-white/50">
            {t("verify in 6 lines", "تحقق في 6 أسطر", lang)}
          </div>
          <pre className="mt-3 overflow-x-auto font-mono text-[11px] leading-relaxed text-white/85 sv-scroll">
            {`const hmac = crypto
  .createHmac("sha256", secret)
  .update(\`\${t}.${"${rawBody}"}\`)
  .digest("hex");
const ok = crypto.timingSafeEqual(
  Buffer.from(hmac), Buffer.from(v1));`}
          </pre>
        </div>
      </div>
    </div>
  );
}
