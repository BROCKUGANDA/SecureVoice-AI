"use client";

import { useEffect, useState } from "react";
import {
  Building2,
  KeyRound,
  Coins,
  Users,
  Loader2,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  ImageIcon,
  Plug,
  BookOpen,
  Rocket,
  ShieldCheck,
} from "lucide-react";
import { t, useApp } from "@/lib/store";
import { SUPPORT_EMAIL } from "@/lib/public-config";
import { Chip } from "@/components/fx/core";
import { LottieIcon } from "@/components/fx/LottieIcon";
import { CrmSection } from "@/views/settings/CrmSection";
import { DocumentsSection } from "@/views/settings/DocumentsSection";
import { TwoFactorCard } from "@/components/security/TwoFactorCard";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * Operator Settings — the B2B tabbed surface:
 *   Organization  → white-label (name + logo shown in the Command Center)
 *   API Keys      → BYOK ElevenLabs key (AES-256-GCM encrypted at rest)
 *   Knowledge     → the institution's own policy PDFs, embedded and retrievable
 *   Team          → invite flow (provisioned by invitation; enterprise flow)
 *   Billing       → prepaid credits wallet + tiers
 */

type Settings = {
  orgName: string | null;
  orgLogoUrl: string | null;
  elevenKeyMasked: string | null;
  credits: number;
  /** Bank or insurer - how the institution is spoken about to its customers. */
  institutionType?: "bank" | "insurer";
};

const inputCls = "h-10 rounded-xl border-line bg-paper";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[12px] font-semibold">{label}</Label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-ink-3">{hint}</p>}
    </div>
  );
}

