"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plug, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t, useApp, type Lang } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * CRM connections for the operator's tenant. When a case needs a human, the
 * platform opens a ticket in the institution's own CRM. Credentials are
 * encrypted at rest and only the masked summary is ever shown back.
 */

type Provider = "zendesk" | "salesforce" | "webhook";

type Masked = Record<string, string>;

type Connection = {
  provider: Provider;
  enabled: boolean;
  lastStatus: "ok" | "error" | null;
  lastSyncAt: string | null;
  lastError: string | null;
  masked: Masked;
  unreadable: boolean;
};

type FieldDef = { key: string; label: string; placeholder: string; secret?: boolean };

/**
 * Credential fields per provider, localised at call time. A function of `lang`
 * rather than a module constant: the labels are UI copy, and a constant would
 * have to be rebuilt inside the component on every render.
 */
function fieldSets(lang: Lang): Record<Provider, FieldDef[]> {
  return {
    zendesk: [
      {
        key: "subdomain",
        label: t("Subdomain", "النطاق الفرعي", lang),
        placeholder: "acme (→ acme.zendesk.com)",
      },
      {
        key: "email",
        label: t("Agent email", "بريد الوكيل", lang),
        placeholder: "fraud@acme.com",
      },
      {
        key: "apiToken",
        label: t("API token", "رمز الوصول", lang),
        placeholder: "Zendesk → Admin → API",
        secret: true,
      },
      {
        key: "groupId",
        label: t("Group id (optional)", "معرّف المجموعة (اختياري)", lang),
        placeholder: t("numeric, e.g. 3600…", "رقمي، مثال 3600…", lang),
      },
    ],
    salesforce: [
      {
        key: "instanceUrl",
        label: t("Instance URL", "رابط النسخة", lang),
        placeholder: "https://acme.my.salesforce.com",
      },
      {
        key: "clientId",
        label: t("Connected app client id", "معرّف عميل التطبيق المتصل", lang),
        placeholder: "3MVG…",
      },
      {
        key: "clientSecret",
        label: t("Client secret", "سر العميل", lang),
        placeholder: "•••",
        secret: true,
      },
    ],
    webhook: [
      {
        key: "url",
        label: t("HTTPS endpoint", "نقطة نهاية HTTPS", lang),
        placeholder: "https://hooks.acme.example/securevoice",
      },
      {
        key: "secret",
        label: t("Signing secret (16+ chars)", "سر التوقيع (16 حرفًا على الأقل)", lang),
        placeholder: "openssl rand -hex 24",
        secret: true,
      },
    ],
  };
}

