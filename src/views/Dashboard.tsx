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
} from "lucide-react";
import { useApp, t } from "@/lib/store";
import { RECENT_CALLS, AUDIT_LOG, KPIS, LANG_DIST, OUTCOME_DIST, TREND, VOICES } from "@/lib/data";
import { StatusPill, LiveDot, Skeleton, Chip } from "@/components/fx/core";
import { Counter } from "@/components/fx/core";
import { TrendChart, HBars, Donut, Gauge, CompareBar, Sparkline } from "@/components/fx/charts";
import { Pagination } from "@/components/fx/Pagination";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

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
            <span className="micro text-primary">Agent operations</span>
            <span className="h-px w-10 bg-line" />
            <span dir="rtl" className="font-arabic text-[13px] text-ink-3">لوحة العمليات</span>
          </div>
          <h1 className="font-display mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Agent Management Dashboard
          </h1>
        </div>
        <div className="flex items-center gap-2.5 rounded-full border border-line bg-white px-3.5 py-2">
          <LiveDot />
          <span className="text-[12px] font-medium text-ink-2">
            Demo bank · mock environment · all systems nominal
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
              tab === x.id ? "text-white" : "text-ink-2 hover:text-foreground"
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
            <span className="relative whitespace-nowrap">
              {lang === "ar" ? x.ar : x.en}
            </span>
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
        {tab === "webhooks" && <WebhooksDemo />}
      </motion.div>
    </div>
  );
}

/* ————————————————— MONITOR ————————————————— */

const OUTCOME_MAP: Record<string, { tone: "green" | "red" | "amber" | "gray"; en: string }> = {
  prevented: { tone: "green", en: "Fraud prevented" },
  false_alarm: { tone: "gray", en: "False alarm" },
  handoff: { tone: "amber", en: "Handoff" },
  no_answer: { tone: "red", en: "No answer" },
};