export function Settings() {
  const { lang, setView, highContrast, setHighContrast, settingsTab } = useApp();
  const [tab, setTab] = useState<"org" | "keys" | "knowledge" | "team" | "security" | "billing">(
    settingsTab,
  );
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showKey, setShowKey] = useState(false);

  // local form state
  const [orgName, setOrgName] = useState("");
  const [orgLogoUrl, setOrgLogoUrl] = useState("");
  const [institutionType, setInstitutionType] = useState<"bank" | "insurer">("bank");
  const [elevenKey, setElevenKey] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [producerKeys, setProducerKeys] = useState<
    { id: string; label: string; revoked: boolean; lastUsedAt: string | null; createdAt: string }[]
  >([]);
  const [newKey, setNewKey] = useState<{ key: string; label: string } | null>(null);
  const [keyLabel, setKeyLabel] = useState("");

  useEffect(() => {
    fetch("/api/console/settings")
      .then((r) => r.json())
      .then((d: Settings & { error?: string }) => {
        if (!d.error) {
          setSettings(d);
          setOrgName(d.orgName ?? "");
          setOrgLogoUrl(d.orgLogoUrl ?? "");
          setInstitutionType(d.institutionType === "insurer" ? "insurer" : "bank");
        }
      })
      .catch(() => {});
    fetch("/api/console/producer-keys")
      .then((r) => r.json())
      .then((d: { keys?: typeof producerKeys }) => setProducerKeys(d.keys ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const createProducerKey = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/console/producer-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: keyLabel.trim() || "Fraud engine" }),
      });
      const d = (await r
        .json()
        .catch(() => ({ error: t("Unreadable response", "تعذّر قراءة الاستجابة", lang) }))) as {
        key?: string;
        label?: string;
        error?: string;
      };
      if (!r.ok || !d.key)
        throw new Error(d.error || t("Key creation failed", "فشل إنشاء المفتاح", lang));
      setNewKey({ key: d.key, label: d.label ?? keyLabel });
      setKeyLabel("");
      const list = await fetch("/api/console/producer-keys")
        .then((res) => res.json())
        .catch(() => ({ keys: [] }));
      setProducerKeys(list.keys ?? []);
    } catch (e) {
      setMsg({
        ok: false,
        text: e instanceof Error ? e.message : t("Key creation failed", "فشل إنشاء المفتاح", lang),
      });
    } finally {
      setBusy(false);
    }
  };

  const revokeProducerKey = async (id: string) => {
    await fetch(`/api/console/producer-keys?id=${id}`, { method: "DELETE" });
    setProducerKeys((ks) => ks.map((k) => (k.id === id ? { ...k, revoked: true } : k)));
  };

  const save = async (patch: Record<string, string>) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/console/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const d = (await r.json().catch(() => ({
        error: t("Unreadable response", "تعذّر قراءة الاستجابة", lang),
      }))) as Settings & {
        ok?: boolean;
        error?: string;
      };
      if (!r.ok || d.error) throw new Error(d.error || t("Save failed", "فشل الحفظ", lang));
      setSettings(d);
      setMsg({ ok: true, text: t("Saved.", "تم الحفظ.", lang) });
    } catch (e) {
      setMsg({
        ok: false,
        text: e instanceof Error ? e.message : t("Save failed", "فشل الحفظ", lang),
      });
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    setBusy(true);
    try {
      await fetch("/api/console/settings?field=elevenKey", { method: "DELETE" });
      setSettings((s) => (s ? { ...s, elevenKeyMasked: null } : s));
      setElevenKey("");
      setMsg({
        ok: true,
        text: t(
          "BYOK key removed — the platform key is active again.",
          "تمت إزالة المفتاح الخاص — عاد مفتاح المنصة إلى العمل.",
          lang,
        ),
      });
    } finally {
      setBusy(false);
    }
  };

  const TABS = [
    { id: "org", label: t("Organization", "المؤسسة", lang), icon: Building2 },
    { id: "keys", label: t("API Keys", "مفاتيح API", lang), icon: KeyRound },
    { id: "knowledge", label: t("Knowledge", "المعرفة", lang), icon: BookOpen },
    { id: "team", label: t("Team", "الفريق", lang), icon: Users },
    { id: "security", label: t("Security", "الأمان", lang), icon: ShieldCheck },
    { id: "billing", label: t("Billing", "الفوترة", lang), icon: Coins },
  ] as const;

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex items-center gap-2.5">
        <span className="micro text-primary">{t("SETTINGS", "الإعدادات", lang)}</span>
      </div>
      <h1 className="font-display mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
        {t("Workspace settings", "الإعدادات", lang)}
      </h1>
      {/* The wizard is the ordered path through exactly these tabs — telecom
          identity, BYOK, documents, webhooks. Entering it here rather than from
          the Command Center banner alone means an operator who came here first
          is offered the setup they actually need. */}
      <button
        type="button"
        onClick={() => setView("setup")}
        className="mt-3 inline-flex items-center gap-2 rounded-full border border-primary/40 bg-green-tint px-4 py-2 text-[12.5px] font-semibold text-primary transition hover:bg-green-tint/70"
      >
        <Rocket className="h-3.5 w-3.5" />
        {t("Run setup wizard", "معالج الإعداد", lang)}
      </button>

      {loading ? (
        <div className="mt-10 flex justify-center py-16">
          <LottieIcon
            name="bars"
            size={40}
            label={t("Loading settings", "جارٍ تحميل الإعدادات", lang)}
          />
        </div>
      ) : (
        <>
          {/* tabs */}
          <div className="mt-8 flex gap-1 overflow-x-auto rounded-full border border-line bg-white p-1 sv-scroll">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  setTab(t.id);
                  setMsg(null);
                }}
                aria-pressed={tab === t.id}
                className={cn(
                  "flex flex-1 shrink-0 items-center justify-center gap-1.5 rounded-full px-3.5 py-2 text-[12.5px] font-semibold transition",
                  tab === t.id ? "bg-[#0c110e] text-white" : "text-ink-2 hover:text-foreground",
                )}
              >
                <t.icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            ))}
          </div>

          {msg && (
            <div
              role="status"
              className={cn(
                "mt-4 flex items-center gap-2 rounded-xl px-4 py-3 text-[12.5px] font-medium",
                msg.ok ? "bg-green-tint text-green-deep" : "bg-red-tint text-red-soft",
              )}
            >
              {msg.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
              {msg.text}
            </div>
          )}

          <div className="mt-6 rounded-3xl border border-line bg-white p-6 sm:p-8">
            {tab === "org" && (
              <div className="space-y-5">
                <p className="text-[13px] leading-relaxed text-ink-2">
                  {t(
                    "White-label the Command Center — your institution's name and logo replace SecureVoice branding for every analyst at your bank or insurer.",
                    "اجعل مركز التشغيل بهوية مؤسستك — يحل اسم مؤسستك وشعارها مكان هوية SecureVoice أمام كل محلل في بنكك أو شركة تأمينك.",
                    lang,
                  )}
                </p>
                <Field
                  label={t("Institution type", "نوع المؤسسة", lang)}
                  hint={t(
                    "Changes how calls, voicemails and fallback texts speak to your customers — “your card” for a bank, “your policy” for an insurer. Protective steps are identical: a staged hold that a human confirms.",
                    "يغيّر طريقة مخاطبة المكالمات والرسائل الصوتية والرسائل البديلة لعملائك — «بطاقتك» لبنك، و«وثيقتك» لشركة تأمين. أما خطوات الحماية فهي متطابقة: إيقاف مؤقت للمعاملة يؤكّده موظف.",
                    lang,
                  )}
                >
                  <div
                    role="radiogroup"
                    aria-label={t("Institution type", "نوع المؤسسة", lang)}
                    className="flex gap-2"
                  >
                    {(
                      [
                        { id: "bank", label: t("Bank", "بنك", lang) },
                        { id: "insurer", label: t("Insurer", "شركة تأمين", lang) },
                      ] as const
                    ).map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        role="radio"
                        aria-checked={institutionType === o.id}
                        onClick={() => setInstitutionType(o.id)}
                        className={cn(
                          "flex-1 rounded-xl border px-4 py-2.5 text-[13px] font-semibold transition",
                          institutionType === o.id
                            ? "border-primary bg-green-tint text-green-deep"
                            : "border-line bg-paper text-ink-2 hover:text-foreground",
                        )}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field
                  label={t("Organization display name", "الاسم المعروض للمؤسسة", lang)}
                  hint={t(
                    "Shown in the Command Center header instead of SecureVoice AI.",
                    "يظهر في ترويسة مركز التشغيل بدلًا من SecureVoice AI.",
                    lang,
                  )}
                >
                  <Input
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    placeholder={t(
                      "Emirates National Bank — Fraud Ops  /  Gulf Mutual Insurance — Claims Security",
                      "البنك الوطني الإماراتي — عمليات الاحتيال  /  الخليج للتأمين المتبادل — أمن المطالبات",
                      lang,
                    )}
                    className={inputCls}
                  />
                </Field>
                <Field
                  label={t("Logo URL", "رابط الشعار", lang)}
                  hint={t(
                    "Square PNG/SVG, ≥96px. Served to analysts — use your own CDN.",
                    "صورة مربعة بصيغة PNG/SVG، بقياس 96 بكسل أو أكبر. تُقدَّم للمحللين — استخدم شبكة CDN الخاصة بك.",
                    lang,
                  )}
                >
                  <Input
                    value={orgLogoUrl}
                    onChange={(e) => setOrgLogoUrl(e.target.value)}
                    placeholder="https://your-cdn.ae/logo.png"
                    className={inputCls}
                    dir="ltr"
                  />
                </Field>
                <button
                  onClick={() => save({ orgName, orgLogoUrl, institutionType })}
                  disabled={busy}
                  className="flex items-center gap-2 rounded-full bg-primary px-6 py-2.5 text-[13px] font-semibold text-white transition hover:bg-green-deep disabled:opacity-40"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {t("Save organization", "حفظ بيانات المؤسسة", lang)}
                </button>

                {/* Accessibility — per-analyst display preference, stored locally.
                    WCAG 2.1 AA 1.4.3/1.4.6: a low-vision analyst must be able to
                    raise text contrast without OS-level changes. */}
                <section aria-labelledby="a11y-heading" className="border-t border-line pt-5">
                  <h2 id="a11y-heading" className="text-[13px] font-semibold">
                    {t("Accessibility", "إمكانية الوصول", lang)}
                  </h2>
                  <p className="mt-1 text-[12px] leading-snug text-ink-3">
                    {t(
                      "Display preference for this analyst only — saved on this device, never sent to the server.",
                      "تفضيل عرض خاص بهذا المحلل فقط — يُحفظ على هذا الجهاز، ولا يُرسل إلى الخادم أبدًا.",
                      lang,
                    )}
                  </p>
                  <div className="mt-3 flex items-center justify-between gap-4 rounded-xl border border-line bg-paper px-4 py-3">
                    <div>
                      <Label htmlFor="high-contrast-toggle" className="text-[12.5px] font-semibold">
                        {t("High contrast", "تباين عالٍ", lang)}
                      </Label>
                      <p className="mt-0.5 text-[11.5px] leading-snug text-ink-3">
                        {t(
                          "Near-black text, stronger focus ring, underlined links.",
                          "نص أسود داكن، وحدة تركيز أوضح، وروابط تحتها خط.",
                          lang,
                        )}
                      </p>
                    </div>
                    <Switch
                      id="high-contrast-toggle"
                      checked={highContrast}
                      onCheckedChange={setHighContrast}
                      aria-describedby="high-contrast-hint"
                    />
                  </div>
                  <p id="high-contrast-hint" className="sr-only">
                    {t(
                      "Raises text contrast across the whole workspace to meet WCAG AA.",
                      "يرفع تباين النص في كامل مساحة العمل للتوافق مع معيار WCAG AA.",
                      lang,
                    )}
                  </p>
                </section>
              </div>
            )}

            {tab === "keys" && (
              <div className="space-y-5">
                <p className="text-[13px] leading-relaxed text-ink-2">
                  {t(
                    "Bring Your Own Key — paste your institution's own ElevenLabs API key and your voice usage is billed to your ElevenLabs account directly. Encrypted at rest (AES-256-GCM); only the masked form is ever displayed.",
                    "أحضر مفتاحك الخاص — الصق مفتاح ElevenLabs API الخاص بمؤسستك، فيُحتسب استهلاك الصوت على حساب ElevenLabs الخاص بك مباشرة. يُشفَّر المفتاح أثناء التخزين (AES-256-GCM)، ولا يُعرض سوى شكله المحجوب.",
                    lang,
                  )}
                </p>
                {settings?.elevenKeyMasked && (
                  <div className="flex items-center justify-between rounded-xl border border-[#c4e5d6] bg-green-tint px-4 py-3 text-[12.5px] font-medium text-green-deep">
                    <span className="num flex items-center gap-2">
                      <KeyRound className="h-4 w-4" /> {settings.elevenKeyMasked}
                    </span>
                    <button
                      onClick={removeKey}
                      disabled={busy}
                      className="text-[11.5px] font-semibold text-red-soft underline-offset-2 hover:underline"
                    >
                      {t("Remove", "إزالة", lang)}
                    </button>
                  </div>
                )}
                <Field
                  label={t("ElevenLabs API key", "مفتاح ElevenLabs API", lang)}
                  hint={t(
                    "Create one at app.elevenlabs.io → Profile + API Key. Starts with sk_...",
                    "أنشئ مفتاحًا من app.elevenlabs.io ← Profile + API Key. يبدأ بـ sk_…",
                    lang,
                  )}
                >
                  <div className="relative">
                    <Input
                      type={showKey ? "text" : "password"}
                      value={elevenKey}
                      onChange={(e) => setElevenKey(e.target.value)}
                      placeholder="sk_••••••••••••••••••••••••"
                      className={cn(inputCls, "pr-10 font-mono")}
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey((v) => !v)}
                      aria-label={t("Toggle key visibility", "تبديل ظهور المفتاح", lang)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-3 hover:text-foreground"
                    >
                      {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </Field>
                <button
                  onClick={() => save({ elevenKey })}
                  disabled={busy || elevenKey.trim().length < 20}
                  className="flex items-center gap-2 rounded-full bg-primary px-6 py-2.5 text-[13px] font-semibold text-white transition hover:bg-green-deep disabled:opacity-40"
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <KeyRound className="h-4 w-4" />
                  )}
                  {t("Save key", "حفظ المفتاح", lang)}
                </button>

                <div className="mt-6 border-t border-line pt-6">
                  <p className="flex items-center gap-2 text-[13px] font-semibold">
                    <Plug className="h-4 w-4 text-primary" />
                    {t(
                      "Bank integration keys (headless API)",
                      "مفاتيح تكامل المصرف (واجهة برمجية بدون واجهة)",
                      lang,
                    )}
                  </p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
                    {t(
                      "Your fraud engine fires signals with",
                      "يرسل محرك مكافحة الاحتيال الخاص بك الإشارات باستخدام",
                      lang,
                    )}{" "}
                    <code className="num rounded bg-paper px-1.5 py-0.5 text-[10.5px]">
                      Authorization: Bearer svb_…
                    </code>{" "}
                    {t("against", "إلى", lang)}{" "}
                    <code className="num rounded bg-paper px-1.5 py-0.5 text-[10.5px]">
                      POST /api/interventions
                    </code>
                    {t(
                      ". HMAC signing stays available as an alternative.",
                      ". ويظل توقيع HMAC متاحًا كبديل.",
                      lang,
                    )}
                  </p>
                  {newKey && (
                    <div className="mt-3 rounded-xl border border-[#c4e5d6] bg-green-tint px-4 py-3">
                      <p className="text-[11px] font-semibold text-green-deep">
                        {t("COPY NOW — shown only once", "انسخها الآن — تظهر مرة واحدة فقط", lang)}{" "}
                        ({newKey.label})
                      </p>
                      <p className="num mt-1 break-all text-[12px] text-green-deep">{newKey.key}</p>
                    </div>
                  )}
                  <div className="mt-3 flex gap-2">
                    <Input
                      value={keyLabel}
                      onChange={(e) => setKeyLabel(e.target.value)}
                      placeholder={t(
                        "Key label — e.g. Core banking (prod)",
                        "تسمية المفتاح — مثال: النظم المصرفية الأساسية (إنتاج)",
                        lang,
                      )}
                      className={cn(inputCls, "flex-1")}
                    />
                    <button
                      onClick={createProducerKey}
                      disabled={busy}
                      className="shrink-0 rounded-full border border-primary/40 bg-green-tint px-4 py-2.5 text-[12.5px] font-semibold text-primary transition hover:bg-green-tint/70 disabled:opacity-40"
                    >
                      {t("Create key", "إنشاء مفتاح", lang)}
                    </button>
                  </div>
                  {producerKeys.length > 0 && (
                    <ul className="mt-3 space-y-2">
                      {producerKeys.map((k) => (
                        <li
                          key={k.id}
                          className="flex items-center justify-between gap-3 rounded-xl border border-line bg-paper px-3.5 py-2.5"
                        >
                          <div className="min-w-0">
                            <p className="text-[12px] font-semibold">
                              {k.label}{" "}
                              {k.revoked && (
                                <span className="text-red-soft">
                                  ({t("revoked", "ملغى", lang)})
                                </span>
                              )}
                            </p>
                            <p className="text-[10.5px] text-ink-3">
                              {t("created", "أُنشئ", lang)}{" "}
                              {new Date(k.createdAt).toLocaleDateString()}
                              {k.lastUsedAt
                                ? ` · ${t("last used", "آخر استخدام", lang)} ${new Date(k.lastUsedAt).toLocaleString()}`
                                : ` · ${t("never used", "لم يُستخدم", lang)}`}
                            </p>
                          </div>
                          {!k.revoked && (
                            <button
                              onClick={() => revokeProducerKey(k.id)}
                              className="text-[11px] font-semibold text-red-soft hover:underline"
                            >
                              {t("Revoke", "إلغاء", lang)}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <CrmSection busy={busy} setBusy={setBusy} setMsg={setMsg} />
              </div>
            )}

            {tab === "knowledge" && <DocumentsSection />}

            {tab === "team" && (
              <div className="space-y-5">
                <p className="text-[13px] leading-relaxed text-ink-2">
                  {t(
                    "Analysts are provisioned through secure email invites — no public sign-up. Type a colleague's work email and we'll queue an invite from the fraud-operations admin.",
                    "يُمنح المحللون صلاحياتهم عبر دعوات بريد إلكتروني آمنة — دون تسجيل عام. أدخل بريد عمل زميلك وسنُجهّز دعوة من مسؤول عمليات مكافحة الاحتيال.",
                    lang,
                  )}
                </p>
                <div className="flex gap-2">
                  <Input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="analyst@yourbank.ae"
                    className={cn(inputCls, "flex-1")}
                    dir="ltr"
                  />
                  <button
                    onClick={() => {
                      window.location.href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
                        `${t("SecureVoice seat invite", "دعوة مقعد في SecureVoice", lang)}: ${inviteEmail}`,
                      )}`;
                    }}
                    disabled={!inviteEmail.includes("@")}
                    className="shrink-0 rounded-full bg-primary px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-green-deep disabled:opacity-40"
                  >
                    {t("Invite", "دعوة", lang)}
                  </button>
                </div>
                <p className="rounded-xl bg-paper px-4 py-3 text-[11.5px] leading-relaxed text-ink-3">
                  {t(
                    "Enterprise flow: seats are created manually by the SecureVoice admin against your Better Auth organization, and the invitee sets their own password via a one-time link. Roles:",
                    "مسار المؤسسات: يُنشئ مسؤول SecureVoice المقاعد يدويًا ضمن مؤسستك في Better Auth، ويضع المدعو كلمة مروره بنفسه عبر رابط يُستخدم مرة واحدة. الأدوار:",
                    lang,
                  )}{" "}
                  <span className="font-semibold">{t("Admin", "مسؤول", lang)}</span>{" "}
                  {t(
                    "(billing, seats, all interventions)",
                    "(الفوترة والمقاعد وجميع التدخلات)",
                    lang,
                  )}{" "}
                  · <span className="font-semibold">{t("Analyst", "محلل", lang)}</span>{" "}
                  {t("(Command Center + firing signals)", "(مركز التشغيل وإطلاق الإشارات)", lang)}
                </p>
              </div>
            )}

            {tab === "security" && (
              <div className="space-y-6">
                <TwoFactorCard />

                {/* Session posture, stated plainly: these are the values the
                    server actually enforces today, not aspirations. When they
                    change, this list is the thing reviewers must update. */}
                <div className="rounded-3xl border border-line bg-paper p-6">
                  <h2 className="font-display text-[15px] font-semibold tracking-tight">
                    {t("Session policy", "سياسة الجلسة", lang)}
                  </h2>
                  <ul className="mt-3 space-y-2 text-[12.5px] leading-relaxed text-ink-2">
                    <li>
                      {t(
                        "Sessions expire after 15 minutes of inactivity and 8 hours absolutely — the limits are not rolled forward by activity.",
                        "تنتهي الجلسات بعد ١٥ دقيقة خمول و٨ ساعات كحد أقصى — ولا تُمدّد هذه الحدود بالنشاط.",
                        lang,
                      )}
                    </li>
                    <li>
                      {t(
                        "A wrong password is rate-limited by Better Auth: 30 attempts per minute per client.",
                        "تخمين كلمة المرور محدود بـ ٣٠ محاولة في الدقيقة لكل عميل.",
                        lang,
                      )}
                    </li>
                    <li>
                      {t(
                        "Every sign-in, sign-out and invitation is a row in the audit chain.",
                        "كل دخول وخروج ودعوة هو صف في سجل التدقيق.",
                        lang,
                      )}
                    </li>
                  </ul>
                </div>
              </div>
            )}

            {tab === "billing" && (
              <div className="space-y-6">
                <div className="flex items-center justify-between rounded-2xl border border-line bg-paper px-5 py-4">
                  <div>
                    <p className="micro text-[9px] text-ink-3">
                      {t("PREPAID WALLET", "المحفظة مسبقة الدفع", lang)}
                    </p>
                    <p className="num mt-1 text-2xl font-semibold">
                      {settings?.credits ?? "—"} {t("credits", "رصيد", lang)}
                    </p>
                    <p className="text-[11.5px] text-ink-3">
                      {t(
                        "1 credit = 1 intervention signal · deducted only on success",
                        "الرصيد الواحد = إشارة تدخل واحدة · ولا يُخصم إلا عند النجاح",
                        lang,
                      )}
                    </p>
                  </div>
                  <Coins className="h-8 w-8 text-[#c9a227]" />
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    {
                      name: t("Starter", "البداية", lang),
                      price: "$490",
                      per: t("/month", "/شهريًا", lang),
                      detail: t(
                        "1,000 interventions · 1 bank entity · email support",
                        "1,000 تدخل · جهة مصرفية واحدة · دعم عبر البريد الإلكتروني",
                        lang,
                      ),
                    },
                    {
                      name: t("Pro", "الاحترافية", lang),
                      price: "$1,490",
                      per: t("/month", "/شهريًا", lang),
                      detail: t(
                        "5,000 interventions · 5 entities · priority routing · SLA 99.9%",
                        "5,000 تدخل · 5 جهات · توجيه ذو أولوية · اتفاق مستوى خدمة 99.9%",
                        lang,
                      ),
                    },
                    {
                      name: t("Enterprise", "المؤسسات", lang),
                      price: t("Custom", "حسب الطلب", lang),
                      per: "",
                      detail: t(
                        "Unlimited · VPC deployment · BYOK · custom voice clones · CBUAE audit pack",
                        "غير محدود · نشر على VPC · مفاتيح خاصة · نُسخ صوتية مخصصة · حزمة تدقيق المصرف المركزي",
                        lang,
                      ),
                    },
                  ].map((plan, i) => (
                    <div
                      key={plan.name}
                      className={cn(
                        "rounded-2xl border p-4",
                        i === 1 ? "border-primary bg-green-tint/50" : "border-line bg-paper",
                      )}
                    >
                      <p className="font-display text-[14px] font-semibold">{plan.name}</p>
                      <p className="mt-1">
                        <span className="font-display text-xl font-semibold">{plan.price}</span>
                        <span className="text-[11px] text-ink-3"> {plan.per}</span>
                      </p>
                      <p className="mt-2 text-[11px] leading-snug text-ink-3">{plan.detail}</p>
                    </div>
                  ))}
                </div>
                <a
                  href={`mailto:${SUPPORT_EMAIL}?subject=SecureVoice%20billing`}
                  className="inline-flex items-center gap-2 rounded-full bg-primary px-6 py-2.5 text-[13px] font-semibold text-white transition hover:bg-green-deep"
                >
                  <Coins className="h-4 w-4" />
                  {t("Top up / change plan", "شحن الرصيد / تغيير الخطة", lang)}
                </a>
              </div>
            )}
          </div>

          <div className="mt-6 flex items-center gap-2 text-[12px] text-ink-3">
            <ImageIcon className="h-3.5 w-3.5" />
            {t(
              "White-label preview appears in the Command Center header immediately after saving.",
              "تظهر معاينة الهوية الخاصة بمؤسستك في ترويسة مركز التشغيل فورًا بعد الحفظ.",
              lang,
            )}
            <button
              onClick={() => setView("console")}
              className="font-semibold text-primary hover:underline"
            >
              {t("Open Command Center →", "فتح مركز التشغيل ←", lang)}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
