"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Loader2,
  Rocket,
  Send,
  XCircle,
} from "lucide-react";
import { useApp, t } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { DocumentsSection } from "@/views/settings/DocumentsSection";
import { LoadingIndicator } from "@/components/fx/LoadingIndicator";

/**
 * The five-step institution setup wizard.
 *
 * One step per request, each step validating and saving independently, so a
 * half-finished setup is still progress rather than a form that is thrown away
 * when the browser tab closes. Progress lives on the organization (see
 * src/lib/setup.ts), which is why resuming works across sessions and across
 * administrators.
 *
 * Secrets are write-only. A field that already holds a stored key renders as
 * "configured — leave blank to keep", never as a value: the server will not send
 * it back and the UI must not pretend otherwise.
 *
 * "Skip for now" resets progress but deliberately does NOT mark setup complete.
 * Skipped is not onboarded — conflating the two would let the Command Center
 * claim an institution is configured when it is not.
 */

type StepDef = { id: number; key: string; title: string; blurb: string };

type SetupState = {
  step: number;
  completed: boolean;
  completedAt: string | null;
  totalSteps: number;
  steps: StepDef[];
  org: {
    name: string;
    logoUrl: string | null;
    institutionType: "bank" | "insurer";
    region: string | null;
    shariahCompliant: boolean;
  };
  telecom: {
    twilioVoiceNumber: string | null;
    twilioSmsSenderId: string | null;
    twilioMessagingServiceSid: string | null;
    twilioAuthTokenConfigured: boolean;
  };
  ai: { elevenKeyMasked: string | null; llmKeyMasked: string | null; llmBaseUrl: string | null };
  webhooks: { vendorWebhookUrl: string | null; vendorWebhookSecretConfigured: boolean };
};

const REGIONS = ["UAE", "GCC", "MENA", "OTHER"] as const;

/**
 * Arabic rendering of the step copy the server sends (see SETUP_STEPS in
 * src/lib/setup.ts, which is English-only and has no locale of its own). Keyed
 * by the server's step key, and always falling back to the server's own string,
 * so a step the server adds later still renders rather than blanking out.
 */
const STEP_COPY: Record<string, { title: string; blurb: string }> = {
  profile: {
    title: "ملف المؤسسة",
    blurb: "كيف تُسمّى مؤسستك وكيف يُتحدَّث عنها",
  },
  telecom: {
    title: "هوية الاتصالات",
    blurb: "الرقم الذي يسمعه العملاء، ومعرّف مرسل الرسائل النصية الذي يرونه",
  },
  ai: {
    title: "مفاتيح الذكاء الاصطناعي (BYOK)",
    blurb: "مرِّر الصوت والاستدلال عبر حسابات المزوّدين الخاصة بك",
  },
  documents: {
    title: "المستندات والبيانات",
    blurb: "مستندات السياسة الخاصة بمؤسستك، والمكان الذي تُحفظ فيه بيانات العملاء",
  },
  webhooks: {
    title: "Webhooks",
    blurb: "المكان الذي تُبلَّغ فيه أنظمتك الخاصة بما جرى",
  },
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

/** "already stored" marker. Says nothing about the value — the server will not re-send it. */
function StoredTag() {
  const { lang } = useApp();
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-green-tint px-2 py-0.5 text-[10.5px] font-semibold text-green-deep">
      <Check className="h-3 w-3" /> {t("configured", "مُهيّأ", lang)}
    </span>
  );
}

