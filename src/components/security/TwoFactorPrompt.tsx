"use client";

import { useCallback, useSyncExternalStore } from "react";
import { ShieldCheck, X } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { t, useApp } from "@/lib/store";

/**
 * The nudge to turn on two-factor authentication.
 *
 * SHOWN when, and only when, all three hold:
 *
 *   1. an operator is signed in,
 *   2. the SERVER says their account has no second factor
 *      (`session.user.twoFactorEnabled !== true` — never a local guess), and
 *   3. they have not already said "not now" in this browser.
 *
 * Condition 1 is what ties this to the moment the user asked about: the prompt
 * reaches an operator right after they redeem an invitation (the only way an
 * account comes into existence — see src/lib/auth/signup.ts) and again once
 * they finish the onboarding wizard, because both of those leave a session
 * open and the flag still off. It is deliberately not shown to a signed-out
 * visitor, who has nothing to protect yet.
 *
 * Condition 3 is a per-browser courtesy stored in localStorage. It is NOT the
 * control: the control is `twoFactorEnabled` on the account, which is what
 * makes the prompt disappear permanently. A dismissed nudge that reappears on
 * a new device is honest about what the account actually still lacks — there
 * is no second factor there to protect it — so re-showing it after dismissal
 * is the safer failure mode, not the more annoying one.
 *
 * The CTA navigates to the Settings → Security tab rather than embedding the
 * enrollment form, so the flow the operator completes is the same one an
 * operator who went looking for it finds. Two enrollment paths is how one of
 * them ends up untested.
 */

const DISMISS_KEY = "sv:2fa-prompt-dismissed:v1";

/**
 * The dismissal flag is an EXTERNAL store — it lives in localStorage and can be
 * changed by another tab — so it is read through `useSyncExternalStore` rather
 * than copied into component state. That also removes the setState-inside-an-
 * effect the earlier version needed to bridge SSR (where localStorage does not
 * exist) to the client, which React flags as a cascading-render hazard: the
 * dismissal read could render nothing, then render the prompt, then render
 * nothing again for an operator who had already dismissed it.
 */
function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(onStoreChange: () => void): () => void {
  // `storage` covers other tabs writing the same key; the custom event covers
  // this tab's own dismiss, which `storage` deliberately does not fire for.
  const ping = () => onStoreChange();
  window.addEventListener("storage", ping);
  window.addEventListener(DISMISS_EVENT, ping);
  return () => {
    window.removeEventListener("storage", ping);
    window.removeEventListener(DISMISS_EVENT, ping);
  };
}

/** Fired after a write so this tab's own subscription re-reads immediately. */
const DISMISS_EVENT = "sv:2fa-prompt-dismissed";

export function TwoFactorPrompt() {
  const { lang, openSettings } = useApp();
  const { data: session } = useSession();
  // `false` during SSR and on the first client render: the prompt must never
  // flash at an operator who already dismissed it, and the server has no
  // localStorage to consult.
  const dismissed = useSyncExternalStore(subscribe, readDismissed, () => false);

  const dismiss = useCallback(() => {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* non-fatal: the prompt returns next visit rather than becoming sticky */
    }
    window.dispatchEvent(new Event(DISMISS_EVENT));
  }, []);

  const signedIn = Boolean(session?.user);
  const enabled = Boolean(session?.user?.twoFactorEnabled);
  // `dismissed === null` means not yet read — render nothing rather than
  // flash the prompt at an operator who already dismissed it.
  const visible = signedIn && !enabled && dismissed === false;

  if (!visible) return null;

  return (
    <aside
      aria-labelledby="sv-2fa-prompt-title"
      className="mx-auto mt-6 w-full max-w-6xl px-5 sm:px-8"
    >
      <div className="flex flex-wrap items-start gap-3.5 rounded-2xl border border-[#c9a227]/40 bg-[#c9a227]/10 p-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#c9a227]/20 text-[#8a6d12]">
          <ShieldCheck className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="sv-2fa-prompt-title" className="text-[13.5px] font-semibold tracking-tight">
            {t("Add a second sign-in step", "أضف خطوة دخول ثانية", lang)}
          </h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
            {t(
              "Your account is protected by a password only. Turning on two-factor adds a six-digit code from your authenticator app, so a stolen password alone cannot open the Command Center.",
              "حسابك محمي بكلمة مرور فقط. تشغيل المصادقة الثنائية يضيف رمزاً من ستة أرقام من تطبيق المصادقة، فلا تكفي كلمة مرور مسروقة لفتح مركز القيادة.",
              lang,
            )}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => openSettings("security")}
              className="rounded-full bg-[#0c110e] px-3.5 py-2 text-[12.5px] font-semibold text-white transition hover:bg-black"
            >
              {t("Turn on two-factor", "شغّل المصادقة الثنائية", lang)}
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="rounded-full border border-line px-3.5 py-2 text-[12.5px] font-semibold text-ink-2 transition hover:bg-paper"
            >
              {t("Not now", "لاحقاً", lang)}
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("Dismiss", "إخفاء", lang)}
          className="rounded-full p-1.5 text-ink-3 transition hover:bg-paper"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </aside>
  );
}
