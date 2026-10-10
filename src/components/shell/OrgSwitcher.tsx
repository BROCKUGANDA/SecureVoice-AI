"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Check, ChevronDown, Loader2 } from "lucide-react";
import { authClient, useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

/**
 * Tenant switcher — "which institution am I acting as".
 *
 * Why it exists: `activeOrganizationId` on the session IS the tenant. Every
 * console route derives its org scope from it (`getProfile` in
 * src/lib/credits.ts) and there is deliberately no client-supplied org
 * anywhere, so a person who genuinely belongs to two institutions has no way to
 * act as the second one. Worse, the failure mode is silent: the UI keeps
 * showing the first org's cases while the requests are correctly scoped to it,
 * so the operator concludes the other institution has no data.
 *
 * Multi-membership is not an option to turn on. The `member` table is a join
 * table, so a user can hold several rows; what is missing was only the ability
 * to choose between them.
 *
 * After switching: `setActive` mutates the session row server-side, and the
 * organizationClient atom listeners refetch the session. A `router.refresh()`
 * follows anyway, because every page here reads the session during server
 * render - without it the header would say "Bank A" above Bank B's dashboard
 * until the next navigation.
 *
 * The list comes from `listOrganizations`, so an organization the user cannot
 * see is not merely hidden client-side: the server decides membership.
 */
export function OrgSwitcher({ className }: { className?: string }) {
  const router = useRouter();
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeId = session?.session?.activeOrganizationId ?? null;
  // `useListOrganizations` is the plugin's own query atom; it refetches when the
  // session changes, which is exactly when membership can have changed.
  const { data: orgs, isPending } = authClient.useListOrganizations();

  const list = (orgs ?? []) as { id: string; name: string }[];
  // One org is not a choice — the control stays hidden rather than showing a
  // single-item menu that implies something can change.
  //
  // With no ACTIVE org but two orgs the control is still rendered: that state is
  // a dead end, not a choice. Every console route derives its org scope from
  // `activeOrganizationId` (src/lib/credits.ts), so with none set the operator
  // sees an empty console with no way to pick the tenant they belong to. The
  // menu becomes the only escape.
  if (list.length < 2) return null;

  const active = list.find((o) => o.id === activeId);
  const label = active?.name ?? "Select workspace";

  const choose = async (id: string) => {
    if (id === activeId) {
      setOpen(false);
      return;
    }
    setPending(id);
    setError(null);
    const { error: err } = await authClient.organization.setActive({ organizationId: id });
    setPending(null);
    if (err) {
      setError(err.message || "Could not switch organization");
      return;
    }
    setOpen(false);
    router.refresh();
  };

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`Acting as ${label}. Change organization`}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-2 text-[12.5px] font-semibold text-ink-2 transition hover:border-primary/40 hover:text-primary"
      >
        <Building2 className="h-3.5 w-3.5" />
        <span className="max-w-[8rem] truncate">{label}</span>
        {isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <ChevronDown className="h-3 w-3" />
        )}
      </button>

      {open && (
        <>
          {/* Click-away layer. A menu that cannot be dismissed with Escape is a
              keyboard trap, so this is a button, not a bare div. */}
          <button
            type="button"
            aria-label="Close organization menu"
            tabIndex={-1}
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <ul
            role="listbox"
            aria-label="Organizations"
            className="absolute end-0 z-50 mt-2 w-64 overflow-hidden rounded-2xl border border-line bg-paper shadow-lg"
          >
            {list.map((o) => {
              const selected = o.id === activeId;
              return (
                <li key={o.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={pending !== null}
                    onClick={() => void choose(o.id)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-4 py-2.5 text-start text-[12.5px] transition",
                      selected ? "bg-green-tint font-semibold text-green-deep" : "hover:bg-paper-2",
                    )}
                  >
                    <span className="truncate">{o.name}</span>
                    {pending === o.id ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                    ) : selected ? (
                      <Check className="h-3.5 w-3.5 shrink-0" />
                    ) : null}
                  </button>
                </li>
              );
            })}
            {error && (
              <li
                role="alert"
                className="border-t border-line px-4 py-2.5 text-[11.5px] text-red-soft"
              >
                {error}
              </li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}