export function SetupWizard() {
  const { lang, setView } = useApp();
  const [state, setState] = useState<SetupState | null>(null);
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [webhookResult, setWebhookResult] = useState<{
    ok: boolean;
    status: number;
    ms: number;
    error?: string;
  } | null>(null);

  // form state
  const [orgName, setOrgName] = useState("");
  const [orgLogoUrl, setOrgLogoUrl] = useState("");
  const [institutionType, setInstitutionType] = useState<"bank" | "insurer">("bank");
  const [region, setRegion] = useState<string>("UAE");
  const [shariah, setShariah] = useState(false);
  const [voiceNumber, setVoiceNumber] = useState("");
  const [senderId, setSenderId] = useState("");
  const [messagingSid, setMessagingSid] = useState("");
  const [twilioToken, setTwilioToken] = useState("");
  const [elevenKey, setElevenKey] = useState("");
  const [llmKey, setLlmKey] = useState("");
  const [llmBaseUrl, setLlmBaseUrl] = useState("");
  const [pdpl, setPdpl] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");

  const applyState = useCallback((s: SetupState) => {
    setState(s);
    setStep(s.step);
    setOrgName(s.org.name);
    setOrgLogoUrl(s.org.logoUrl ?? "");
    setInstitutionType(s.org.institutionType);
    setRegion(s.org.region ?? "UAE");
    setShariah(s.org.shariahCompliant);
    setVoiceNumber(s.telecom.twilioVoiceNumber ?? "");
    setSenderId(s.telecom.twilioSmsSenderId ?? "");
    setMessagingSid(s.telecom.twilioMessagingServiceSid ?? "");
    setLlmBaseUrl(s.ai.llmBaseUrl ?? "");
    setWebhookUrl(s.webhooks.vendorWebhookUrl ?? "");
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/console/setup");
      const d = (await r.json().catch(() => ({}))) as SetupState & { error?: string };
      if (!d.error && typeof d.step === "number") applyState(d);
    } finally {
      setLoading(false);
    }
  }, [applyState]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveStep = async (data: Record<string, unknown>, next: number) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch("/api/console/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", step, data }),
      });
      const d = (await r
        .json()
        .catch(() => ({ error: t("Unreadable response", "تعذّر قراءة الاستجابة", lang) }))) as {
        ok?: boolean;
        error?: string;
        step?: number;
      };
      if (!r.ok || d.error)
        throw new Error(d.error || t("Could not save this step", "تعذّر حفظ هذه الخطوة", lang));
      setStep(next);
      setNotice(t("Saved.", "تم الحفظ.", lang));
      // Re-read rather than trusting local form state: the server is the only
      // place that knows what was actually persisted.
      await load();
      // Secrets are never re-displayed, so the typed values must not survive.
      setElevenKey("");
      setLlmKey("");
      setTwilioToken("");
      setWebhookSecret("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save this step");
    } finally {
      setBusy(false);
    }
  };

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch("/api/console/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await r.json().catch(() => ({ error: "Unreadable response" }))) as {
        ok?: boolean;
        error?: string;
      };
      if (!r.ok || d.error) throw new Error(d.error || "Request failed");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Request failed", "فشل الطلب", lang));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const testWebhook = async () => {
    setBusy(true);
    setWebhookResult(null);
    setError(null);
    try {
      const r = await fetch("/api/console/webhooks/test", { method: "POST" });
      const d = (await r
        .json()
        .catch(() => ({ error: t("Unreadable response", "تعذّر قراءة الاستجابة", lang) }))) as {
        ok?: boolean;
        status?: number;
        ms?: number;
        error?: string;
      };
      setWebhookResult({
        ok: Boolean(d.ok),
        status: d.status ?? 0,
        ms: d.ms ?? 0,
        ...(d.error ? { error: d.error } : {}),
      });
    } catch (e) {
      setWebhookResult({
        ok: false,
        status: 0,
        ms: 0,
        error: e instanceof Error ? e.message : t("Request failed", "فشل الطلب", lang),
      });
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <LoadingIndicator label={t("Loading setup", "جارٍ تحميل معالج الإعداد", lang)} />
      </div>
    );
  }

  const steps: StepDef[] = state?.steps ?? [];
  const total = state?.totalSteps ?? 5;
  const current = steps.find((s) => s.id === step);

  /** Localised step copy, with the server's own English as the fallback. */
  const stepTitle = (s: StepDef | undefined) =>
    s ? t(s.title, STEP_COPY[s.key]?.title ?? s.title, lang) : "";
  const stepBlurb = (s: StepDef | undefined) =>
    s ? t(s.blurb, STEP_COPY[s.key]?.blurb ?? s.blurb, lang) : "";

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex items-center gap-2.5">
        <span className="micro text-primary">{t("SETUP", "الإعداد", lang)}</span>
        {state?.completed && (
          <span className="rounded-full bg-green-tint px-2.5 py-0.5 text-[10.5px] font-semibold text-green-deep">
            {t("completed", "مكتمل", lang)}
          </span>
        )}
      </div>
      <h1 className="font-display mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
        {t("Set up your institution", "إعداد المؤسسة", lang)}
      </h1>
      <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-ink-2">
        {t(
          "Five steps, saved one at a time on your institution — so you can come back to this later, or from a colleague's account, and pick up where you left off.",
          "خمس خطوات، تُحفظ كل خطوة على حدة في مؤسستك — لذا يمكنك العودة إلى هنا لاحقًا، أو من حساب زميل آخر، ومتابعة العمل من حيث توقفت.",
          lang,
        )}
      </p>

      {/* Step rail. The current step is announced as well as marked, so the
          position is not conveyed by colour alone (WCAG 1.4.1). */}
      <ol
        className="mt-8 flex flex-wrap gap-2"
        aria-label={t("Setup steps", "خطوات الإعداد", lang)}
      >
        {steps.map((s) => {
          const done = s.id < step || Boolean(state?.completed);
          const active = s.id === step;
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setStep(s.id)}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-full border px-3.5 py-2 text-[12px] font-semibold transition",
                  active
                    ? "border-primary bg-green-tint text-green-deep"
                    : done
                      ? "border-line bg-white text-ink-2"
                      : "border-line bg-paper text-ink-3",
                )}
              >
                <span
                  className={cn(
                    "num flex h-5 w-5 items-center justify-center rounded-full text-[10.5px]",
                    done
                      ? "bg-primary text-white"
                      : active
                        ? "bg-primary text-white"
                        : "bg-line text-ink-3",
                  )}
                >
                  {done ? <Check className="h-3 w-3" /> : s.id}
                </span>
                {stepTitle(s)}
              </button>
            </li>
          );
        })}
      </ol>

      {(error || notice) && (
        <div
          role="status"
          className={cn(
            "mt-4 flex items-center gap-2 rounded-xl px-4 py-3 text-[12.5px] font-medium",
            error ? "bg-red-tint text-red-soft" : "bg-green-tint text-green-deep",
          )}
        >
          {error ? <XCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
          {error ?? notice}
        </div>
      )}

      <div className="mt-6 rounded-3xl border border-line bg-white p-6 sm:p-8">
        <h2 className="font-display text-lg font-semibold">{stepTitle(current)}</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">{stepBlurb(current)}</p>

        <div className="mt-6 space-y-5">
          {step === 1 && (
            <>
              <Field
                label={t("Institution display name", "الاسم المعروض للمؤسسة", lang)}
                hint={t(
                  "Shown to your analysts instead of SecureVoice AI.",
                  "يظهر لمحليك بدلًا من SecureVoice AI.",
                  lang,
                )}
              >
                <Input
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder={t(
                    "Emirates National Bank — Fraud Operations",
                    "البنك الوطني الإماراتي — عمليات الاحتيال",
                    lang,
                  )}
                  className={inputCls}
                />
              </Field>
              <Field
                label={t("Logo URL", "رابط الشعار", lang)}
                hint={t(
                  "Square PNG/SVG on your own CDN. There is no blob storage in this deployment, so the console takes a URL rather than a file.",
                  "صورة مربعة بصيغة PNG/SVG على شبكة CDN الخاصة بك. لا يتوفر تخزين ملفات في هذا النشر، لذا تأخذ اللوحة رابطًا بدلًا من ملف.",
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
              <Field
                label={t("Institution type", "نوع المؤسسة", lang)}
                hint={t(
                  "Changes how the agent speaks to YOUR customers — “your card” for a bank, “your policy” for an insurer. Protective steps are identical: a staged hold that a human confirms.",
                  "يغيّر طريقة حديث الوكيل إلى عملائك — «بطاقتك» لبنك، و«وثيقتك» لشركة تأمين. أما خطوات الحماية فهي متطابقة: إيقاف مؤقت للمعاملة يؤكّده موظف.",
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
                        "flex-1 rounded-xl border px-4 py-2.5 text-[13px] font-semibold capitalize transition",
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
              <p className="rounded-xl bg-paper px-4 py-3 text-[11.5px] leading-relaxed text-ink-3">
                {t(
                  "Islamic banks and Takaful operators pick their own type and turn on the Shariah switch below — there is deliberately no third type, because the switch drives the speech gate and the type drives what the product is called.",
                  "تختار البنوك الإسلامية وشركات التكافل نوعها الخاص وتُشغّل مفتاح المصطلحات الشرعية أدناه — لا يوجد نوع ثالث عن قصد، لأن المفتاح يتحكم في بوابة النص المنطوق، والنوع يحدد ما يُطلق على المنتج.",
                  lang,
                )}
              </p>
              <Field
                label={t("Region", "المنطقة", lang)}
                hint={t(
                  "Recorded on the audit trail — where your customers are.",
                  "يُسجَّل في مسار التدقيق — حيث يقع عملاؤك.",
                  lang,
                )}
              >
                <div
                  role="radiogroup"
                  aria-label={t("Region", "المنطقة", lang)}
                  className="flex flex-wrap gap-2"
                >
                  {REGIONS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      role="radio"
                      aria-checked={region === r}
                      onClick={() => setRegion(r)}
                      className={cn(
                        "rounded-xl border px-4 py-2 text-[12.5px] font-semibold transition",
                        region === r
                          ? "border-primary bg-green-tint text-green-deep"
                          : "border-line bg-paper text-ink-2 hover:text-foreground",
                      )}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </Field>
              <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-paper px-4 py-3">
                <div>
                  <Label htmlFor="shariah-switch" className="text-[12.5px] font-semibold">
                    {t("Shariah-compliant terminology", "مصطلحات متوافقة مع الشريعة", lang)}
                  </Label>
                  <p className="mt-0.5 text-[11.5px] leading-snug text-ink-3">
                    {t(
                      "Substitutes the institution's own product vocabulary in what is spoken to customers. Conventional tenants must leave this off.",
                      "يستبدل مفردات المنتج الخاصة بمؤسستك فيما يُقال للعملاء. على المؤسسات غير الإسلامية إبقاء هذا الخيار مُغلقًا.",
                      lang,
                    )}
                  </p>
                </div>
                <Switch id="shariah-switch" checked={shariah} onCheckedChange={setShariah} />
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className="rounded-xl bg-paper px-4 py-3 text-[11.5px] leading-relaxed text-ink-3">
                {t(
                  "This is the identity customers see. Saving it changes live call routing and the SMS sender — which is the point: it is your number, not the platform's.",
                  "هذه هي الهوية التي يراها العملاء. حفظها يغيّر توجيه المكالمات المباشر ومرسل الرسائل النصية — وهذا هو المطلوب: إنه رقمك أنت، لا رقم المنصة.",
                  lang,
                )}
              </p>
              <Field
                label={t("Voice number (E.164)", "رقم الصوت (E.164)", lang)}
                hint={t(
                  "The number your fraud desk calls back on, and the caller ID customers see.",
                  "الرقم الذي يعاود مكتب مكافحة الاحتيال الاتصال عليه، والمعرّف الذي يراه العملاء على شاشتهم.",
                  lang,
                )}
              >
                <Input
                  value={voiceNumber}
                  onChange={(e) => setVoiceNumber(e.target.value)}
                  placeholder="+97145550123"
                  className={cn(inputCls, "num")}
                  dir="ltr"
                />
              </Field>
              <Field
                label={t("SMS sender ID", "معرّف مرسل الرسائل", lang)}
                hint={t(
                  "2–16 letters, digits, spaces or dashes. Registered with your carrier.",
                  "من 2 إلى 16 حرفًا أو رقمًا أو مسافة أو شرطة. مُسجَّل لدى مزوّد خدمة الاتصالات.",
                  lang,
                )}
              >
                <Input
                  value={senderId}
                  onChange={(e) => setSenderId(e.target.value)}
                  placeholder="ENB FRAUD"
                  className={inputCls}
                  dir="ltr"
                />
              </Field>
              <Field
                label={t("Messaging service SID (optional)", "معرّف خدمة الرسائل (اختياري)", lang)}
              >
                <Input
                  value={messagingSid}
                  onChange={(e) => setMessagingSid(e.target.value)}
                  placeholder="MG00000000000000000000000000000000"
                  className={cn(inputCls, "num")}
                  dir="ltr"
                />
              </Field>
              <Field
                label={t("Twilio auth token", "رمز مصادقة Twilio", lang)}
                hint={t(
                  "Sealed with AES-256-GCM at rest. Written once — it is never displayed again.",
                  "مُشفَّر بتقنية AES-256-GCM أثناء التخزين. يُكتب مرة واحدة — ولا يُعراض مرة أخرى أبدًا.",
                  lang,
                )}
              >
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    value={twilioToken}
                    onChange={(e) => setTwilioToken(e.target.value)}
                    placeholder={
                      state?.telecom.twilioAuthTokenConfigured
                        ? t("•••• stored", "•••• مخزَّن", lang)
                        : t("auth token", "رمز المصادقة", lang)
                    }
                    className={cn(inputCls, "font-mono")}
                    autoComplete="off"
                  />
                  {state?.telecom.twilioAuthTokenConfigured && <StoredTag />}
                </div>
              </Field>
            </>
          )}

          {step === 3 && (
            <>
              <p className="rounded-xl bg-paper px-4 py-3 text-[11.5px] leading-relaxed text-ink-3">
                {t(
                  "Your keys, your provider accounts. Leave the fields blank to keep whatever is already stored — a blank submission never clears a working key.",
                  "مفاتيحك أنت، وحسابات المزوّدين الخاصة بك. اترك الحقول فارغة للاحتفاظ بما هو محفوظ بالفعل — فلا يؤدي الإرسال الفارغ إلى حذف مفتاح يعمل.",
                  lang,
                )}
              </p>
              <Field
                label={t("ElevenLabs API key", "مفتاح ElevenLabs API", lang)}
                hint={t("Voice synthesis. Starts with sk_…", "توليف الصوت. يبدأ بـ sk_…", lang)}
              >
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    value={elevenKey}
                    onChange={(e) => setElevenKey(e.target.value)}
                    placeholder={state?.ai.elevenKeyMasked ?? "sk_••••••••••••"}
                    className={cn(inputCls, "font-mono")}
                    autoComplete="off"
                  />
                  {state?.ai.elevenKeyMasked && <StoredTag />}
                </div>
              </Field>
              <Field
                label={t("LLM API key (optional)", "مفتاح نموذج اللغة (اختياري)", lang)}
                hint={t(
                  "Any OpenAI-compatible provider. Takes precedence over the platform's own chain for your tenant.",
                  "أي مزوّد متوافق مع OpenAI. له أولوية على سلسلة المنصة الخاصة بمستأجرك.",
                  lang,
                )}
              >
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    value={llmKey}
                    onChange={(e) => setLlmKey(e.target.value)}
                    placeholder={state?.ai.llmKeyMasked ?? "sk-••••••••••••"}
                    className={cn(inputCls, "font-mono")}
                    autoComplete="off"
                  />
                  {state?.ai.llmKeyMasked && <StoredTag />}
                </div>
              </Field>
              <Field
                label={t("LLM base URL (optional)", "عنوان URL الأساسي للنموذج (اختياري)", lang)}
                hint={t(
                  "Set this when your bank fronts its own model gateway. Shown to you, not hidden — you should be able to see where the key goes.",
                  "اضبط هذا عندما يكون لمصرفك بوابة نماذج خاصة به. معروض لك، وليس مخفيًا — يجب أن تكون قادرًا على رؤية وجهة المفتاح.",
                  lang,
                )}
              >
                <Input
                  value={llmBaseUrl}
                  onChange={(e) => setLlmBaseUrl(e.target.value)}
                  placeholder="https://llm-gateway.yourbank.ae/v1"
                  className={cn(inputCls, "num")}
                  dir="ltr"
                />
              </Field>
            </>
          )}

          {step === 4 && (
            <>
              <DocumentsSection compact />
              <div className="flex items-start gap-3 rounded-xl border border-line bg-paper px-4 py-3.5">
                <input
                  id="pdpl"
                  type="checkbox"
                  checked={pdpl}
                  onChange={(e) => setPdpl(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[#0c110e]"
                />
                <label htmlFor="pdpl" className="text-[11.5px] leading-relaxed text-ink-2">
                  {t(
                    "I confirm customer data is held in-region for this deployment (UAE/GCC data residency), that transcripts are redacted before indexing, and that the documents above are my institution's own material to process.",
                    "أُؤكد أن بيانات العملاء محفوظة داخل المنطقة في هذا النشر (إقامة البيانات في الإمارات/دول مجلس التعاون الخليجي)، وأن النصوص المكتوبة للمكالمات تُنقّى قبل الفهرسة، وأن المستندات أعلاه مادة خاصة بمؤسستي ولها الحق في معالجتها.",
                    lang,
                  )}{" "}
                  <span className="font-semibold">
                    {t("This acknowledgement is recorded.", "يُسجَّل هذا الإقرار.", lang)}
                  </span>
                </label>
              </div>
            </>
          )}

          {step === 5 && (
            <>
              <Field
                label={t("Vendor webhook URL", "رابط Webhook للمزوّد", lang)}
                hint={t(
                  "Where YOUR systems are told what happened to YOUR cases. Validated against internal addresses before it is saved and again before every delivery.",
                  "المكان الذي تُبلَّغ فيه أنظمتك بما حدث لحالاتك. يُتحقق من العنوان مقابل العناوين الداخلية قبل الحفظ، ثم مرة أخرى قبل كل عملية إرسال.",
                  lang,
                )}
              >
                <Input
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://fraud.yourbank.ae/securevoice"
                  className={cn(inputCls, "num")}
                  dir="ltr"
                />
              </Field>
              <Field
                label={t("Signing secret (write-only)", "سر التوقيع (للكتابة فقط)", lang)}
                hint={t(
                  "HMAC-SHA256 over “timestamp.body”. Sealed at rest; never returned by the API.",
                  "بصمة HMAC-SHA256 على «الطابع الزمني.النص». مُشفَّر أثناء التخزين، ولا تُعاد أبدًا عبر الواجهة البرمجية.",
                  lang,
                )}
              >
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    value={webhookSecret}
                    onChange={(e) => setWebhookSecret(e.target.value)}
                    placeholder={
                      state?.webhooks.vendorWebhookSecretConfigured
                        ? t("•••• stored", "•••• مخزَّن", lang)
                        : t("at least 16 characters", "16 حرفًا على الأقل", lang)
                    }
                    className={cn(inputCls, "font-mono")}
                    autoComplete="off"
                  />
                  {state?.webhooks.vendorWebhookSecretConfigured && <StoredTag />}
                </div>
              </Field>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void testWebhook()}
                  disabled={busy}
                  className="flex items-center gap-2 rounded-full border border-primary/40 bg-green-tint px-5 py-2.5 text-[12.5px] font-semibold text-primary transition hover:bg-green-tint/70 disabled:opacity-40"
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                  {t("Send test webhook", "إرسال Webhook تجريبي", lang)}
                </button>
                {webhookResult && (
                  <span
                    role="status"
                    className={cn(
                      "num text-[11.5px] font-semibold",
                      webhookResult.ok ? "text-green-deep" : "text-red-soft",
                    )}
                  >
                    {webhookResult.ok
                      ? `${t("delivered", "تم التسليم", lang)} · HTTP ${webhookResult.status} · ${webhookResult.ms}ms`
                      : `${t("failed", "فشل", lang)} · ${webhookResult.error ?? `HTTP ${webhookResult.status}`}`}
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        {/* Navigation. Save-and-continue is the primary action on every step; the
            test-webhook button on step 5 is deliberately NOT the gate, because an
            institution may legitimately configure webhooks after its first case. */}
        <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-line pt-6">
          {step > 1 && (
            <button
              type="button"
              onClick={() => setStep(step - 1)}
              className="flex items-center gap-2 rounded-full border border-line bg-white px-5 py-2.5 text-[12.5px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> {t("Back", "رجوع", lang)}
            </button>
          )}

          {step < total && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (step === 1) {
                  void saveStep(
                    {
                      orgName,
                      orgLogoUrl,
                      institutionType,
                      region,
                      shariahCompliant: shariah,
                    },
                    2,
                  );
                } else if (step === 2) {
                  void saveStep(
                    {
                      twilioVoiceNumber: voiceNumber,
                      twilioSmsSenderId: senderId,
                      twilioMessagingServiceSid: messagingSid,
                      twilioAuthToken: twilioToken,
                    },
                    3,
                  );
                } else if (step === 3) {
                  void saveStep({ elevenKey, llmKey, llmBaseUrl }, 4);
                } else if (step === 4) {
                  void saveStep({ pdplAcknowledged: pdpl }, 5);
                } else if (step === 5) {
                  void saveStep(
                    { vendorWebhookUrl: webhookUrl, vendorWebhookSecret: webhookSecret },
                    6,
                  );
                }
              }}
              className="flex items-center gap-2 rounded-full bg-primary px-6 py-2.5 text-[12.5px] font-semibold text-white transition hover:bg-green-deep disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t("Save and continue", "حفظ ومتابعة", lang)}
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}

          {step === total && (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                const ok = await post({ action: "finish" });
                if (ok) {
                  await load();
                  setNotice(t("Setup complete.", "اكتمل الإعداد.", lang));
                }
              }}
              className="flex items-center gap-2 rounded-full bg-primary px-6 py-2.5 text-[12.5px] font-semibold text-white transition hover:bg-green-deep disabled:opacity-40"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Rocket className="h-3.5 w-3.5" />
              )}
              {t("Finish setup", "إنهاء الإعداد", lang)}
            </button>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              await post({ action: "skip" });
              setView("console");
            }}
            className="text-[12px] font-semibold text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline"
          >
            {t("Skip for now", "التخطي مؤقتًا", lang)}
          </button>
        </div>
      </div>
    </div>
  );
}
