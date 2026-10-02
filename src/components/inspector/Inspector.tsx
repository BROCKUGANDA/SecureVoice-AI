"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export type InspectorRow = {
  eventId: string;
  eventType: string;
  caseRef: string | null;
  body: string;
  signatureHeader: string | null;
  receivedAt: string;
  verified: boolean;
  reason: string;
  headerName: string;
};

const REFRESH_MS = 4000;

export function Inspector({ initialRows }: { initialRows: InspectorRow[] }) {
  const [rows, setRows] = useState<InspectorRow[]>(initialRows);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/webhooks/receiver", { cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      // The API returns stored rows; verdicts are recomputed by the page's
      // server component, so this refresh only updates the list timestamps.
      if (Array.isArray(json.events)) {
        setRows((prev) => {
          const next: InspectorRow[] = json.events.map((e: Record<string, unknown>) => {
            const known = prev.find((p) => p.eventId === e.eventId);
            return (
              known ?? {
                eventId: String(e.eventId),
                eventType: String(e.eventType),
                caseRef: (e.caseRef as string | null) ?? null,
                body: String(e.body),
                signatureHeader: (e.signatureHeader as string | null) ?? null,
                receivedAt: String(e.receivedAt),
                verified: Boolean(e.signatureValid),
                reason: "verdict computed on next server render",
                headerName: "sv-signature",
              }
            );
          });
          return next;
        });
      }
    } catch {
      /* the page stays on its last known state */
    }
  }, []);

  useEffect(() => {
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-white/10 px-4 py-8 text-center text-sm opacity-60">
        No signed webhook has arrived yet. Fire an intervention, or run{" "}
        <code className="opacity-90">bun scripts/outbox-worker.ts --once</code>.
      </p>
    );
  }

  return (
    <ul className="space-y-4">
      {rows.map((r) => (
        <li key={r.eventId} className="rounded-lg border border-white/10 bg-black/20 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={cn(
                "rounded px-2 py-0.5 text-xs font-medium",
                r.verified ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300",
              )}
            >
              {r.verified ? "VERIFIED" : "REJECTED"}
            </span>
            <span className="font-mono text-xs opacity-70">{r.eventType}</span>
            {r.caseRef ? <span className="font-mono text-xs opacity-50">{r.caseRef}</span> : null}
            <span className="ml-auto text-[11px] opacity-40">{new Date(r.receivedAt).toLocaleTimeString()}</span>
          </div>
          <p className="mt-2 text-xs opacity-70">{r.reason}</p>
          <div className="mt-3">
            <p className="text-[11px] uppercase tracking-wide opacity-40">{r.headerName}</p>
            <pre className="mt-1 overflow-x-auto rounded bg-black/40 p-2 font-mono text-[11px] leading-relaxed">
              {r.signatureHeader ?? "(none)"}
            </pre>
          </div>
          <div className="mt-3">
            <p className="text-[11px] uppercase tracking-wide opacity-40">raw body</p>
            <pre className="mt-1 max-h-56 overflow-auto rounded bg-black/40 p-2 font-mono text-[11px] leading-relaxed">
              {r.body}
            </pre>
          </div>
        </li>
      ))}
    </ul>
  );
}
