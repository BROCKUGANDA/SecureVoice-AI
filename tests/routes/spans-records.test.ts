/**
 * Span record pagination (`GET /api/status/spans?format=records`).
 *
 * The panel block is summaries (small); the unbounded payload is raw records,
 * which is what the drill-down pages through. These tests drive the real route
 * against a scratch span log (`TELEMETRY_SPAN_LOG` override), so paging,
 * filtering, sorting and the trimmed projection are proven where they ship —
 * a pure-helper test alone would leave the route's param parsing unexercised.
 *
 * Operator-guarded like the route: `getProfile` is mocked to an operator, the
 * way tests/tenancy/console-routes.test.ts mocks the same seam.
 */

import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as realCredits from "@/lib/credits";

mock.module("@/lib/credits", () => ({
  ...realCredits,
  getProfile: async () => ({
    userId: "spans-operator",
    email: "spans@example.test",
    name: "Spans",
    role: "operator" as const,
    orgId: null,
    credits: 500,
    walletScope: "user" as const,
  }),
}));

const dir = mkdtempSync(join(tmpdir(), "spans-records-"));
const LOG = join(dir, "spans.jsonl");
const prevLog = process.env.TELEMETRY_SPAN_LOG;

function record(span: string, startedAtMs: number, durationMs: number, intervention: string) {
  return {
    v: 1,
    span,
    origin: "live",
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(startedAtMs + durationMs).toISOString(),
    startedAtMs,
    endedAtMs: startedAtMs + durationMs,
    durationMs,
    traceId: "0".repeat(32),
    spanId: "1".repeat(16),
    interventionId: intervention,
    conversationId: null,
    caseRef: null,
    attributes: { cached: false },
  };
}

beforeAll(() => {
  process.env.TELEMETRY_SPAN_LOG = LOG;
  const base = Date.UTC(2026, 9, 16, 12, 0, 0);
  const lines = [
    // 3 samples of one span (durations spread for slowest-first ordering),
    record("tool_request_to_response", base, 120, "iv-1"),
    record("tool_request_to_response", base + 1000, 300, "iv-2"),
    record("tool_request_to_response", base + 2000, 200, "iv-3"),
    // 2 samples of another span,
    record("signal_received_to_accepted", base + 3000, 50, "iv-4"),
    record("signal_received_to_accepted", base + 4000, 80, "iv-5"),
  ];
  writeFileSync(LOG, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
});

afterAll(() => {
  if (prevLog === undefined) delete process.env.TELEMETRY_SPAN_LOG;
  else process.env.TELEMETRY_SPAN_LOG = prevLog;
  rmSync(dir, { recursive: true, force: true });
});

async function get(query: string) {
  const { GET } = await import("@/app/api/status/spans/route");
  const res = await GET(new NextRequest(`http://localhost/api/status/spans?${query}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

type Page = {
  records: Array<{
    span: string;
    durationMs: number;
    traceId?: string;
    spanId?: string;
    v?: number;
  }>;
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
};

test("records paginate newest-first with a trimmed projection", async () => {
  const { status, body } = await get("format=records&page=1&pageSize=2");
  expect(status).toBe(200);
  const page = body as unknown as Page;
  expect(page.total).toBe(5);
  expect(page.page).toBe(1);
  expect(page.pageSize).toBe(2);
  expect(page.records).toHaveLength(2);
  expect(page.hasMore).toBe(true);
  // Newest first: the two latest writes.
  expect(page.records[0]?.durationMs).toBe(80);
  expect(page.records[1]?.durationMs).toBe(50);
  // Trimmed: join keys, version and both wall-clock forms are gone; the
  // display fields (including the `cached` attribute) remain.
  for (const r of page.records) {
    expect(r.traceId).toBeUndefined();
    expect(r.spanId).toBeUndefined();
    expect(r.v).toBeUndefined();
    expect(typeof r.span).toBe("string");
    expect(typeof r.durationMs).toBe("number");
  }

  const second = (await get("format=records&page=2&pageSize=2")).body as unknown as Page;
  expect(second.records).toHaveLength(2);
  expect(second.hasMore).toBe(true);
  const third = (await get("format=records&page=3&pageSize=2")).body as unknown as Page;
  expect(third.records).toHaveLength(1);
  expect(third.hasMore).toBe(false);
  // Pages do not repeat rows.
  const ids = [...page.records, ...second.records, ...third.records].map(
    (r) => `${r.span}:${r.durationMs}`,
  );
  expect(new Set(ids).size).toBe(5);
}, 60_000);

test("span filter and slowest-first sort compose with paging", async () => {
  const { body } = await get(
    "format=records&span=tool_request_to_response&sort=slowest&page=1&pageSize=2",
  );
  const page = body as unknown as Page;
  expect(page.total).toBe(3);
  expect(page.records.map((r) => r.durationMs)).toEqual([300, 200]);
  expect(page.hasMore).toBe(true);
}, 60_000);

test("an out-of-range page is empty, not an error", async () => {
  const { status, body } = await get("format=records&page=99&pageSize=10");
  expect(status).toBe(200);
  const page = body as unknown as Page;
  expect(page.records).toEqual([]);
  expect(page.total).toBe(5);
  expect(page.hasMore).toBe(false);
}, 60_000);

test("pageSize is clamped so one request cannot page the whole log", async () => {
  const { body } = await get("format=records&pageSize=1000000");
  const page = body as unknown as Page;
  expect(page.pageSize).toBeLessThanOrEqual(500);
  expect(page.records.length).toBeLessThanOrEqual(500);
}, 60_000);

test("paged OTLP is wrapped; unpaged OTLP keeps its collector shape", async () => {
  const wrapped = await get("format=otlp&page=1&pageSize=2");
  expect(wrapped.status).toBe(200);
  const w = wrapped.body as { data?: unknown; total?: number; hasMore?: boolean };
  expect(w.total).toBe(5);
  expect(w.hasMore).toBe(true);
  expect(w.data).toBeDefined();

  const raw = await get("format=otlp");
  expect(raw.status).toBe(200);
  const r = raw.body as Record<string, unknown>;
  // Unwrapped: no pagination envelope, so existing collectors keep working.
  expect(r).not.toHaveProperty("page");
  expect(r).not.toHaveProperty("total");
}, 60_000);
