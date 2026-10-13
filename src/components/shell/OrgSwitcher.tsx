"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Check, ChevronDown, Loader2 } from "lucide-react";
import { authClient, useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { useApp } from "@/lib/store";
import { useViewerSeat } from "@/lib/auth/use-viewer-seat";
import { describeWorkspaceSwitchError } from "@/lib/console-errors";
import { reportClientError } from "@/lib/client-diagnostics";

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
  const { lang, setView, view } = useApp();
  const { seat, isLoading: seatLoading } = useViewerSeat();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeId = session?.session?.activeOrganizationId ?? null;
  // `useListOrganizations` is the plugin's own query atom; it refetches when the
  // session changes, which is exactly when membership can have changed.
  const { data: orgs, isPending } = authClient.useListOrganizations();

  const list = (orgs ?? []) as { id: string; name: string }[];

  /*
   * WHO MAY SEE THIS CONTROL — the whole rule, in one place.
   *
   * The gate lives here rather than at the mount site so it cannot drift: the
   * navbar renders this component twice (desktop cluster and mobile panel), and
   * a rule written at both call sites is a rule that will eventually be edited
   * at one of them.
   *
   *   · `seatLoading` — the membership has not resolved. Rendering now would
   *     flash the chip at a judge and then withdraw it, which reads as a glitch.
   *   · `seat !== "operator"` — changing the tenant is an ADMINISTRATIVE act.
   *     A judge, a vendor seat and a demo viewer are all reading a tenant that
   *     is not theirs to choose. Before this, the control was offered to any
   *     signed-in session with two memberships, which is a description of the
   *     data, not of a permission.
   *   · `view === "demo"` — the demo is a recorded tour of a fictional tenant.
   *     Offering to switch workspace in the middle of it invites the viewer to
   *     change something that has no effect on what they are watching, and it
   *     crowded the bar with the one control nothing on screen depended on.
   */
  if (seatLoading || seat !== "operator" || view === "demo") return null;

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

  /**
   * Change tenant, and STAY WHERE YOU WERE.
   *
   * This handler used to end at a bare `router.refresh()`, which is what sent a
   * tenant change back to the landing page. Two things went wrong, and both had
   * to be fixed:
   *
   *  1. `router.refresh()` re-renders the RSC tree. The screen in the address bar
   *     is written with a raw `history.pushState` (src/app/page.tsx) rather than
   *     `router.push`, so a refresh re-resolved the route from a URL the router
   *     had never been told about, and the shell fell back to its initial view.
   *
   *  2. The refresh left the session mid-refetch, and the shell's RBAC gate read
   *     the momentarily-absent `activeOrganizationId` as "signed out" and sent
   *     the operator to the sign-in screen. That is fixed in src/app/page.tsx —
   *     the gate now declines to decide while the seat is unresolved — and the
   *     `setView(view)` below is the belt to that braces: the current view is
   *     re-asserted AFTER the switch, so even if something upstream resets it,
   *     the operator lands back on the screen they switched from.
   *
   * `router.refresh()` itself is kept, because it is the only thing that makes
   * every SERVER-rendered read of the session (TenantBrand in the root layout,
   * the console routes) re-evaluate against the new tenant. It is the client
   * view that needed pinning, not the server data.
   */
  const choose = async (id: string) => {
    if (id === activeId) {
      setOpen(false);
      return;
    }
    setPending(id);
    setError(null);
    // Captured now, re-applied below. Read from the store at click time rather
    // than closed over, so it is the view that was on screen when the operator
    // committed to the switch.
    const stayOn = useApp.getState().view;
    const { error: err } = await authClient.organization.setActive({ organizationId: id });
    setPending(null);
    if (err) {
      // The CODE, not `err.message`: Better Auth's text is English-only vendor
      // prose ("Organization not found", "Invalid origin") and this control sits
      // in the top nav of an Arabic-first console. The raw error is reported.
      reportClientError("workspace-switch", err, {
        ...(err.code ? { auth_code: String(err.code) } : {}),
      });
      setError(typeof err.code === "string" ? err.code : "switch_failed");
      return;
    }
    setOpen(false);
    router.refresh();
    // Same view, re-asserted — see the handler comment for why this is the belt
    // to the RBAC gate's braces.
    setView(stayOn);
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
                {describeWorkspaceSwitchError(error, lang)}
              </li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}
