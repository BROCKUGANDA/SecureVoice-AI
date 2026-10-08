/**
 * Webhook ingest logging — asserts the route logs through the structured
 * logger contract (`@/lib/validation/safe-log`).
 *
 * The route calls `logError(msg, fields)` with the DEFAULT sink, which emits
 * exactly one `console.error` call per record carrying one JSON line shaped
 * `{ level, msg, ts, fields }`. So the least invasive assertion is capturing
 * `console.error` and parsing each line — no module mock, no sink injection,
 * no database (both paths below return before any query runs).
 */
import { expect, test } from "bun:test";
import type { NextRequest } from "next/server";
import { POST } from "@/app/api/webhooks/elevenlabs/route";

const SAVED_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET;

/** Capture console.error lines; safe-log's default sink writes one JSON line per record. */
function captureError() {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]): void => {
    lines.push(String(args[0]));
  };
  return {
    lines,
    restore(): void {
      console.error = real;
    },
  };
}

function postReq(): NextRequest {
  return new Request("http://localhost/api/webhooks/elevenlabs", {
    method: "POST",
    headers: { "content-type": "application/json", "elevenlabs-signature": "t=123,v0=deadbeef" },
    body: "{}",
  }) as NextRequest;
}

test("missing webhook secret logs a structured error record and returns 503", async () => {
  delete process.env.ELEVENLABS_WEBHOOK_SECRET;
  const cap = captureError();
  try {
    const res = await POST(postReq());
    expect(res.status).toBe(503);
    // One record, one line, valid JSON with the logger envelope.
    expect(cap.lines).toHaveLength(1);
    const record = JSON.parse(cap.lines[0]!) as {
      level: string;
      msg: string;
      ts: string;
      fields: Record<string, unknown>;
    };
    expect(record.level).toBe("error");
    expect(record.msg).toContain("ELEVENLABS_WEBHOOK_SECRET");
    expect(typeof record.ts).toBe("string");
    expect(record.fields).toBeDefined();
  } finally {
    cap.restore();
    if (SAVED_SECRET !== undefined) process.env.ELEVENLABS_WEBHOOK_SECRET = SAVED_SECRET;
  }
});

test("invalid signature is refused 401 without an error log", async () => {
  process.env.ELEVENLABS_WEBHOOK_SECRET = "test-secret-for-logging-suite";
  const cap = captureError();
  try {
    const res = await POST(postReq());
    expect(res.status).toBe(401);
    expect(cap.lines).toHaveLength(0);
  } finally {
    cap.restore();
    if (SAVED_SECRET !== undefined) process.env.ELEVENLABS_WEBHOOK_SECRET = SAVED_SECRET;
    else delete process.env.ELEVENLABS_WEBHOOK_SECRET;
  }
});
