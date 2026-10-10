"use client";

import { ShieldCheck, RotateCcw } from "lucide-react";
import { useApp, t } from "@/lib/store";
import { cn } from "@/lib/utils";

/** Route-level error boundary — brand-styled, recoverable */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { lang } = useApp();
  const ar = lang === "ar";

  // Client component: no server logger here. The digest below is the operator
  // correlation id; no beacon (no /api/client-error endpoint exists).

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-green-tint">
        <ShieldCheck className="h-7 w-7 text-primary" strokeWidth={1.6} />
      </span>
      <h1 className="font-display mt-6 text-2xl font-semibold tracking-tight">
        {t("Something interrupted this view", "حدث خطأ قطع هذه الشاشة", lang)}
      </h1>
      <p
        dir={ar ? "rtl" : undefined}
        className={cn("mt-3 max-w-md text-[14px] leading-relaxed text-ink-2", ar && "font-arabic")}
      >
        {t(
          "The platform hit an unexpected state while rendering. Your session data is safe — restart the view or jump back to the overview.",
          "واجهت المنصة حالة غير متوقّعة أثناء العرض. بيانات جلستك آمنة — أعد تحميل الشاشة أو عُد إلى النظرة العامة.",
          lang,
        )}
      </p>
      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        <button
          onClick={reset}
          className="flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-[13.5px] font-semibold text-white transition hover:bg-green-deep"
        >
          <RotateCcw className="h-4 w-4" />
          {t("Restart view", "إعادة تحميل الشاشة", lang)}
        </button>
        <button
          onClick={() => window.location.reload()}
          className="rounded-full border border-line bg-white px-6 py-3 text-[13.5px] font-semibold text-foreground transition hover:border-primary/50 hover:text-primary"
        >
          {t("Reload platform", "إعادة تحميل المنصة", lang)}
        </button>
      </div>
      {error.digest && (
        <p className="num mt-6 text-[10.5px] text-ink-3">
          {t("REF", "المرجع", lang)}: {error.digest}
        </p>
      )}
    </div>
  );
}
