"use client";

import { useApp, t } from "@/lib/store";

/** Last-resort boundary — renders its own minimal shell if the root layout itself fails */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // The root layout is gone, so this screen cannot borrow an Arabic font class
  // from it: the Arabic copy carries dir="rtl" + fontFamily inline instead.
  const { lang } = useApp();
  const ar = lang === "ar";

  return (
    <html lang={lang} dir={ar ? "rtl" : "ltr"}>
      <body
        style={{
          background: "#fbfbf8",
          fontFamily: ar
            ? "system-ui, 'IBM Plex Sans Arabic', sans-serif"
            : "system-ui, sans-serif",
          margin: 0,
        }}
      >
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            padding: "24px",
            color: "#101812",
          }}
        >
          <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>SecureVoice AI</h1>
          <p
            dir={ar ? "rtl" : undefined}
            style={{ fontSize: 14, color: "#4b5a50", maxWidth: 420, lineHeight: 1.6 }}
          >
            {t(
              "The platform failed to start. This is unusual — a reload almost always fixes it.",
              "تعذّر بدء تشغيل المنصة. هذا غير معتاد — إعادة التحميل تحلّ المشكلة في الغالب.",
              lang,
            )}
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: 24,
              background: "#0b7a55",
              color: "#fff",
              border: "none",
              borderRadius: 999,
              padding: "12px 28px",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t("Reload SecureVoice AI", "إعادة تحميل SecureVoice AI", lang)}
          </button>
          {error.digest && (
            <p style={{ marginTop: 20, fontSize: 11, color: "#8a968d" }}>
              {t("REF", "المرجع", lang)}: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
