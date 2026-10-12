"use client";

import { useCallback, useEffect, useState } from "react";
import { Inbox, Loader2, Mail, Paperclip, RefreshCw, Send, X } from "lucide-react";
import { Chip } from "@/components/fx/core";
import { FOUNDER_EMAIL, LEGAL_EMAIL, SUPPORT_EMAIL } from "@/lib/public-config";
import { useApp, t } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * The received-email inbox.
 *
 * Mail to support@ / legal@ / founder@ is captured by the Resend
 * `email.received` webhook (`POST /api/email/inbound`) into `EmailInbound`, and
 * read back here so an operator sees a bank's reply inside the console instead
 * of having to log into the mailbox.
 *
 * The mailbox list is rendered from the same constants the rest of the UI uses,
 * so the addresses a bank is told to write to and the addresses shown as
 * monitored can never drift apart.
 *
 * It is also the Command Center's entry point for REPORTING a problem:
 * "Report a problem" posts to /api/support/ticket, which attaches the
 * session's org id and the optional intervention ref (pre-seeded from the
 * last fired case) and redacts PII from the free text before anything is
 * queued. The form lives here because this is the console's email surface —
 * the reply a support engineer sends back lands in the list below it.
 */
type MailMessage = {
  id: string;
  messageId: string;
  recipient: string;
  fromEmail: string;
  fromName: string | null;
  subject: string;
  preview: string;
  attachments: string[];
  receivedAt: string;
};

const MAILBOXES = [
  {
    key: "support",
    address: SUPPORT_EMAIL,
    labelEn: "Product · billing · security",
    labelAr: "المنتج · الفواتير · الأمان",
  },
  {
    key: "legal",
    address: LEGAL_EMAIL,
    labelEn: "DPAs · PDPL/GDPR",
    labelAr: "اتفاقيات · حماية البيانات",
  },
  { key: "founder", address: FOUNDER_EMAIL, labelEn: "Direct line", labelAr: "خط مباشر" },
] as const;