export function CrmSection({
  busy,
  setBusy,
  setMsg,
}: {
  busy: boolean;
  setBusy: (v: boolean) => void;
  setMsg: (m: { ok: boolean; text: string } | null) => void;
}) {
  const { lang } = useApp();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [provider, setProvider] = useState<Provider>("zendesk");
  const [config, setConfig] = useState<Record<string, string>>({});
  const fields = fieldSets(lang);

  const reload = useCallback(() => {
    fetch("/api/console/crm")
      .then((r) => r.json())
      .then((d: { connections?: Connection[] }) => setConnections(d.connections ?? []))
      .catch(() => {});
  }, []);

  useEffect(reload, [reload]);

  const save = async (sendTest: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/console/crm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, config, test: sendTest }),
      });
      const d = (await r
        .json()
        .catch(() => ({ error: t("Unreadable response", "تعذّر قراءة الاستجابة", lang) }))) as {
        ok?: boolean;
        error?: string;
        tested?: { ok: boolean; error?: string; externalId?: string };
      };
      if (!r.ok || d.error) throw new Error(d.error || t("Save failed", "فشل الحفظ", lang));
      setConfig({});
      reload();
      if (sendTest && d.tested) {
        setMsg(
          d.tested.ok
            ? {
                ok: true,
                text: `${t("Saved — test ticket delivered", "تم الحفظ — تم إرسال تذكرة الاختبار", lang)}${
                  d.tested.externalId ? ` (${t("id", "المعرّف", lang)} ${d.tested.externalId})` : ""
                }.`,
              }
            : {
                ok: false,
                text: `${t("Saved, but the test ticket failed", "تم الحفظ، لكن اختبار التذكرة فشل", lang)}: ${
                  d.tested.error ?? t("unknown error", "خطأ غير معروف", lang)
                }`,
              },
        );
      } else {
        setMsg({
          ok: true,
          text: t(
            "Saved — the connection is live for new escalations.",
            "تم الحفظ — الاتصال مُفعَّل للتصعيدات الجديدة.",
            lang,
          ),
        });
      }
    } catch (e) {
      setMsg({
        ok: false,
        text: e instanceof Error ? e.message : t("Save failed", "فشل الحفظ", lang),
      });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (c: Connection) => {
    await fetch("/api/console/crm", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: c.provider, enabled: !c.enabled }),
    });
    reload();
  };

  const disconnect = async (p: Provider) => {
    await fetch(`/api/console/crm?provider=${p}`, { method: "DELETE" });
    reload();
  };

  return (
    <div className="mt-6 border-t border-line pt-6">
      <p className="flex items-center gap-2 text-[13px] font-semibold">
        <Plug className="h-4 w-4 text-primary" />
        {t("CRM connections (human escalations)", "اتصالات CRM (التصعيد إلى موظف)", lang)}
      </p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
        {t(
          "When a customer says a charge was fraud, or a voicemail goes unanswered for 24h, the case needs a person. Connect your CRM and we open the ticket there — references only, never the transcript.",
          "عندما يبلغ عميل عن عملية احتيال، أو عندما يبقى برنامج صوتي بلا رد لمدة 24 ساعة، تحتاج الحالة إلى تدخل بشري. اربط نظام CRM الخاص بمؤسستك وسنفتح التذكرة هناك — بالإشارات المرجعية فقط، ودون النص الكامل للمكالمة.",
          lang,
        )}
      </p>

      {connections.length > 0 && (
        <ul className="mt-3 space-y-2">
          {connections.map((c) => (
            <li
              key={c.provider}
              className="flex items-center justify-between gap-3 rounded-xl border border-line bg-paper px-3.5 py-2.5"
            >
              <div className="min-w-0">
                <p className="text-[12px] font-semibold capitalize">
                  {c.provider}{" "}
                  {!c.enabled && (
                    <span className="text-ink-3">({t("paused", "موقوفة", lang)})</span>
                  )}
                  {c.lastStatus === "ok" && (
                    <span className="text-green-deep"> · {t("ok", "متصلة", lang)}</span>
                  )}
                  {c.lastStatus === "error" && (
                    <span className="text-red-soft">
                      {" "}
                      · {c.lastError ?? t("error", "خطأ", lang)}
                    </span>
                  )}
                </p>
                <p className="truncate text-[10.5px] text-ink-3">
                  {c.unreadable
                    ? t(
                        "saved credentials could not be decrypted — please re-enter them",
                        "تعذّر فك تشفير بيانات الاعتماد المحفوظة — يُرجى إدخالها مرة أخرى",
                        lang,
                      )
                    : Object.values(c.masked).slice(0, 3).join(" · ")}
                  {c.lastSyncAt
                    ? ` · ${t("last sync", "آخر مزامنة", lang)} ${new Date(c.lastSyncAt).toLocaleString()}`
                    : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-[11px] font-semibold">
                <button onClick={() => toggle(c)} className="text-primary hover:underline">
                  {c.enabled ? t("Pause", "إيقاف مؤقت", lang) : t("Resume", "استئناف", lang)}
                </button>
                <button
                  onClick={() => disconnect(c.provider)}
                  aria-label={`${t("Disconnect", "فصل", lang)} ${c.provider}`}
                  className="text-red-soft hover:underline"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div
        className="mt-4 flex gap-2"
        role="radiogroup"
        aria-label={t("CRM provider", "مزوّد CRM", lang)}
      >
        {(["zendesk", "salesforce", "webhook"] as const).map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={provider === p}
            onClick={() => {
              setProvider(p);
              setConfig({});
            }}
            className={cn(
              "flex-1 rounded-full border px-3 py-2 text-[12px] font-semibold capitalize transition",
              provider === p
                ? "border-primary bg-green-tint text-green-deep"
                : "border-line bg-paper text-ink-2 hover:text-foreground",
            )}
          >
            {p}
          </button>
        ))}
      </div>

      <div className="mt-3 space-y-3">
        {fields[provider].map((f) => (
          <div key={f.key} className="space-y-1.5">
            <Label className="text-[12px] font-semibold">{f.label}</Label>
            <Input
              type={f.secret ? "password" : "text"}
              value={config[f.key] ?? ""}
              onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
              className="rounded-xl border-line bg-paper font-mono text-[12.5px]"
              autoComplete="off"
            />
          </div>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <button
          onClick={() => save(false)}
          disabled={busy}
          className="rounded-full bg-primary px-5 py-2.5 text-[12.5px] font-semibold text-white transition hover:bg-green-deep disabled:opacity-40"
        >
          {t("Save", "حفظ", lang)}
        </button>
        <button
          onClick={() => save(true)}
          disabled={busy}
          className="flex items-center gap-2 rounded-full border border-primary/40 bg-green-tint px-4 py-2.5 text-[12.5px] font-semibold text-primary transition hover:bg-green-tint/70 disabled:opacity-40"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plug className="h-3.5 w-3.5" />
          )}
          {t("Save & send test ticket", "حفظ وإرسال تذكرة اختبار", lang)}
        </button>
      </div>
    </div>
  );
}
