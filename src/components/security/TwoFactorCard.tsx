"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import { authClient, useSession } from "@/lib/auth-client";
import { t, useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * Two-factor authentication, for the Settings → Security tab.
 *
 * Three decisions this component makes, and why:
 *
 *  1. **The password is requested on demand, not assumed.** The two-factor
 *     plugin is the one that decides: it only demands a password when the
 *     account has one to verify (`shouldRequirePassword`), and an invitation
 *     can be redeemed without setting a password at all. So the flow starts
 *     without one and surfaces the field only when the server asks — either by
 *     rejecting the credential (`INVALID_PASSWORD`) or by refusing the request
 *     for a missing field. Guessing from the client would mean either blocking
 *     a password-less operator out of their own second factor, or asking for a
 *     password an account does not have.
 *     On THIS deployment the plugin runs without `allowPasswordless`, so the
 *     password step is the normal path, not an error recovery — which is the
 *     correct posture for a second factor: turning it on is itself a
 *     security-sensitive action.
 *
 *  2. **The TOTP secret is handed over as an `otpauth://` link, not a QR
 *     image.** A QR needs a rendering dependency we do not carry, and an
 *     external QR service would ship a second-factor secret to a third party
 *     over the public internet — turning a control that proves possession into
 *     a broadcast of the very secret that defeats it. The link opens directly
 *     in any authenticator app and can be copied instead.
 *
 *  3. **Backup codes are shown once, and the UI says so.** They are returned
 *     exactly once by `/two-factor/enable`; the server will not reproduce
 *     them, so a copy that is lost is a recovery path that is gone until the
 *     operator regenerates. The panel therefore makes "store these now" the
 *     primary action rather than a footnote.
 *
 * Server truth is `session.user.twoFactorEnabled`. Everything the operator
 * sees as "on" or "off" is that flag; no local optimistic state.
 */

type Phase = "idle" | "enabling" | "password" | "showing" | "verifying" | "done";

/** Copies text, and reports success so the button can confirm it in place. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function TwoFactorCard() {
  const { lang } = useApp();
  const { data: session } = useSession();
  const [phase, setPhase] = useState<Phase>("idle");
  const [password, setPassword] = useState("");
  const [totpUri, setTotpUri] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState("");
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const enabled = Boolean(session?.user?.twoFactorEnabled);

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => {
      if (alive.current) setNotice("");
    }, 4000);
  }, []);

  /** POST /api/auth/two-factor/enable, asking for a password only when told to. */
  const requestEnable = useCallback(
    async (withPassword: string | null) => {
      setError("");
      setPhase("enabling");
      const body: Record<string, string> = { method: "totp", issuer: "SecureVoice AI" };
      if (withPassword) body.password = withPassword;
      const res = await fetch("/api/auth/two-factor/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        totpURI?: string;
        backupCodes?: string[];
        message?: string;
        code?: string;
      };
      if (!alive.current) return;
      if (!res.ok || !data.totpURI) {
        // Two ways the server can be asking for a password, and they must stay
        // distinct:
        //
        //  · `INVALID_PASSWORD` — this account HAS a credential and the one
        //    offered did not match. That is a retry with the right secret.
        //
        //  · a VALIDATION_ERROR naming `password` — the schema itself requires
        //    the field, so the attempt we just made was rejected before any of
        //    it ran. THIS deployment runs the two-factor plugin without
        //    `allowPasswordless`, so this is the path every operator here will
        //    take: the password step is expected, not an error recovery.
        //
        // Both surface the same field, so both land here. Anything else is a
        // genuine failure and is reported as one rather than retried forever.
        const needsPassword =
          data.code === "INVALID_PASSWORD" ||
          (data.code === "VALIDATION_ERROR" && /password/i.test(data.message ?? ""));
        if (needsPassword) {
          setPhase("password");
          return;
        }
        setPhase("idle");
        setError(data.message ?? t("Could not start setup.", "تعذّر بدء الإعداد.", lang));
        return;
      }
      setTotpUri(data.totpURI);
      setBackupCodes(data.backupCodes ?? []);
      setPhase("showing");
    },
    [lang],
  );

  const verify = useCallback(async () => {
    setError("");
    setPhase("verifying");
    const res = await fetch("/api/auth/two-factor/verify-totp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim() }),
    });
    if (!alive.current) return;
    if (!res.ok) {
      setPhase("showing");
      setError(
        t(
          "That code was not accepted. Codes change every 30 seconds — try the current one.",
          "لم يُقبل هذا الرمز. الرموز تتغير كل ٣٠ ثانية — جرّب الرمز الحالي.",
          lang,
        ),
      );
      return;
    }
    setPhase("done");
    // Re-read the session so the "on" state is the server's, not ours.
    await authClient.getSession().catch(() => {});
    flash(t("Two-factor authentication is on.", "تم تشغيل المصادقة الثنائية.", lang));
  }, [code, lang, flash]);

  const regenerate = useCallback(
    async (withPassword: string) => {
      setError("");
      const res = await fetch("/api/auth/two-factor/generate-backup-codes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: withPassword }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        backupCodes?: string[];
        message?: string;
      };
      if (!alive.current) return;
      if (!res.ok || !data.backupCodes) {
        setError(
          data.message ?? t("Could not generate new codes.", "تعذّر إنشاء رموز جديدة.", lang),
        );
        return;
      }
      setBackupCodes(data.backupCodes);
      flash(
        t(
          "New recovery codes generated. The old ones no longer work.",
          "تم إنشاء رموز استرداد جديدة. الرموز القديمة لم تعد صالحة.",
          lang,
        ),
      );
    },
    [lang, flash],
  );

  const disable = useCallback(
    async (withPassword: string) => {
      setError("");
      const res = await fetch("/api/auth/two-factor/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: withPassword }),
      });
      if (!alive.current) return;
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        setError(
          data.message ??
            t("Could not turn off two-factor.", "تعذّر إيقاف المصادقة الثنائية.", lang),
        );
        return;
      }
      await authClient.getSession().catch(() => {});
      setPhase("idle");
      setBackupCodes([]);
      flash(t("Two-factor authentication is off.", "تم إيقاف المصادقة الثنائية.", lang));
    },
    [lang, flash],
  );

  const copy = useCallback(
    async (value: string, label: string) => {
      const ok = await copyText(value);
      if (!alive.current) return;
      setCopied(ok ? label : "");
      if (!ok) {
        setError(
          t(
            "The browser refused clipboard access. Select the text and copy it manually.",
            "رفض المتصفح الوصول إلى الحافظة. حدّد النص وانسخه يدوياً.",
            lang,
          ),
        );
      }
      window.setTimeout(() => {
        if (alive.current) setCopied("");
      }, 2500);
    },
    [lang],
  );

  return (
    <section className="rounded-3xl border border-line bg-white p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-xl",
              enabled ? "bg-green-tint text-primary" : "bg-paper text-ink-3",
            )}
          >
            {enabled ? <ShieldCheck className="h-5 w-5" /> : <ShieldOff className="h-5 w-5" />}
          </span>
          <div>
            <h2 className="font-display text-[16px] font-semibold tracking-tight">
              {t("Two-factor authentication", "المصادقة الثنائية", lang)}
            </h2>
            <p className="mt-0.5 text-[12.5px] text-ink-2">
              {t(
                "A six-digit code from your authenticator app, asked for after your password.",
                "رمز من ستة أرقام من تطبيق المصادقة، يُطلب بعد كلمة المرور.",
                lang,
              )}
            </p>
          </div>
        </div>
        <span
          className={cn(
            "rounded-full px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-wide",
            enabled ? "bg-green-tint text-primary" : "bg-paper text-ink-3",
          )}
        >
          {enabled ? t("On", "مُشغّلة", lang) : t("Off", "متوقفة", lang)}
        </span>
      </header>

      {notice && (
        <p
          role="status"
          className="mt-4 rounded-xl bg-green-tint px-3.5 py-2.5 text-[12.5px] text-primary"
        >
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-4 rounded-xl bg-red-tint px-3.5 py-2.5 text-[12.5px] text-red-soft"
        >
          {error}
        </p>
      )}

      {/* ————— OFF: the invitation ————— */}
      {!enabled && phase === "idle" && (
        <div className="mt-5">
          <button
            type="button"
            onClick={() => void requestEnable(null)}
            className="flex items-center gap-2 rounded-full bg-[#0c110e] px-4 py-2.5 text-[13px] font-semibold text-white transition hover:bg-black"
          >
            <KeyRound className="h-4 w-4" />
            {t("Turn on two-factor authentication", "شغّل المصادقة الثنائية", lang)}
          </button>
        </div>
      )}

      {/* ————— password step-up ————— */}
      {phase === "password" && (
        <form
          className="mt-5 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void requestEnable(password);
          }}
        >
          <label className="block text-[12px] font-semibold text-ink-2" htmlFor="sv-2fa-password">
            {t("Confirm your password", "أكّد كلمة المرور", lang)}
          </label>
          <input
            id="sv-2fa-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-xl border border-line bg-paper px-3.5 py-2.5 text-[13px]"
            required
          />
          <button
            type="submit"
            className="rounded-full bg-[#0c110e] px-4 py-2.5 text-[13px] font-semibold text-white transition hover:bg-black"
          >
            {t("Continue", "متابعة", lang)}
          </button>
        </form>
      )}

      {/* ————— the secret and the codes, shown once ————— */}
      {(phase === "showing" || phase === "verifying") && (
        <div className="mt-5 space-y-4">
          <div>
            <div className="text-[12px] font-semibold text-ink-2">
              {t(
                "1. Add the account to your authenticator app",
                "١. أضف الحساب إلى تطبيق المصادقة",
                lang,
              )}
            </div>
            <p className="mt-1 text-[11.5px] leading-relaxed text-ink-3">
              {t(
                "Open the link on this device, or copy the secret and add it by hand.",
                "افتح الرابط على هذا الجهاز، أو انسخ السر وأضفه يدوياً.",
                lang,
              )}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <a
                href={totpUri}
                className="rounded-full border border-line px-3 py-1.5 text-[12px] font-semibold transition hover:bg-paper"
              >
                {t("Open in authenticator app", "افتح في تطبيق المصادقة", lang)}
              </a>
              <button
                type="button"
                onClick={() => void copy(totpUri, "uri")}
                className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] font-semibold transition hover:bg-paper"
              >
                <Copy className="h-3.5 w-3.5" />
                {copied === "uri"
                  ? t("Copied", "تم النسخ", lang)
                  : t("Copy setup link", "انسخ رابط الإعداد", lang)}
              </button>
            </div>
            <pre className="mt-2 overflow-x-auto rounded-xl border border-line bg-paper p-3 font-mono text-[10.5px] leading-relaxed text-ink-2">
              {totpUri}
            </pre>
          </div>

          {backupCodes.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-2">
                <AlertTriangle className="h-3.5 w-3.5" />
                {t(
                  "2. Save these recovery codes now — shown once",
                  "٢. احفظ رموز الاسترداد الآن — تُعرض مرة واحدة",
                  lang,
                )}
              </div>
              <ul className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {backupCodes.map((c) => (
                  <li
                    key={c}
                    className="rounded-lg border border-line bg-paper px-2.5 py-1.5 text-center font-mono text-[11.5px]"
                  >
                    {c}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => void copy(backupCodes.join("\n"), "codes")}
                className="mt-2 flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[12px] font-semibold transition hover:bg-paper"
              >
                <Copy className="h-3.5 w-3.5" />
                {copied === "codes"
                  ? t("Copied", "تم النسخ", lang)
                  : t("Copy codes", "انسخ الرموز", lang)}
              </button>
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void verify();
            }}
          >
            <label className="block text-[12px] font-semibold text-ink-2" htmlFor="sv-2fa-code">
              {t(
                "3. Enter the six-digit code to finish",
                "٣. أدخل الرمز المكوّن من ستة أرقام للإتمام",
                lang,
              )}
            </label>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                id="sv-2fa-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className="num w-32 rounded-xl border border-line bg-paper px-3.5 py-2.5 text-center text-[15px] tracking-[0.3em]"
                required
              />
              <button
                type="submit"
                disabled={phase === "verifying" || code.length !== 6}
                className="flex items-center gap-2 rounded-full bg-[#0c110e] px-4 py-2.5 text-[13px] font-semibold text-white transition hover:bg-black disabled:opacity-50"
              >
                {phase === "verifying" && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("Verify and turn on", "تحقّق وشغّل", lang)}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ————— ON: maintenance ————— */}
      {(enabled || phase === "done") && (
        <div className="mt-5 space-y-4">
          {phase === "done" ? (
            <p className="flex items-center gap-1.5 text-[12.5px] text-primary">
              <CheckCircle2 className="h-4 w-4" />
              {t(
                "Set up. Your next sign-in will ask for a code.",
                "تم الإعداد. تسجيل دخولك القادم سيطلب رمزاً.",
                lang,
              )}
            </p>
          ) : (
            <p className="text-[12.5px] leading-relaxed text-ink-2">
              {t(
                "Two-factor is on for this account. Recovery codes can be replaced at any time, and turning it off requires your password.",
                "المصادقة الثنائية مُشغّلة لهذا الحساب. يمكن استبدال رموز الاسترداد في أي وقت، وإيقافها يتطلب كلمة المرور.",
                lang,
              )}
            </p>
          )}

          <BackupCodeRegenerate
            onGenerate={regenerate}
            disabled={phase === "done" && backupCodes.length > 0}
          />
          <DisableTwoFactor onDisable={disable} />
        </div>
      )}
    </section>
  );
}