export function MailInbox({ interventionRef }: { interventionRef?: string | null }) {
  const { lang } = useApp();
  const [messages, setMessages] = useState<MailMessage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const [reportOpen, setReportOpen] = useState(false);
  const [reportMessage, setReportMessage] = useState("");
  const [reportRef, setReportRef] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportResult, setReportResult] = useState<{ ref: string; delivery: string } | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/console/mail", { cache: "no-store" });
      if (!res.ok) {
        setFailed(true);
        return;
      }
      const body = (await res.json()) as { messages?: MailMessage[] };
      setMessages(body.messages ?? []);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openReport() {
    // Seed the case reference from the last fired intervention, which is
    // usually the thing the problem is about. Re-seeded on every open so a
    // fire that happened since the last look is reflected.
    setReportRef(interventionRef ?? "");
    setReportError(null);
    setReportResult(null);
    setReportOpen(true);
  }

  async function submitReport() {
    setReportBusy(true);
    setReportError(null);
    try {
      const res = await fetch("/api/support/ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: reportMessage,
          ...(reportRef.trim() ? { interventionRef: reportRef.trim() } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        data?: { ref: string; delivery: string };
        error?: string;
      };
      if (!res.ok || !body.data) {
        setReportError(
          body.error ?? t("The report could not be sent.", "تعذّر إرسال البلاغ.", lang),
        );
        return;
      }
      setReportResult(body.data);
      setReportMessage("");
    } catch {
      setReportError(
        t("The report could not be sent.", "تعذّر إرسال البلاغ.", lang),
      );
    } finally {
      setReportBusy(false);
    }
  }

  return (
    <section
      aria-label={t("Received email", "البريد الوارد", lang)}
      className="rounded-2xl border border-line bg-card p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Inbox className="h-4 w-4 text-primary" />
          <h2 className="text-[15px] font-semibold">
            {t("Received email", "البريد الوارد", lang)}
          </h2>
          {messages && (
            <Chip className="!text-[10.5px]">
              {messages.length} {t("messages", "رسالة", lang)}
            </Chip>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={openReport}
            className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-[11.5px] font-semibold text-white transition hover:opacity-90"
          >
            <Send className="h-3 w-3" />
            {t("Report a problem", "الإبلاغ عن مشكلة", lang)}
          </button>
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[11.5px] font-medium transition hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw className={cn("h-3 w-3", busy && "animate-spin")} />
            {t("Refresh", "تحديث", lang)}
          </button>
        </div>
      </div>

      {/* The mailboxes a bank is told to write to, and the ones we watch. */}
      <div className="mt-3 flex flex-wrap gap-2">
        {MAILBOXES.map((m) => (
          <a
            key={m.key}
            href={`mailto:${m.address}`}
            className="group flex items-center gap-2 rounded-xl border border-line px-3 py-2 transition hover:bg-accent"
          >
            <Mail className="h-3.5 w-3.5 text-ink-3" />
            <span className="text-[12px] font-medium">{m.address}</span>
            <span className="text-[10.5px] text-ink-3">{t(m.labelEn, m.labelAr, lang)}</span>
          </a>
        ))}
      </div>

      {reportOpen && (
        <div className="mt-3 rounded-xl border border-line bg-paper/60 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12.5px] font-semibold">
              {t("Report a problem", "الإبلاغ عن مشكلة", lang)}
            </p>
            <button
              type="button"
              onClick={() => setReportOpen(false)}
              aria-label={t("Close", "إغلاق", lang)}
              className="rounded-full p-1 text-ink-3 transition hover:bg-accent"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-3">
            {t(
              `Goes to ${SUPPORT_EMAIL} with your workspace id attached. Card numbers, national IDs and phone numbers in the message are redacted automatically.`,
              `يُرسل إلى ${SUPPORT_EMAIL} مع مُعرّف مساحة عملك. تُحجب أرقام البطاقات والهويات وأرقام الهاتف في الرسالة تلقائيًا.`,
              lang,
            )}
          </p>

          <label className="mt-3 block">
            <span className="text-[11px] font-medium text-ink-2">
              {t("What happened?", "ماذا حدث؟", lang)}
            </span>
            <textarea
              value={reportMessage}
              onChange={(e) => setReportMessage(e.target.value)}
              maxLength={2000}
              rows={4}
              className="mt-1 w-full resize-y rounded-xl border border-line bg-white px-3 py-2 text-[12.5px] leading-relaxed outline-none transition focus:border-primary/40"
            />
          </label>

          <label className="mt-3 block">
            <span className="text-[11px] font-medium text-ink-2">
              {t("Intervention reference (optional)", "مرجع التدخّل (اختياري)", lang)}
            </span>
            <input
              value={reportRef}
              onChange={(e) => setReportRef(e.target.value)}
              maxLength={80}
              placeholder="CASE-…"
              className="num mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-[12.5px] outline-none transition focus:border-primary/40"
            />
          </label>

          {reportError && (
            <p
              role="alert"
              className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[12px] font-medium text-red-700"
            >
              {reportError}
            </p>
          )}

          {reportResult && (
            <p role="status" className="mt-3 text-[12px] font-semibold text-green-deep">
              {reportResult.ref} —{" "}
              {reportResult.delivery === "sent"
                ? t("sent to support.", "أُرسل إلى الدعم.", lang)
                : t(
                    "recorded; delivery is queued and will retry.",
                    "تم التسجيل؛ الإرسال في قائمة الانتظار وستُعاد المحاولة.",
                    lang,
                  )}
            </p>
          )}

          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-[10.5px] text-ink-3">
              {reportMessage.trim().length < 10
                ? t("At least 10 characters.", "10 أحرف على الأقل.", lang)
                : `${reportMessage.trim().length}/2000`}
            </span>
            <button
              type="button"
              onClick={() => void submitReport()}
              disabled={reportBusy || reportMessage.trim().length < 10}
              className="flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[11.5px] font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
            >
              {reportBusy ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Send className="h-3 w-3" />
              )}
              {t("Send report", "إرسال البلاغ", lang)}
            </button>
          </div>
        </div>
      )}

      {failed && (
        <p role="alert" className="mt-4 text-[12.5px] text-ink-2">
          {t(
            "The inbox could not be read. The mailboxes above still receive mail; this view retries on refresh.",
            "تعذّرت قراءة البريد الوارد. ما زالت العناوين أعلاه تستقبل الرسائل، وتُعاد المحاولة عند التحديث.",
            lang,
          )}
        </p>
      )}

      {messages && messages.length === 0 && !failed && (
        <p className="mt-4 text-[12.5px] text-ink-2">
          {t(
            "No mail yet. Point a Resend `email.received` webhook at /api/email/inbound and anything sent to the addresses above appears here.",
            "لا يوجد بريد بعد. وجّه خطاف Resend «email.received» إلى /api/email/inbound ليظهر هنا كل ما يُرسل إلى العناوين أعلاه.",
            lang,
          )}
        </p>
      )}

      {messages && messages.length > 0 && (
        <ul className="mt-4 divide-y divide-line">
          {messages.map((m) => (
            <li key={m.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Chip className="!text-[10px] uppercase">{m.recipient}</Chip>
                <span className="text-[12.5px] font-semibold">{m.subject}</span>
                {m.attachments.length > 0 && (
                  <span className="flex items-center gap-1 text-[10.5px] text-ink-3">
                    <Paperclip className="h-3 w-3" />
                    {m.attachments.length}
                  </span>
                )}
                <span className="ml-auto text-[10.5px] text-ink-3">
                  {new Date(m.receivedAt).toLocaleString()}
                </span>
              </div>
              <p className="mt-1 text-[11.5px] text-ink-3">
                {m.fromName ? `${m.fromName} · ` : ""}
                {m.fromEmail}
              </p>
              <p className="mt-1 line-clamp-3 text-[12.5px] leading-relaxed text-ink-2">
                {m.preview}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
