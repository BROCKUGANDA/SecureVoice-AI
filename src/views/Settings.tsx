"use client";

import { useEffect, useState } from "react";
import {
  Building2,
  KeyRound,
  Coins,
  Users,
  Loader2,
  CheckCircle2,
  XCircle,
  Eye,
  EyeOff,
  ImageIcon,
  Plug,
} from "lucide-react";
import { useApp } from "@/lib/store";
import { Chip } from "@/components/fx/core";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Operator Settings — the B2B tabbed surface:
 *   Organization  → white-label (name + logo shown in the Command Center)
 *   API Keys      → BYOK ElevenLabs key (AES-256-GCM encrypted at rest)
 *   Team          → invite flow (provisioned by invitation; enterprise flow)
 *   Billing       → prepaid credits wallet + tiers
 */

type Settings = {
  orgName: string | null;
  orgLogoUrl: string | null;
  elevenKeyMasked: string | null;
  credits: number;
  /** Bank or insurer - how the institution is spoken about to its customers. */
  institutionType?: "bank" | "insurer";
};

const inputCls = "h-10 rounded-xl border-line bg-paper";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[12px] font-semibold">{label}</Label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-ink-3">{hint}</p>}
    </div>
  );
}

export function Settings() {
  const { lang, setView } = useApp();
  const ar = lang === "ar";
  const [tab, setTab] = useState<"org" | "keys" | "team" | "billing">("org");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showKey, setShowKey] = useState(false);

  // local form state
  const [orgName, setOrgName] = useState("");
  const [orgLogoUrl, setOrgLogoUrl] = useState("");
  const [institutionType, setInstitutionType] = useState<"bank" | "insurer">("bank");
  const [elevenKey, setElevenKey] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [producerKeys, setProducerKeys] = useState<
    { id: string; label: string; revoked: boolean; lastUsedAt: string | null; createdAt: string }[]
  >([]);
  const [newKey, setNewKey] = useState<{ key: string; label: string } | null>(null);
  const [keyLabel, setKeyLabel] = useState("");

  useEffect(() => {
    fetch("/api/console/settings")
      .then((r) => r.json())
      .then((d: Settings & { error?: string }) => {
        if (!d.error) {
          setSettings(d);
          setOrgName(d.orgName ?? "");
          setOrgLogoUrl(d.orgLogoUrl ?? "");
          setInstitutionType(d.institutionType === "insurer" ? "insurer" : "bank");
        }
      })
      .catch(() => {});
    fetch("/api/console/producer-keys")
      .then((r) => r.json())
      .then((d: { keys?: typeof producerKeys }) => setProducerKeys(d.keys ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const createProducerKey = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/console/producer-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: keyLabel.trim() || "Fraud engine" }),
      });
      const d = (await r.json().catch(() => ({ error: "Unreadable response" }))) as {
        key?: string;
        label?: string;
        error?: string;
      };
      if (!r.ok || !d.key) throw new Error(d.error || "Key creation failed");
      setNewKey({ key: d.key, label: d.label ?? keyLabel });
      setKeyLabel("");
      const list = await fetch("/api/console/producer-keys")
        .then((res) => res.json())
        .catch(() => ({ keys: [] }));
      setProducerKeys(list.keys ?? []);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Key creation failed" });
    } finally {
      setBusy(false);
    }
  };

  const revokeProducerKey = async (id: string) => {
    await fetch(`/api/console/producer-keys?id=${id}`, { method: "DELETE" });
    setProducerKeys((ks) => ks.map((k) => (k.id === id ? { ...k, revoked: true } : k)));
  };

  const save = async (patch: Record<string, string>) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/console/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const d = (await r.json().catch(() => ({ error: "Unreadable response" }))) as Settings & {
        ok?: boolean;
        error?: string;
      };
      if (!r.ok || d.error) throw new Error(d.error || "Save failed");
      setSettings(d);
      setMsg({ ok: true, text: "Saved." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    setBusy(true);
    try {
      await fetch("/api/console/settings?field=elevenKey", { method: "DELETE" });
      setSettings((s) => (s ? { ...s, elevenKeyMasked: null } : s));
      setElevenKey("");
      setMsg({ ok: true, text: "BYOK key removed — the platform key is active again." });
    } finally {
      setBusy(false);
    }
  };

  const TABS = [
    { id: "org", label: ar ? "المؤسسة" : "Organization", icon: Building2 },
    { id: "keys", label: ar ? "مفاتيح API" : "API Keys", icon: KeyRound },
    { id: "team", label: ar ? "الفريق" : "Team", icon: Users },
    { id: "billing", label: ar ? "الفوترة" : "Billing", icon: Coins },
  ] as const;

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex items-center gap-2.5">
        <span className="micro text-primary">SETTINGS</span>
      </div>
      <h1 className="font-display mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
        {ar ? "الإعدادات" : "Workspace settings"}
      </h1>

      {loading ? (
        <div className="mt-10 flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-ink-3" />
        </div>
      ) : (
        <>
          {/* tabs */}
          <div className="mt-8 flex gap-1 overflow-x-auto rounded-full border border-line bg-white p-1 sv-scroll">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  setTab(t.id);
                  setMsg(null);
                }}
                aria-pressed={tab === t.id}
                className={cn(
                  "flex flex-1 shrink-0 items-center justify-center gap-1.5 rounded-full px-3.5 py-2 text-[12.5px] font-semibold transition",
                  tab === t.id ? "bg-[#0c110e] text-white" : "text-ink-2 hover:text-foreground",
                )}
              >
                <t.icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            ))}
          </div>

          {msg && (
            <div
              role="status"
              className={cn(
                "mt-4 flex items-center gap-2 rounded-xl px-4 py-3 text-[12.5px] font-medium",
                msg.ok ? "bg-green-tint text-green-deep" : "bg-red-tint text-red-soft",
              )}
            >
              {msg.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
              {msg.text}
            </div>
          )}

          <div className="mt-6 rounded-3xl border border-line bg-white p-6 sm:p-8">
            {tab === "org" && (
              <div className="space-y-5">
                <p className="text-[13px] leading-relaxed text-ink-2">
                  White-label the Command Center — your institution&apos;s name and logo replace
                  SecureVoice branding for every analyst at your bank or insurer.
                </p>
                <Field
                  label="Institution type"
                  hint="Changes how calls, voicemails and fallback texts speak to your customers — “your card” for a bank, “your policy” for an insurer. Protective steps are identical: a staged hold that a human confirms."
                >
                  <div role="radiogroup" aria-label="Institution type" className="flex gap-2">
                    {(
                      [
                        { id: "bank", label: "Bank" },
                        { id: "insurer", label: "Insurer" },
                      ] as const
                    ).map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        role="radio"
                        aria-checked={institutionType === o.id}
                        onClick={() => setInstitutionType(o.id)}
                        className={cn(
                          "flex-1 rounded-xl border px-4 py-2.5 text-[13px] font-semibold transition",
                          institutionType === o.id
                            ? "border-primary bg-green-tint text-green-deep"
                            : "border-line bg-paper text-ink-2 hover:text-foreground",
                        )}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </Field>
                <Field
                  label="Organization display name"
                  hint="Shown in the Command Center header instead of SecureVoice AI."
                >
                  <Input
                    value={orgName}
                    onChange={(e) => setOrgName(e.target.value)}
                    placeholder="Emirates National Bank — Fraud Ops  /  Gulf Mutual Insurance — Claims Security"
                    className={inputCls}
                  />
                </Field>
                <Field
                  label="Logo URL"
                  hint="Square PNG/SVG, ≥96px. Served to analysts — use your own CDN."
                >
                  <Input
                    value={orgLogoUrl}
                    onChange={(e) => setOrgLogoUrl(e.target.value)}
                    placeholder="https://your-cdn.ae/logo.png"
                    className={inputCls}
                  />
                </Field>
                <button
                  onClick={() => save({ orgName, orgLogoUrl, institutionType })}
                  disabled={busy}
                  className="flex items-center gap-2 rounded-full bg-primary px-6 py-2.5 text-[13px] font-semibold text-white transition hover:bg-green-deep disabled:opacity-40"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Save organization
                </button>
              </div>
            )}

            {tab === "keys" && (
              <div className="space-y-5">
                <p className="text-[13px] leading-relaxed text-ink-2">
                  Bring Your Own Key — paste your institution&apos;s own ElevenLabs API key and your
                  voice usage is billed to your ElevenLabs account directly. Encrypted at rest
                  (AES-256-GCM); only the masked form is ever displayed.
                </p>
                {settings?.elevenKeyMasked && (
                  <div className="flex items-center justify-between rounded-xl border border-[#c4e5d6] bg-green-tint px-4 py-3 text-[12.5px] font-medium text-green-deep">
                    <span className="num flex items-center gap-2">
                      <KeyRound className="h-4 w-4" /> {settings.elevenKeyMasked}
                    </span>
                    <button
                      onClick={removeKey}
                      disabled={busy}
                      className="text-[11.5px] font-semibold text-red-soft underline-offset-2 hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                )}
                <Field
                  label="ElevenLabs API key"
                  hint="Create one at app.elevenlabs.io → Profile + API Key. Starts with sk_..."
                >
                  <div className="relative">
                    <Input
                      type={showKey ? "text" : "password"}
                      value={elevenKey}
                      onChange={(e) => setElevenKey(e.target.value)}
                      placeholder="sk_••••••••••••••••••••••••"
                      className={cn(inputCls, "pr-10 font-mono")}
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey((v) => !v)}
                      aria-label="Toggle key visibility"
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-3 hover:text-foreground"
                    >
                      {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </Field>
                <button
                  onClick={() => save({ elevenKey })}
                  disabled={busy || elevenKey.trim().length < 20}
                  className="flex items-center gap-2 rounded-full bg-primary px-6 py-2.5 text-[13px] font-semibold text-white transition hover:bg-green-deep disabled:opacity-40"
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <KeyRound className="h-4 w-4" />
                  )}
                  Save key
                </button>

                <div className="mt-6 border-t border-line pt-6">
                  <p className="flex items-center gap-2 text-[13px] font-semibold">
                    <Plug className="h-4 w-4 text-primary" />
                    Bank integration keys (headless API)
                  </p>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
                    Your fraud engine fires signals with{" "}
                    <code className="num rounded bg-paper px-1.5 py-0.5 text-[10.5px]">
                      Authorization: Bearer svb_…
                    </code>{" "}
                    against{" "}
                    <code className="num rounded bg-paper px-1.5 py-0.5 text-[10.5px]">
                      POST /api/interventions
                    </code>
                    . HMAC signing stays available as an alternative.
                  </p>
                  {newKey && (
                    <div className="mt-3 rounded-xl border border-[#c4e5d6] bg-green-tint px-4 py-3">
                      <p className="text-[11px] font-semibold text-green-deep">
                        COPY NOW — shown only once ({newKey.label})
                      </p>
                      <p className="num mt-1 break-all text-[12px] text-green-deep">{newKey.key}</p>
                    </div>
                  )}
                  <div className="mt-3 flex gap-2">
                    <Input
                      value={keyLabel}
                      onChange={(e) => setKeyLabel(e.target.value)}
                      placeholder="Key label — e.g. Core banking (prod)"
                      className={cn(inputCls, "flex-1")}
                    />
                    <button
                      onClick={createProducerKey}
                      disabled={busy}
                      className="shrink-0 rounded-full border border-primary/40 bg-green-tint px-4 py-2.5 text-[12.5px] font-semibold text-primary transition hover:bg-green-tint/70 disabled:opacity-40"
                    >
                      Create key
                    </button>
                  </div>
                  {producerKeys.length > 0 && (
                    <ul className="mt-3 space-y-2">
                      {producerKeys.map((k) => (
                        <li
                          key={k.id}
                          className="flex items-center justify-between gap-3 rounded-xl border border-line bg-paper px-3.5 py-2.5"
                        >
                          <div className="min-w-0">
                            <p className="text-[12px] font-semibold">
                              {k.label}{" "}
                              {k.revoked && <span className="text-red-soft">(revoked)</span>}
                            </p>
                            <p className="text-[10.5px] text-ink-3">
                              created {new Date(k.createdAt).toLocaleDateString()}
                              {k.lastUsedAt
                                ? ` · last used ${new Date(k.lastUsedAt).toLocaleString()}`
                                : " · never used"}
                            </p>
                          </div>
                          {!k.revoked && (
                            <button
                              onClick={() => revokeProducerKey(k.id)}
                              className="text-[11px] font-semibold text-red-soft hover:underline"
                            >
                              Revoke
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}

            {tab === "team" && (
              <div className="space-y-5">
                <p className="text-[13px] leading-relaxed text-ink-2">
                  Analysts are provisioned through secure email invites — no public sign-up. Type a
                  colleague&apos;s work email and we&apos;ll queue an invite from the
                  fraud-operations admin.
                </p>
                <div className="flex gap-2">
                  <Input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="analyst@yourbank.ae"
                    className={cn(inputCls, "flex-1")}
                  />
                  <button
                    onClick={() => {
                      window.location.href = `mailto:otemaach@gmail.com?subject=${encodeURIComponent("SecureVoice seat invite: " + inviteEmail)}`;
                    }}
                    disabled={!inviteEmail.includes("@")}
                    className="shrink-0 rounded-full bg-primary px-5 py-2.5 text-[13px] font-semibold text-white transition hover:bg-green-deep disabled:opacity-40"
                  >
                    Invite
                  </button>
                </div>
                <p className="rounded-xl bg-paper px-4 py-3 text-[11.5px] leading-relaxed text-ink-3">
                  Enterprise flow: seats are created manually by the SecureVoice admin against your
                  Better Auth organization, and the invitee sets their own password via a one-time
                  link. Roles: <span className="font-semibold">Admin</span> (billing, seats, all
                  interventions) · <span className="font-semibold">Analyst</span> (Command Center +
                  firing signals).
                </p>
              </div>
            )}

            {tab === "billing" && (
              <div className="space-y-6">
                <div className="flex items-center justify-between rounded-2xl border border-line bg-paper px-5 py-4">
                  <div>
                    <p className="micro text-[9px] text-ink-3">PREPAID WALLET</p>
                    <p className="num mt-1 text-2xl font-semibold">
                      {settings?.credits ?? "—"} credits
                    </p>
                    <p className="text-[11.5px] text-ink-3">
                      1 credit = 1 intervention signal · deducted only on success
                    </p>
                  </div>
                  <Coins className="h-8 w-8 text-[#c9a227]" />
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    {
                      name: "Starter",
                      price: "$490",
                      per: "/month",
                      detail: "1,000 interventions · 1 bank entity · email support",
                    },
                    {
                      name: "Pro",
                      price: "$1,490",
                      per: "/month",
                      detail: "5,000 interventions · 5 entities · priority routing · SLA 99.9%",
                    },
                    {
                      name: "Enterprise",
                      price: "Custom",
                      per: "",
                      detail:
                        "Unlimited · VPC deployment · BYOK · custom voice clones · CBUAE audit pack",
                    },
                  ].map((t, i) => (
                    <div
                      key={t.name}
                      className={cn(
                        "rounded-2xl border p-4",
                        i === 1 ? "border-primary bg-green-tint/50" : "border-line bg-paper",
                      )}
                    >
                      <p className="font-display text-[14px] font-semibold">{t.name}</p>
                      <p className="mt-1">
                        <span className="font-display text-xl font-semibold">{t.price}</span>
                        <span className="text-[11px] text-ink-3"> {t.per}</span>
                      </p>
                      <p className="mt-2 text-[11px] leading-snug text-ink-3">{t.detail}</p>
                    </div>
                  ))}
                </div>
                <a
                  href="mailto:otemaach@gmail.com?subject=SecureVoice%20billing"
                  className="inline-flex items-center gap-2 rounded-full bg-primary px-6 py-2.5 text-[13px] font-semibold text-white transition hover:bg-green-deep"
                >
                  <Coins className="h-4 w-4" />
                  Top up / change plan
                </a>
              </div>
            )}
          </div>

          <div className="mt-6 flex items-center gap-2 text-[12px] text-ink-3">
            <ImageIcon className="h-3.5 w-3.5" />
            White-label preview appears in the Command Center header immediately after saving.
            <button
              onClick={() => setView("console")}
              className="font-semibold text-primary hover:underline"
            >
              Open Command Center →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
