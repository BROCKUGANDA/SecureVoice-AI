"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, RefreshCcw, Search, ShieldCheck, ShieldX, Download } from "lucide-react";
import { cn } from "@/lib/utils";

type AuditRow = {
  id: string;
  callRef: string | null;
  action: string | null;
  intent: string | null;
  callerId: string | null;
  redactedText: string | null;
  chainHash: string | null;
  prevHash: string | null;
  createdAt: string;
};

type RowsResp = {
  rows: AuditRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
};

type IntegrityResp = {
  chainsChecked: number;
  verified: number;
  broken: { callRef: string; brokenAt: string; expected: string; actual: string } | null;
  totalRows: number;
  complete: boolean;
};

type ChainRow = AuditRow & { id: string };
type ChainResp = {
  verification:
    | { ok: true; rows: number }
    | { ok: false; brokenAt: string; expected: string; actual: string; rows: number };
  rows: ChainRow[];
};

function short(s: string | null | undefined, n = 16) {
  if (!s) return "—";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function fmtDate(s: string) {
  try {
    return new Date(s).toISOString();
  } catch {
    return s;
  }
}

export default function AuditExplorer() {
  const [integrity, setIntegrity] = useState<IntegrityResp | null>(null);
  const [integrityLoading, setIntegrityLoading] = useState(false);
  const [rows, setRows] = useState<RowsResp | null>(null);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [action, setAction] = useState("");
  const [intent, setIntent] = useState("");
  const [actor, setActor] = useState("");
  const [callRef, setCallRef] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [limit] = useState(50);
  const [offset, setOffset] = useState(0);

  const [selectedCallRef, setSelectedCallRef] = useState<string | null>(null);
  const [chain, setChain] = useState<ChainResp | null>(null);
  const [chainLoading, setChainLoading] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (action.trim()) p.set("action", action.trim());
    if (intent.trim()) p.set("intent", intent.trim());
    if (actor.trim()) p.set("actor", actor.trim());
    if (callRef.trim()) p.set("callRef", callRef.trim());
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    p.set("limit", String(limit));
    p.set("offset", String(offset));
    return p.toString();
  }, [q, action, intent, actor, callRef, from, to, limit, offset]);

  const loadIntegrity = useCallback(async () => {
    setIntegrityLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/console/audit?scope=integrity", { cache: "no-store" });
      if (!res.ok) throw new Error(`integrity ${res.status}`);
      const j = (await res.json()) as IntegrityResp;
      setIntegrity(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIntegrityLoading(false);
    }
  }, []);

  const loadRows = useCallback(async () => {
    setRowsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/console/audit?scope=rows&${qs}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`rows ${res.status}`);
      const j = (await res.json()) as RowsResp;
      setRows(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRowsLoading(false);
    }
  }, [qs]);

  const loadChain = useCallback(async (ref: string) => {
    setChainLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/console/audit?callRef=${encodeURIComponent(ref)}`, {
        cache: "no-store",
      });
      if (res.status === 404) {
        setChain(null);
        return;
      }
      if (!res.ok) throw new Error(`chain ${res.status}`);
      const j = (await res.json()) as ChainResp;
      setChain(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChainLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadIntegrity();
  }, [loadIntegrity]);

  useEffect(() => {
    void loadRows();
  }, [loadRows]);

  // The compliance export is the privileged bulk case export
  // (`GET /api/auth/export`): same tenant boundary, CSV of case records for a
  // regulator or an auditor. GET, not POST — the route serves a file from a
  // query, and a 428 means the step-up expired: the operator must
  // re-authenticate rather than retry, so the message says so instead of
  // showing a status code.
  const [packBusy, setPackBusy] = useState(false);
  const exportPack = useCallback(async () => {
    setPackBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/export?take=500", { cache: "no-store" });
      if (res.status === 428) {
        throw new Error(
          "Re-authentication required before exporting case records (step-up expired).",
        );
      }
      if (res.status === 403) {
        throw new Error("Your role cannot bulk-export case records.");
      }
      if (!res.ok) throw new Error(`export ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `securevoice-cases-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPackBusy(false);
    }
  }, []);

  const exportCsv = useCallback(() => {
    if (!rows?.rows?.length) return;
    const headers = [
      "createdAt",
      "callRef",
      "action",
      "intent",
      "callerId",
      "redactedText",
      "chainHash",
      "prevHash",
      "id",
    ];
    const esc = (v: string | null | undefined) => {
      if (v === null || v === undefined) return "";
      const s = String(v).replace(/\r?\n/g, " ").replace(/"/g, '""');
      return `"${s}"`;
    };
    const lines = [headers.join(",")];
    for (const r of rows.rows) {
      lines.push(
        [
          r.createdAt,
          r.callRef,
          r.action,
          r.intent,
          r.callerId,
          r.redactedText,
          r.chainHash,
          r.prevHash,
          r.id,
        ]
          .map(esc)
          .join(","),
      );
    }
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-rows-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [rows]);

  const exportJson = useCallback(() => {
    if (!rows?.rows?.length) return;
    const blob = new Blob([JSON.stringify(rows.rows, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-rows-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [rows]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Audit explorer</h1>
          <p className="text-sm text-muted-foreground">
            Tenant-scoped audit rows, filters, pagination and org-wide integrity. Reads use{" "}
            <code className="text-xs">scope=rows</code> and{" "}
            <code className="text-xs">scope=integrity</code>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadIntegrity()}
            disabled={integrityLoading}
          >
            {integrityLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCcw className="mr-2 h-4 w-4" />
            )}
            Refresh integrity
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadRows()}
            disabled={rowsLoading}
          >
            {rowsLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCcw className="mr-2 h-4 w-4" />
            )}
            Refresh rows
          </Button>
          <Button variant="outline" size="sm" onClick={() => void exportPack()} disabled={packBusy}>
            {packBusy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Compliance pack
          </Button>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rows?.rows?.length}>
            <Download className="mr-2 h-4 w-4" />
            CSV
          </Button>
          <Button variant="outline" size="sm" onClick={exportJson} disabled={!rows?.rows?.length}>
            <Download className="mr-2 h-4 w-4" />
            JSON
          </Button>
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50/60 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/20 dark:text-red-300"
        >
          {error}
        </div>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            {integrity?.broken ? (
              <ShieldX className="h-4 w-4 text-red-500" />
            ) : (
              <ShieldCheck
                className={cn(
                  "h-4 w-4",
                  integrity?.verified ? "text-green-500" : "text-muted-foreground",
                )}
              />
            )}
            Org-wide integrity
          </CardTitle>
          <CardDescription>
            {integrity ? (
              <>
                {integrity.chainsChecked} chain{integrity.chainsChecked === 1 ? "" : "s"} checked,{" "}
                {integrity.verified} verified
                {integrity.broken ? ` — BROKEN at ${integrity.broken.callRef}` : " — OK"}
                {integrity.complete ? " (complete)" : " (capped at 200)"}, {integrity.totalRows}{" "}
                total rows
              </>
            ) : (
              "Loading…"
            )}
          </CardDescription>
        </CardHeader>
        {integrity?.broken ? (
          <CardContent className="pt-0">
            <div className="rounded-md border border-red-200 bg-red-50/60 p-3 text-sm dark:border-red-900 dark:bg-red-950/20">
              <div className="font-medium text-red-700 dark:text-red-300">Tamper detected</div>
              <div className="mt-1 grid gap-1 text-xs text-red-700/90 dark:text-red-300/90">
                <div>callRef: {integrity.broken.callRef}</div>
                <div>brokenAt: {integrity.broken.brokenAt}</div>
                <div>expected: {short(integrity.broken.expected, 48)}</div>
                <div>actual: {short(integrity.broken.actual, 48)}</div>
              </div>
            </div>
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filters</CardTitle>
          <CardDescription>
            Narrow by text, actor, action/intent, callRef or date range.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label htmlFor="q" className="text-xs">
              Search (redactedText or callRef)
            </Label>
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                id="q"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="contains…"
                className="pl-8"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="action" className="text-xs">
              Action
            </Label>
            <Input
              id="action"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              placeholder="freeze / handoff…"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="intent" className="text-xs">
              Intent
            </Label>
            <Input
              id="intent"
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              placeholder="…"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="actor" className="text-xs">
              Actor (callerId)
            </Label>
            <Input
              id="actor"
              value={actor}
              onChange={(e) => setActor(e.target.value)}
              placeholder="seed / user id…"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="callRef" className="text-xs">
              callRef
            </Label>
            <Input
              id="callRef"
              value={callRef}
              onChange={(e) => setCallRef(e.target.value)}
              placeholder="SV-…"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="from" className="text-xs">
              From (ISO)
            </Label>
            <Input
              id="from"
              type="datetime-local"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="to" className="text-xs">
              To (ISO)
            </Label>
            <Input
              id="to"
              type="datetime-local"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="flex items-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setOffset(0);
                void loadRows();
              }}
              disabled={rowsLoading}
            >
              Apply
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setQ("");
                setAction("");
                setIntent("");
                setActor("");
                setCallRef("");
                setFrom("");
                setTo("");
                setOffset(0);
              }}
            >
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Rows</CardTitle>
          <CardDescription>
            {rows ? (
              <>
                Showing {rows.rows.length} of {rows.total} (limit {rows.limit}, offset {rows.offset}
                ){rows.hasMore ? " — has more" : ""}
              </>
            ) : (
              "Loading…"
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">When</TableHead>
                  <TableHead className="whitespace-nowrap">callRef</TableHead>
                  <TableHead className="whitespace-nowrap">action/intent</TableHead>
                  <TableHead className="whitespace-nowrap">actor</TableHead>
                  <TableHead>redactedText</TableHead>
                  <TableHead className="whitespace-nowrap">chain/prev</TableHead>
                  <TableHead className="whitespace-nowrap">id</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rowsLoading ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : rows?.rows?.length ? (
                  rows.rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap text-xs">
                        {fmtDate(r.createdAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <button
                          className="text-left text-xs font-medium hover:underline"
                          onClick={() => {
                            setSelectedCallRef(r.callRef);
                            setChainOpen(true);
                            if (r.callRef) void loadChain(r.callRef);
                          }}
                        >
                          {r.callRef || "—"}
                        </button>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <div className="flex flex-wrap items-center gap-1">
                          {r.action ? (
                            <Badge variant="outline" className="text-[10px]">
                              {r.action}
                            </Badge>
                          ) : null}
                          {r.intent && r.intent !== r.action ? (
                            <Badge variant="outline" className="text-[10px]">
                              {r.intent}
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {r.callerId || "—"}
                      </TableCell>
                      <TableCell
                        className="max-w-[420px] truncate text-xs"
                        title={r.redactedText || undefined}
                      >
                        {r.redactedText || "—"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-[10px] text-muted-foreground">
                        <div>chain:{short(r.chainHash)}</div>
                        <div>prev:{short(r.prevHash)}</div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-[10px] text-muted-foreground">
                        {short(r.id, 10)}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      No rows for these filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between gap-2 p-3">
            <div className="text-xs text-muted-foreground">Page offset {rows?.offset ?? 0}</div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!rows?.offset || rowsLoading}
                onClick={() => setOffset(Math.max(0, (rows?.offset ?? 0) - (rows?.limit ?? limit)))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!rows?.hasMore || rowsLoading}
                onClick={() =>
                  setOffset(rows?.nextOffset ?? (rows?.offset ?? 0) + (rows?.limit ?? limit))
                }
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Sheet open={chainOpen} onOpenChange={setChainOpen}>
        <SheetContent className="w-full sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Chain walk: {selectedCallRef || "—"}</SheetTitle>
            <SheetDescription>
              {chain ? (
                <>
                  {chain.verification.ok
                    ? `OK — ${chain.verification.rows} row${chain.verification.rows === 1 ? "" : "s"}`
                    : `BROKEN at ${chain.verification.brokenAt} — ${chain.verification.rows} rows`}
                </>
              ) : (
                "Loading…"
              )}
            </SheetDescription>
          </SheetHeader>
          <Separator className="my-3" />
          <ScrollArea className="h-[calc(100vh-140px)] pr-4">
            {chainLoading ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />
                Loading chain…
              </div>
            ) : chain?.rows?.length ? (
              <div className="space-y-3">
                {chain.rows.map((r, i) => (
                  <Card key={r.id}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">
                        #{i + 1} — {r.action || r.intent || "event"}
                      </CardTitle>
                      <CardDescription className="text-xs">
                        {fmtDate(r.createdAt)} · caller {r.callerId || "—"}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2 text-xs">
                      <div>
                        <div className="text-muted-foreground">redactedText</div>
                        <div className="whitespace-pre-wrap break-words">
                          {r.redactedText || "—"}
                        </div>
                      </div>
                      <div className="grid gap-1 md:grid-cols-2">
                        <div>
                          <div className="text-muted-foreground">chainHash</div>
                          <code className="break-all">{r.chainHash}</code>
                        </div>
                        <div>
                          <div className="text-muted-foreground">prevHash</div>
                          <code className="break-all">{r.prevHash || "GENESIS"}</code>
                        </div>
                      </div>
                      <div className="text-muted-foreground">id: {r.id}</div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No chain rows returned for this callRef.
              </div>
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </div>
  );
}
