"use client";

import { useCallback, useEffect, useState } from "react";
import { Inbox, Mail, Paperclip, RefreshCw } from "lucide-react";
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

export function MailInbox() {
  const { lang } = useApp();
  const [messages, setMessages] = useState<MailMessage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

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
