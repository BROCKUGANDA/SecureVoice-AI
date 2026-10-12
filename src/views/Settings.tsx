"use client";

import { useEffect, useMemo, useState } from "react";
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
import { PLANS, formatMonthly } from "@/lib/commercial";
import { PolicyForPlan } from "@/components/legal/PolicyForPlan";
import { SUPPORT_EMAIL } from "@/lib/public-config";
import { brandPreview, evaluateBrandPrimary } from "@/lib/brand/color";
import { Chip } from "@/components/fx/core";
import { LoadingIndicator } from "@/components/fx/LoadingIndicator";
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
  /** Normalised `#rrggbb`, already contrast-validated server-side. Null = default. */
  brandPrimary?: string | null;
  elevenKeyMasked: string | null;
  /**
   * Which paid features this tenant's plan unlocks, resolved server-side by
   * `src/lib/billing/entitlements.ts` from the SAME context the POST refuses with.
   * Optional because a response from before this field existed is a legitimate
   * shape an older deployment still serves; the UI then says nothing rather than
   * guessing "included".
   */
  entitlements?: { byok: boolean; signedWebhooks: boolean } | null;
  credits: number;
  /** Bank or insurer - how the institution is spoken about to its customers. */
  institutionType?: "bank" | "insurer";
  /**
   * Resolved server-side by `src/lib/billing/plan-context.ts`: mirrored
   * subscription, then `Organization.planTier`, then the deployment default, then
   * `demo`. Never accepted from the client — a tenant that can name its own tier
   * can name itself a refund policy it did not buy.
   */
  planTier?: "demo" | "standard" | "enterprise";
  /** Catalog plan id (`starter|growth|enterprise`), or null when nothing named one. */
  planName?: string | null;
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
  const [brandPrimary, setBrandPrimary] = useState("");
  const [elevenKey, setElevenKey] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<string | null>(null);
  const [producerKeys, setProducerKeys] = useState<
    { id: string; label: string; revoked: boolean; lastUsedAt: string | null; createdAt: string }[]
  >([]);
  const [newKey, setNewKey] = useState<{ key: string; label: string } | null>(null);
  const [keyLabel, setKeyLabel] = useState("");

  // The gate, run on every keystroke so the operator sees a refusal and its
  // reason before they press Save rather than after. Empty means "no colour set",
  // which is a valid state and shows no preview — so the check is on the
  // TRIMMED value, not on truthiness.
  const brandVerdict = useMemo(
    () => (brandPrimary.trim() ? evaluateBrandPrimary(brandPrimary) : null),
    [brandPrimary],
  );
  // What the colour picker shows when there is no tenant colour: the platform
  // default, matching globals.css `:root`.
  const brandSwatch = useMemo(() => brandPreview(brandPrimary), [brandPrimary]);

  useEffect(() => {
    fetch("/api/console/settings")
      .then((r) => r.json())
      .then((d: Settings & { error?: string }) => {
        if (!d.error) {
          setSettings(d);
          setOrgName(d.orgName ?? "");
          setOrgLogoUrl(d.orgLogoUrl ?? "");
          setInstitutionType(d.institutionType === "insurer" ? "insurer" : "bank");
          setBrandPrimary(d.brandPrimary ?? "");
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
          <LoadingIndicator label={t("Loading settings", "جارٍ تحميل الإعدادات", lang)} />
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

                {/* Brand colour. The gate runs in the BROWSER too, via the same
                    `evaluateBrandPrimary` the route runs, so the operator sees a
                    refusal and its reason before they press Save instead of
                    after. It is a preview, not the authority: the server
                    re-runs the identical function, and the database constrains
                    the shape. */}
                <Field
                  label={t("Brand colour", "لون الهوية", lang)}
                  hint={t(
                    "Your primary colour, used for buttons, focus rings and the sidebar. Checked against WCAG AA — a colour that cannot carry readable text is corrected or refused, never applied as-is.",
                    "لونك الأساسي، يُستخدم للأزرار وحلقات التركيز والشريط الجانبي. يُفحص مقابل معيار WCAG AA — أي لون لا يحتمل نصًا مقروءًا يُصحَّح أو يُرفض، ولا يُطبَّق كما هو.",
                    lang,
                  )}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <input
                      type="color"
                      aria-label={t("Brand colour picker", "منتقي لون الهوية", lang)}
                      value={brandSwatch.primary}
                      onChange={(e) => setBrandPrimary(e.target.value)}
                      className="h-10 w-14 cursor-pointer rounded-lg border border-line bg-paper p-1"
                    />
                    <Input
                      value={brandPrimary}
                      onChange={(e) => setBrandPrimary(e.target.value)}
                      placeholder={t("#0b7a55", "#0b7a55", lang)}
                      aria-label={t("Brand colour hex value", "قيمة لون الهوية", lang)}
                      className={cn(inputCls, "max-w-[11rem]")}
                      dir="ltr"
                    />
                    {brandPrimary.trim() ? (
                      <button
                        type="button"
                        onClick={() => setBrandPrimary("")}
                        className="text-[12px] font-semibold text-ink-3 underline underline-offset-2 hover:text-foreground"
                      >
                        {t("Use the platform default", "استخدم لون المنصة الافتراضي", lang)}
                      </button>
                    ) : null}
                  </div>

                  {brandVerdict ? (
                    brandVerdict.ok ? (
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <span
                          className="inline-flex items-center rounded-full px-3.5 py-1.5 text-[12px] font-semibold"
                          style={{
                            background: brandVerdict.lightPrimary,
                            color: brandVerdict.lightForeground,
                          }}
                        >
                          {t("Preview", "معاينة", lang)}
                        </span>
                        <span className="text-[12px] text-ink-3">
                          {t("Text contrast", "تباين النص", lang)} {brandVerdict.contrast}:1
                          {/* Says so out loud when a scheme was corrected — a
                              silent adjustment is a colour the tenant did not
                              choose, and they are entitled to know. */}
                          {brandVerdict.lightPrimary !== brandVerdict.primary ||
                          brandVerdict.darkPrimary !== brandVerdict.primary
                            ? t(" · adjusted for contrast", " · مُعدَّل لأجل التباين", lang)
                            : ""}
                        </span>
                      </div>
                    ) : (
                      <p role="alert" className="mt-2 text-[12px] font-semibold text-red-soft">
                        {brandVerdict.detail}
                      </p>
                    )
                  ) : null}
                </Field>

                <button
                  onClick={() => save({ orgName, orgLogoUrl, institutionType, brandPrimary })}
                  disabled={busy || brandVerdict?.ok === false}
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
                {/* The server refuses this field on a plan that does not include it
                    (402 `plan_entitlement_required`). Showing the input as though it
                    worked and letting the operator discover that on Save is the same
                    class of lie as a pricing card that omits the feature: the
                    interface is making a claim about what this tenant bought. */}
                {settings?.entitlements && !settings.entitlements.byok && (
                  <p className="rounded-xl border border-line bg-paper px-4 py-3 text-[12.5px] leading-relaxed text-ink-2">
                    {t(
                      "Not included in your plan. Attaching your own ElevenLabs key needs a Growth subscription — upgrading unlocks this field, and nothing here has been changed.",
                      "غير مشمول في خطتك. إرفاق مفتاح ElevenLabs الخاص بك يتطلب اشتراك Growth، وعند الترقية يُفتح هذا الحقل، ولم يتغير أي شيء هنا.",
                      lang,
                    )}
                  </p>
                )}
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
                      void (async () => {
                        if (inviteBusy || !inviteEmail.includes("@")) return;
                        setInviteBusy(true);
                        setInviteMsg(null);
                        try {
                          const res = await fetch("/api/auth/invites", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ email: inviteEmail, role: "Analyst" }),
                          });
                          const data = (await res.json().catch(() => ({}))) as {
                            ok?: boolean;
                            error?: string;
                          };
                          if (res.ok && data.ok) {
                            setInviteMsg(
                              t(
                                "Invite sent — the link expires in 72 hours.",
                                "تم إرسال الدعوة — تنتهي صلاحية الرابط بعد ٧٢ ساعة.",
                                lang,
                              ),
                            );
                            setInviteEmail("");
                          } else if (res.status === 428) {
                            setInviteMsg(
                              t(
                                "Confirm it's you first: open the Security tab, complete the password confirmation, then send the invite again.",
                                "أكّد هويتك أولًا: افتح تبويب الأمان وأكّد كلمة المرور ثم أعد إرسال الدعوة.",
                                lang,
                              ),
                            );
                          } else {
                            setInviteMsg(
                              data.error ??
                                t(
                                  "The invite could not be sent.",
                                  "تعذّر إرسال الدعوة.",
                                  lang,
                                ),
                            );
                          }
                        } catch {
                          setInviteMsg(
                            t(
                              "Network error — the invite was not sent.",
                              "خطأ في الشبكة — لم يتم إرسال الدعوة.",
                              lang,
                            ),
                          );
                        } finally {
                          setInviteBusy(false);
                        }
                      })();
                    }}
                    disabled={!inviteEmail.includes("@") || inviteBusy}
                    className="shrink-0 rounded-full bg-primary px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-green-deep disabled:opacity-40"
                  >
                    {inviteBusy
                      ? t("Inviting…", "جارٍ الإرسال…", lang)
                      : t("Invite", "دعوة", lang)}
                  </button>
                </div>
                {inviteMsg && (
                  <p
                    className={cn(
                      "rounded-xl px-4 py-3 text-[11.5px] leading-relaxed",
                      inviteMsg.startsWith(t("Invite sent", "تم إرسال الدعوة", lang))
                        ? "bg-green-tint text-green-deep"
                        : "bg-red-tint text-red-soft",
                    )}
                    role="status"
                  >
                    {inviteMsg}
                  </p>
                )}
                <p className="rounded-xl bg-paper px-4 py-3 text-[11.5px] leading-relaxed text-ink-3">
                  {t(
                    "The invite reaches the email above as a one-time link that expires in 72 hours; the invitee sets their own password. Roles:",
                    "تصل الدعوة إلى البريد أعلاه كرابط يُستخدم مرة واحدة وينتهي بعد ٧٢ ساعة؛ ويضع المدعو كلمة مروره بنفسه. الأدوار:",
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
                {/* Rendered from `@/lib/commercial`, like the home page and
                    /pricing. This was a THIRD inline copy of the prices and had
                    already drifted — it still read $490 / $1,490 / Enterprise
                    after the catalog moved to $10 / $40 / $120. */}
                <div className="grid gap-3 sm:grid-cols-3">
                  {PLANS.map((plan, i) => (
                    <div
                      key={plan.id}
                      className={cn(
                        "rounded-2xl border p-4",
                        i === 1 ? "border-primary bg-green-tint/50" : "border-line bg-paper",
                      )}
                    >
                      <p className="font-display text-[14px] font-semibold">
                        {t(plan.name, plan.nameAr, lang)}
                      </p>
                      <p className="mt-1">
                        <span className="font-display text-xl font-semibold">
                          {formatMonthly(plan, lang)}
                        </span>
                        <span className="text-[11px] text-ink-3">{t("/mo", "/شهر", lang)}</span>
                      </p>
                      <p className="mt-2 text-[11px] leading-snug text-ink-3">
                        {t(plan.summary, plan.summaryAr, lang)}
                      </p>
                    </div>
                  ))}
                </div>
                {/* Top-up goes through the NEW checkout route rather than a
                    `mailto:` link — see src/app/api/billing/checkout/route.ts.
                    The checkout needs a price id, which is resolved from the
                    gateway's configured price map, so this opens the checkout
                    rather than claiming to have started one. */}
                <p className="mt-4 text-[11.5px] leading-relaxed text-ink-3">
                  {t(
                    "Plans are billed through Paddle, our Merchant of Record, which handles sales tax and VAT. Checkout opens hosted by Paddle.",
                    "تُفترَط الخطط عبر Paddle، التاجر الرسمي، الذي يتولى ضريبة البيع والقيمة المضافة. وتُفتح عملية الدفع على موقع Paddle.",
                    lang,
                  )}
                </p>
                {/* The conditional policy, in-app where the tier is known. The
                    server resolves it (see `Settings.planTier` above): this call
                    used to pass a literal `null`, which is the DEMO tier, so a
                    paying bank was shown the no-refunds policy while its wallet
                    was being billed as a `creditWallet` tenant. */}
                <PolicyForPlan planTier={settings?.planTier ?? null} className="mt-5" />
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