/**
 * Recovery-code rotation. Shown as its own collapsible so re-entering a
 * password is an explicit choice rather than something a stray click does.
 */
function BackupCodeRegenerate({
  onGenerate,
  disabled,
}: {
  onGenerate: (password: string) => Promise<void>;
  disabled: boolean;
}) {
  const { lang } = useApp();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-line px-3.5 py-2 text-[12px] font-semibold transition hover:bg-paper"
      >
        {t("Replace recovery codes", "استبدل رموز الاسترداد", lang)}
      </button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void onGenerate(password);
      }}
    >
      <label className="block text-[12px] font-semibold text-ink-2" htmlFor="sv-2fa-rotate">
        {t("Password", "كلمة المرور", lang)}
      </label>
      <input
        id="sv-2fa-rotate"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="w-full rounded-xl border border-line bg-paper px-3.5 py-2 text-[13px] sm:w-56"
        required
      />
      <button
        type="submit"
        disabled={disabled || !password}
        className="rounded-full bg-[#0c110e] px-4 py-2.5 text-[13px] font-semibold text-white transition hover:bg-black disabled:opacity-50"
      >
        {t("Generate new codes", "أنشئ رموزاً جديدة", lang)}
      </button>
    </form>
  );
}

/** Turning 2FA off is the destructive direction, so it asks twice. */
function DisableTwoFactor({ onDisable }: { onDisable: (password: string) => Promise<void> }) {
  const { lang } = useApp();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-line px-3.5 py-2 text-[12px] font-semibold text-ink-2 transition hover:bg-paper"
      >
        {t("Turn off two-factor", "أوقف المصادقة الثنائية", lang)}
      </button>
    );
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        void onDisable(password);
      }}
    >
      <p className="text-[12px] leading-relaxed text-red-soft">
        {t(
          "This removes the second sign-in step from this account. Your password alone will be enough.",
          "سيزيل هذا خطوة تسجيل الدخول الثانية من هذا الحساب. كلمة المرور وحدها ستكون كافية.",
          lang,
        )}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block text-[12px] font-semibold text-ink-2" htmlFor="sv-2fa-disable">
          {t("Password", "كلمة المرور", lang)}
        </label>
        <input
          id="sv-2fa-disable"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-xl border border-line bg-paper px-3.5 py-2 text-[13px] sm:w-56"
          required
        />
        <button
          type="submit"
          disabled={!password}
          className="flex items-center gap-1.5 rounded-full bg-red-soft px-4 py-2.5 text-[13px] font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
        >
          <ShieldOff className="h-4 w-4" />
          {t("Turn off", "إيقاف", lang)}
        </button>
      </div>
    </form>
  );
}