function Monitor() {
  const live = RECENT_CALLS[0];
  return (
    <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
      {/* live call */}
      <div className="overflow-hidden rounded-3xl border border-primary/30 bg-white shadow-[0_18px_44px_-28px_rgba(11,122,85,0.5)]">
        <div className="flex items-center justify-between bg-[#0c110e] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <LiveDot className="text-green-bright" />
            <span className="micro !text-[9.5px] text-white/70">Active call · SV-8642</span>
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
                +971 •• ••• 4567 · {live.lang} · card ••4417
              </p>
            </div>
            <StatusPill tone="red">risk 0.94</StatusPill>
          </div>

          {/* state timeline */}
          <div className="mt-5 space-y-2.5">
            {[
              { s: "Alert received", ok: true, t: "0.0s" },
              { s: "Call connected", ok: true, t: "1.2s" },
              { s: "Identity verified", ok: true, t: "33s" },
              { s: "Fraud confirmed", ok: true, t: "44s" },
              { s: "Card freeze executed", ok: true, t: "50s" },
              { s: "Warm handoff", ok: false, t: "…" },
            ].map((r) => (
              <div key={r.s} className="flex items-center gap-2.5 text-[12.5px]">
                <span
                  className={cn(
                    "flex h-4 w-4 items-center justify-center rounded-full border",
                    r.ok ? "border-primary bg-primary" : "border-line bg-white"
                  )}
                >
                  {r.ok && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                </span>
                <span className={r.ok ? "text-foreground" : "text-ink-3"}>{r.s}</span>
                <span className="num ml-auto text-[10.5px] text-ink-3">{r.t}</span>
              </div>
            ))}
          </div>

          <div className="mt-5 flex items-center gap-2 rounded-xl bg-green-tint px-3.5 py-2.5">
            <Snowflake className="h-3.5 w-3.5 text-green-deep" />
            <span className="text-[12px] font-medium text-green-deep">
              Temporary freeze active on ••4417 — reversible after case review
            </span>
          </div>
        </div>
      </div>

      {/* recent calls table */}
      <div className="rounded-3xl border border-line bg-white">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="flex items-center gap-2.5">
            <LayoutDashboard className="h-4 w-4 text-primary" />
            <h3 className="text-[14px] font-semibold">Recent intervention calls</h3>
          </div>
          <Chip>last 2 hrs · mock data</Chip>
        </div>
        <div className="sv-scroll max-h-[430px] overflow-y-auto">
          <table className="w-full text-left text-[12.5px]">
            <thead className="sticky top-0 bg-paper">
              <tr className="micro !text-[9px] text-ink-3">
                <th className="px-5 py-2.5 font-medium">ID</th>
                <th className="px-2 py-2.5 font-medium">Customer</th>
                <th className="px-2 py-2.5 font-medium">Lang</th>
                <th className="px-2 py-2.5 font-medium">Trigger</th>
                <th className="px-2 py-2.5 font-medium">Outcome</th>
                <th className="px-5 py-2.5 text-right font-medium">CSAT</th>
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
                      <StatusPill tone={o.tone}>{o.en}</StatusPill>
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

function Analytics() {
  return (
    <div className="space-y-5">
      {/* KPI cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {KPIS.map((k, i) => {
          const pctGood =
            k.good === "up"
              ? (k.current / k.target) * 100
              : (k.baseline / k.current) * 100;
          return (
            <motion.div
              key={k.key}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.06, duration: 0.45 }}
              className="rounded-2xl border border-line bg-white p-5"
            >
              <div className="flex items-center justify-between">
                <p className="text-[12px] font-medium text-ink-2">
                  {t(k.en, k.ar, "en")}
                </p>
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
                    k.good === "up" ? "bg-green-tint text-green-deep" : "bg-amber-tint text-amber-soft"
                  )}
                >
                  base {k.baseline}
                  {k.unit === "s" && k.baseline >= 60 ? "m→" : k.unit}
                </span>
              </div>
              <div className="mt-3">
                <Sparkline
                  data={TREND.map((v) => v * (0.7 + i * 0.1))}
                  up={k.good === "up"}
                />
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
            <h3 className="text-[14px] font-semibold">Prevented losses · 12 weeks (AED K)</h3>
            <span className="num text-[11px] text-green-deep">+172% since launch</span>
          </div>
          <TrendChart
            data={[...TREND]}
            labels={["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9", "W10", "W11", "W12"]}
            className="mt-4"
          />
        </div>
        <div className="rounded-3xl border border-line bg-white p-5 sm:p-6">
          <h3 className="text-[14px] font-semibold">Call outcomes</h3>
          <div className="mt-4 flex items-center justify-center">
            <Donut items={OUTCOME_DIST} />
          </div>
          <div className="mt-5 space-y-2">
            {OUTCOME_DIST.map((o) => (
              <div key={o.label} className="flex items-center gap-2.5 text-[12px]">
                <span className="h-2.5 w-2.5 rounded-[4px]" style={{ background: o.color }} />
                <span className="text-ink-2">{o.label}</span>
                <span dir="rtl" className="font-arabic text-[10.5px] text-ink-3">{o.labelAr}</span>
                <span className="num ml-auto font-semibold">{o.pct}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* language + gauges */}
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-3xl border border-line bg-white p-5 sm:p-6">
          <h3 className="text-[14px] font-semibold">Calls by customer language</h3>
          <p dir="rtl" className="font-arabic mt-1 text-[11px] text-ink-3">
            توزيع المكالمات حسب لغة العميل
          </p>
          <HBars
            items={LANG_DIST.map((l) => ({ label: l.lang, sub: l.langAr, pct: l.pct }))}
            className="mt-5"
          />
        </div>
        <div className="rounded-3xl border border-line bg-white p-5 sm:p-6">
          <h3 className="text-[14px] font-semibold">Verification quality</h3>
          <div className="mt-2 grid grid-cols-2 gap-4">
            <div className="flex flex-col items-center pt-4">
              <Gauge pct={87} label="challenge pass" />
            </div>
            <div className="flex flex-col items-center pt-4">
              <Gauge pct={93} label="language lock held" />
            </div>
          </div>
          <div className="mt-4 rounded-xl bg-paper px-4 py-3 text-[12px] leading-relaxed text-ink-2">
            Zero PIN/password request attempts across{" "}
            <span className="num font-semibold">1,284</span> calls · 30-day window. Guardrail
            violations: <span className="num font-semibold text-green-deep">0</span>.
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

function Config() {
  const [guards, setGuards] = useState(GUARDRAILS.map((g) => g.on));
  const [threshold, setThreshold] = useState([0.8]);
  const [selectedVoice, setSelectedVoice] = useState("fatima");
  const { toast } = useToast();

  const preview = (id: string) => {
    try {
      const u = new SpeechSynthesisUtterance(
        id === "fatima"
          ? "مرحباً، أنا مساعد الأمان في مصرفك. أتصل بخصوص نشاط حديث على حسابك."
          : "Hello, this is your bank's AI security assistant calling about recent activity on your account."
      );
      u.lang = id === "fatima" ? "ar-SA" : "en-US";
      const voices = window.speechSynthesis.getVoices();
      const v = voices.find((x) => x.lang.startsWith(id === "fatima" ? "ar" : "en"));
      if (v) u.voice = v;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
      toast({ title: "Voice preview", description: `Playing ${VOICES.find((v) => v.id === id)?.name} via browser TTS.` });
    } catch {
      toast({ title: "Voice preview unavailable", description: "Browser TTS not supported here." });
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {/* voices */}
      <div className="rounded-3xl border border-line bg-white p-5 sm:p-6">
        <h3 className="text-[14px] font-semibold">Voice personas</h3>
        <p dir="rtl" className="font-arabic mt-1 text-[11px] text-ink-3">الأصوات المعتمدة</p>
        <div className="mt-4 space-y-3">
          {VOICES.map((v) => (
            <button
              key={v.id}
              onClick={() => setSelectedVoice(v.id)}
              className={cn(
                "flex w-full items-center gap-4 rounded-2xl border p-4 text-left transition",
                selectedVoice === v.id
                  ? "border-primary bg-green-tint/50 shadow-[0_10px_26px_-18px_rgba(11,122,85,0.6)]"
                  : "border-line hover:border-primary/40"
              )}
            >
              <span
                className={cn(
                  "flex h-11 w-11 shrink-0 items-center justify-center rounded-full font-display text-[15px] font-bold",
                  selectedVoice === v.id ? "bg-primary text-white" : "bg-secondary text-ink-2"
                )}
              >
                {v.name[0]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold">{v.name}</span>
                  <span className={cn("text-[12px]", v.id === "fatima" ? "font-arabic" : "text-ink-3")}>
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
                aria-label={`Preview ${v.name}`}
              >
                ▶
              </span>
            </button>
          ))}
        </div>
        <div className="mt-4 rounded-xl bg-paper px-4 py-3 text-[11.5px] leading-relaxed text-ink-2">
          Dialect variants tuned for Gulf Arabic, Urdu, Hindi, Filipino and Malayalam. Fallback to
          English when language confidence drops below threshold.
        </div>
      </div>

      <div className="space-y-5">
        {/* guardrails */}
        <div className="rounded-3xl border border-line bg-white p-5 sm:p-6">
          <h3 className="text-[14px] font-semibold">Guardrails</h3>
          <p dir="rtl" className="font-arabic mt-1 text-[11px] text-ink-3">ضمانات الامتثال</p>
          <div className="mt-4 space-y-1">
            {GUARDRAILS.map((g, i) => (
              <div
                key={g.en}
                className="flex items-center justify-between gap-3 rounded-xl px-2 py-2.5 transition hover:bg-paper"
              >
                <div>
                  <p className="text-[13px] font-medium">{g.en}</p>
                  <p dir="rtl" className="font-arabic text-[10.5px] text-ink-3">{g.ar}</p>
                </div>
                <Switch
                  checked={guards[i]}
                  onCheckedChange={(v) => {
                    setGuards((prev) => prev.map((x, j) => (j === i ? v : x)));
                    if (!v) {
                      toast({
                        title: "Guardrail disabled",
                        description: "This action is blocked in production for critical guardrails.",
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
          <h3 className="text-[14px] font-semibold">Intervention risk threshold</h3>
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
            Agent triggers only above this risk score — keeps false positives off customers&apos;
            phones. Current rate: <span className="num font-semibold">3.1%</span> of alerts
            suppressed.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ————————————————— COMPLIANCE ————————————————— */

const PAGE_SIZE = 5;

function Compliance() {
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const { toast } = useToast();

  useEffect(() => {
    const t = setTimeout(() => setLoading(false), 750);
    return () => clearTimeout(t);
  }, []);

  const filtered = useMemo(
    () =>
      AUDIT_LOG.filter(
        (a) =>
          a.event.toLowerCase().includes(query.toLowerCase()) ||
          a.detail.toLowerCase().includes(query.toLowerCase())
      ),
    [query]
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const rows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <div className="rounded-3xl border border-line bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div className="flex items-center gap-2.5">
          <ScrollText className="h-4 w-4 text-primary" />
          <h3 className="text-[14px] font-semibold">Immutable audit log</h3>
          <Chip>AES-256 · sealed</Chip>
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
              placeholder="Filter events…"
              className="h-9 w-44 rounded-lg border border-line bg-paper pl-8 pr-3 text-[12.5px] outline-none transition focus:border-primary/50 focus:bg-white"
            />
          </div>
          <button
            onClick={() =>
              toast({
                title: "Compliance report queued",
                description: "CSV export of 14 sealed entries will download shortly (demo).",
              })
            }
            className="flex h-9 items-center gap-2 rounded-lg border border-line bg-white px-3 text-[12px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary"
          >
            <Download className="h-3.5 w-3.5" />
            Export
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
                <th className="py-2.5 pr-3 font-medium">Time</th>
                <th className="py-2.5 pr-3 font-medium">Event</th>
                <th className="py-2.5 pr-3 font-medium">Actor</th>
                <th className="py-2.5 pr-3 font-medium">Detail</th>
                <th className="py-2.5 text-right font-medium">Hash</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.ts + a.hash} className="border-t border-line/70 align-top transition hover:bg-paper/60">
                  <td className="num py-3 pr-3 text-ink-3">{a.ts}</td>
                  <td className="py-3 pr-3">
                    <span
                      className={cn(
                        "num rounded-md px-1.5 py-0.5 text-[10px] font-semibold",
                        a.event.includes("FROZEN") || a.event.includes("CONFIRMED")
                          ? "bg-green-tint text-green-deep"
                          : a.event.includes("ALERT")
                            ? "bg-red-tint text-red-soft"
                            : "bg-secondary text-ink-2"
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
          Showing {loading ? "—" : `${(safePage - 1) * PAGE_SIZE + 1}–${Math.min(safePage * PAGE_SIZE, filtered.length)} of ${filtered.length}`} sealed entries
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
  const [check, setCheck] = useState<{ valid: boolean; reason: string; tampered: boolean } | null>(null);

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
                  lang
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
                    : "border-line bg-paper text-ink-2 hover:text-foreground"
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
                <div className="micro mb-1.5 text-[9px] text-ink-3">RAW PAYLOAD · EXACTLY WHAT THE CONSUMER RECEIVES</div>
                <pre className="max-h-44 overflow-auto rounded-xl bg-[#0c110e] px-4 py-3 font-mono text-[11.5px] leading-relaxed text-white/85 sv-scroll">
{signed.payload}
                </pre>
              </div>
              <div>
                <div className="micro mb-1.5 text-[9px] text-ink-3">SIGNATURE HEADER · SV-SIGNATURE</div>
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
                      : "border-red-200 bg-red-50 text-red-700"
                  )}
                >
                  {check.valid ? (
                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  )}
                  <div className="text-[12.5px] font-medium leading-relaxed">
                    {check.valid ? "SIGNATURE VALID — " : "SIGNATURE REJECTED — "}
                    <span className="font-normal">{check.reason}</span>
                    {check.tampered && !check.valid && (
                      <span className="mt-0.5 block font-mono text-[11px] text-red-600/80">
                        tamper: risk_score 0.94 → 0.05 · caught by digest
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
          <div className="micro text-[9px] text-ink-3">WHAT YOUR ENDPOINT DOES</div>
          <ol className="mt-3 space-y-2.5">
            {[
              "Read the raw request body as bytes — never a re-serialized parse.",
              "Split the SV-Signature header into t and v1.",
              "Reject if t is older than 5 minutes (replay protection).",
              "Compute HMAC-SHA256(secret, `${t}.${rawBody}`) and compare to v1 in constant time.",
            ].map((s, i) => (
              <li key={i} className="flex gap-2.5 text-[12.5px] leading-relaxed text-ink-2">
                <span className="font-mono text-[11px] font-bold text-primary">{String(i + 1).padStart(2, "0")}</span>
                {s}
              </li>
            ))}
          </ol>
          <p className="mt-4 border-t border-line/70 pt-3 text-[11.5px] leading-relaxed text-ink-3">
            The signing secret lives server-side — like the one behind this demo, it is never shipped to the browser. Verification here is constant-time (timingSafeEqual).
          </p>
        </div>
        <div className="rounded-3xl border border-line bg-[#0c110e] p-6 text-white">
          <div className="font-mono text-[10.5px] uppercase tracking-wider text-white/50">verify in 6 lines</div>
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
