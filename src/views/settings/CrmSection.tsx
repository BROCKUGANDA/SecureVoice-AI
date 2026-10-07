"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plug, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

const FIELD_SETS: Record<
  Provider,
  { key: string; label: string; placeholder: string; secret?: boolean }[]
> = {
  zendesk: [
    { key: "subdomain", label: "Subdomain", placeholder: "acme (→ acme.zendesk.com)" },
    { key: "email", label: "Agent email", placeholder: "fraud@acme.com" },
    { key: "apiToken", label: "API token", placeholder: "Zendesk → Admin → API", secret: true },
    { key: "groupId", label: "Group id (optional)", placeholder: "numeric, e.g. 3600…" },
  ],
  salesforce: [
    { key: "instanceUrl", label: "Instance URL", placeholder: "https://acme.my.salesforce.com" },
    { key: "clientId", label: "Connected app client id", placeholder: "3MVG…" },
    { key: "clientSecret", label: "Client secret", placeholder: "•••", secret: true },
  ],
  webhook: [
    { key: "url", label: "HTTPS endpoint", placeholder: "https://hooks.acme.example/securevoice" },
    {
      key: "secret",
      label: "Signing secret (16+ chars)",
      placeholder: "openssl rand -hex 24",
      secret: true,
    },
  ],
};

export function CrmSection({
  busy,
  setBusy,
  setMsg,
}: {
  busy: boolean;
  setBusy: (v: boolean) => void;
  setMsg: (m: { ok: boolean; text: string } | null) => void;
}) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [provider, setProvider] = useState<Provider>("zendesk");
  const [config, setConfig] = useState<Record<string, string>>({});

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
      const d = (await r.json().catch(() => ({ error: "Unreadable response" }))) as {
        ok?: boolean;
        error?: string;
        tested?: { ok: boolean; error?: string; externalId?: string };
      };
      if (!r.ok || d.error) throw new Error(d.error || "Save failed");
      setConfig({});
      reload();
      if (sendTest && d.tested) {
        setMsg(
          d.tested.ok
            ? {
                ok: true,
                text: `Saved — test ticket delivered${d.tested.externalId ? ` (id ${d.tested.externalId})` : ""}.`,
              }
            : {
                ok: false,
                text: `Saved, but the test ticket failed: ${d.tested.error ?? "unknown error"}`,
              },
        );
      } else {
        setMsg({ ok: true, text: "Saved — the connection is live for new escalations." });
      }
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Save failed" });
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
        CRM connections (human escalations)
      </p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
        When a customer says a charge was fraud, or a voicemail goes unanswered for 24h, the case
        needs a person. Connect your CRM and we open the ticket there — references only, never the
        transcript.
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
                  {c.provider} {!c.enabled && <span className="text-ink-3">(paused)</span>}
                  {c.lastStatus === "ok" && <span className="text-green-deep"> · ok</span>}
                  {c.lastStatus === "error" && (
                    <span className="text-red-soft"> · {c.lastError ?? "error"}</span>
                  )}
                </p>
                <p className="truncate text-[10.5px] text-ink-3">
                  {c.unreadable
                    ? "saved credentials could not be decrypted — please re-enter them"
                    : Object.values(c.masked).slice(0, 3).join(" · ")}
                  {c.lastSyncAt ? ` · last sync ${new Date(c.lastSyncAt).toLocaleString()}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-[11px] font-semibold">
                <button onClick={() => toggle(c)} className="text-primary hover:underline">
                  {c.enabled ? "Pause" : "Resume"}
                </button>
                <button
                  onClick={() => disconnect(c.provider)}
                  aria-label={`Disconnect ${c.provider}`}
                  className="text-red-soft hover:underline"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex gap-2" role="radiogroup" aria-label="CRM provider">
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
        {FIELD_SETS[provider].map((f) => (
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
          Save
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
          Save & send test ticket
        </button>
      </div>
    </div>
  );
}
