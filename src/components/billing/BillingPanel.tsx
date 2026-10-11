"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { useApp, t } from "@/lib/store";

/**
 * Account / billing screen — the self-service surface.
 *
 * The only thing it does beyond display is POST to `/api/billing/portal` and
 * redirect to whatever URL comes back. It holds NO Paddle customer id, no API key
 * and no subscription state of its own: the route resolves the customer from the
 * session, so there is nothing here for a tampered client to influence.
 *
 * What the portal is FOR is Paddle's job to explain — payment method changes,
 * cancellation and invoices are all hosted there. That is deliberate: card data
 * must never touch this app, which is the whole reason a Merchant of Record was
 * chosen.
 */
export function BillingPanel() {
  const { lang } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openPortal() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(
          body.error === "no_billing_account"
            ? t(
                "This organization has no billing account yet — pick a plan first.",
                "لا توجد حساب فوترة لهذه المؤسسة بعد — اختر خطة أولاً.",
                lang,
              )
            : t("Could not open the billing portal.", "تعذّر فتح بوابة الفوترة.", lang),
        );
        return;
      }
      const { url } = (await res.json()) as { url: string };
      // A full navigation, not a router push: the portal is Paddle's origin and
      // must leave this app entirely.
      window.location.href = url;
    } catch {
      setError(t("Could not reach the billing portal.", "تعذّر الوصول إلى بوابة الفوترة.", lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-3xl border border-line bg-white p-6">
      <h2 className="font-display text-[17px] font-semibold tracking-tight">
        {t("Billing & subscription", "الفوترة والاشتراك", lang)}
      </h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
        {t(
          "Payment method, invoices, plan changes and cancellation are handled in Paddle's customer portal, which opens on Paddle's own domain. Card details never touch this application.",
          "تُدار وسيلة الدفع والفواتير وتغيير الخطة والإلغاء في بوابة عملاء Paddle، التي تُفتح على نطاق Paddle الخاص. ولا تلمس بيانات البطاقة هذا التطبيق أبداً.",
          lang,
        )}
      </p>

      <button
        type="button"
        onClick={() => void openPortal()}
        disabled={busy}
        className="mt-5 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-green-deep disabled:opacity-60"
      >
        <ExternalLink className="h-4 w-4" />
        {busy
          ? t("Opening…", "جارٍ الفتح…", lang)
          : t("Open billing portal", "افتح بوابة الفوترة", lang)}
      </button>

      {error && (
        <p role="alert" className="mt-3 text-[12.5px] text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
