"use client";

import Link from "next/link";
import { useApp, t } from "@/lib/store";

export default function NotFound() {
  // The 404 is a client component for the same reason error.tsx is: the language
  // lives in the client store, and Next renders this route with no props to pass
  // it down. The store's default is "en", so there is no hydration mismatch.
  const { lang } = useApp();
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 text-center">
      <p className="micro text-primary">{t("404 · Not found", "404 · غير موجود", lang)}</p>
      <h1 className="font-display mt-4 text-3xl font-semibold tracking-tight">
        {t("This page doesn't exist", "هذه الصفحة غير موجودة", lang)}
      </h1>
      <p className="mt-3 max-w-md text-[14px] leading-relaxed text-ink-2">
        {t(
          "SecureVoice AI lives on a single console. Head back to the overview to explore the platform, or jump straight into the live simulation.",
          "يعمل SecureVoice AI من وحدة تحكم واحدة. عُد إلى النظرة العامة لاستكشاف المنصة، أو ابدأ المحاكاة الحيّة مباشرة.",
          lang,
        )}
      </p>
      <Link
        href="/"
        className="mt-7 rounded-full bg-primary px-6 py-3 text-[13.5px] font-semibold text-white transition hover:bg-green-deep"
      >
        {t("Back to overview", "العودة إلى النظرة العامة", lang)}
      </Link>
    </div>
  );
}
