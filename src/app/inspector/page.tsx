import { headers } from "next/headers";
import { requireOperator } from "@/lib/credits";
import { db } from "@/lib/db";
import { verifySignature, WEBHOOK_SIGNATURE_HEADER } from "@/lib/outbox";
import { Inspector, type InspectorRow } from "@/components/inspector/Inspector";
import { cn } from "@/lib/utils";
import type { Lang } from "@/lib/languages";

export const dynamic = "force-dynamic";

/**
 * /inspector — our own signed-webhook receiver, in our own app.
 *
 * Why not a third-party webhook site: venue networks block them, and a judge
 * cannot tell the difference between "we integrated a service" and "we built
 * the verifier". This page shows the exact bytes we sent, the signature
 * header we sent, and a verification verdict recomputed on the server — the
 * secret never reaches the browser.
 *
 * Rows are read here (server-side, so the verdict is computed with the secret)
 * and refreshed live by the client from /api/webhooks/receiver.
 *
 * ── Language ───────────────────────────────────────────────────────────────
 * The UI language lives in the client store (zustand), which a server
 * component cannot read. This page therefore falls back to the browser's
 * Accept-Language: an Arabic-locale browser gets the Arabic copy, everyone
 * else English. The client store remains authoritative everywhere it can reach
 * — this is only the server-rendered first paint of one operator route.
 */
export default async function InspectorPage() {
  const guard = await requireOperator();

  const accept = (await headers()).get("accept-language") ?? "";
  const lang: Lang = accept.toLowerCase().startsWith("ar") ? "ar" : "en";
  const ar = lang === "ar";
  const t = (en: string, arabic: string) => (ar ? arabic : en);

  if (!guard.ok) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-24 text-center">
        <h1 className="text-2xl font-semibold">/inspector</h1>
        <p
          dir={ar ? "rtl" : undefined}
          className={cn("mt-3 text-sm opacity-70", ar && "font-arabic")}
        >
          {t(
            "Operator access required. Sign in as the operator account to watch signed bank webhooks land.",
            "مطلوب صلاحية المشغّل. سجّل الدخول بحساب المشغّل لمشاهدة إشعارات المصرف الموقّعة الواردة.",
          )}
        </p>
        <p className="mt-6 text-xs opacity-50">{guard.error}</p>
      </main>
    );
  }

  const secret = process.env.BANK_WEBHOOK_SECRET;
  const stored = await db.inboundBankEvent.findMany({
    orderBy: { receivedAt: "desc" },
    take: 25,
  });

  const rows: InspectorRow[] = stored.map((r) => {
    const verdict = secret
      ? verifySignature(r.signatureHeader, r.body, secret)
      : { ok: false as const, reason: "receiver_unconfigured" };
    return {
      eventId: r.eventId,
      eventType: r.eventType,
      caseRef: r.caseRef,
      body: r.body,
      signatureHeader: r.signatureHeader,
      receivedAt: r.receivedAt.toISOString(),
      verified: verdict.ok,
      reason: verdict.ok
        ? t(
            "digest matches — payload intact, origin authentic",
            "تطابق البصمة — البيانات سليمة والمصدر موثوق",
          )
        : verdict.reason,
      headerName: WEBHOOK_SIGNATURE_HEADER,
    };
  });

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">{t("Webhook inspector", "فاحص خطافات الأحداث")}</h1>
        <p
          dir={ar ? "rtl" : undefined}
          className={cn("mt-2 text-sm opacity-70", ar && "font-arabic")}
        >
          {t("Signed bank notifications received by", "الإشعارات المصرفية الموقّعة المستلمة عبر")}{" "}
          <code className="opacity-90">POST /api/webhooks/receiver</code>.{" "}
          {t(
            "Each verdict below is recomputed on the server from the raw body — the same check a bank runs.",
            "يُعاد حساب كل حكم أدناه على الخادم من النص الخام — وهو نفس الفحص الذي يجريه المصرف.",
          )}
        </p>
      </header>
      <Inspector initialRows={rows} />
    </main>
  );
}
