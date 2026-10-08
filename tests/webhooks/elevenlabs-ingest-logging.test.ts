/**
 * The ingest rejection path used to be silent.
 *
 * A rotated `ELEVENLABS_WEBHOOK_SECRET`, a sender pointed at the wrong URL, or
 * an attacker probing the endpoint all produced the same observable outcome:
 * a bare 401 with nothing in the logs. An operator chasing "the bank says no
 * interventions were recorded" had no way to tell a signature rejection from a
 * provider that never called.
 *
 * This suite pins the NEW signal: every rejected delivery emits exactly one
 * structured line naming the outcome. It needs no database — a verification
 * failure returns before any query runs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/webhooks/elevenlabs/route";

const WEBHOOK_SECRET = "3a91c0de44b7".repeat(4);
const BODY = JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "c1" } });

const originalWarn = console.warn;
const originalError = console.error;
let lines: string[] = [];

function capture() {
  lines = [];
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
}

function post(headers: Record<string, string>) {
  return new NextRequest("http://localhost/api/webhooks/elevenlabs", {
    method: "POST",
    body: BODY,
    headers,
  });
}

beforeEach(() => {
  process.env.ELEVENLABS_WEBHOOK_SECRET = WEBHOOK_SECRET;
  capture();
});

afterEach(() => {
  console.warn = originalWarn;
  console.error = originalError;
  delete process.env.ELEVENLABS_WEBHOOK_SECRET;
});

describe("elevenlabs webhook ingest rejection logging", () => {
  test("a forged signature is 401 AND emits one structured rejection line", async () => {
    const res = await POST(post({ "elevenlabs-signature": "t=1,v0=deadbeef" }));
    expect(res.status).toBe(401);

    const rejection = lines.find((l) => l.includes("webhook ingest rejected"));
    expect(rejection).toBeDefined();
    const record = JSON.parse(rejection!);
    expect(record.level).toBe("warn");
    expect(record.msg).toBe("webhook ingest rejected");
    expect(record.fields.provider).toBe("elevenlabs");
    expect(record.fields.outcome).toBe("signature_verification_failed");
    expect(record.fields.signatureHeaderPresent).toBe(true);
    expect(record.fields.bodyBytes).toBe(new TextEncoder().encode(BODY).byteLength);
  });

  test("a missing signature header is recorded as absent, not merely rejected", async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(401);

    const record = JSON.parse(lines.find((l) => l.includes("webhook ingest rejected"))!);
    expect(record.fields.signatureHeaderPresent).toBe(false);
  });

  test("a rejected delivery is ONE event, not a scatter of lines", async () => {
    await POST(post({ "elevenlabs-signature": "t=1,v0=deadbeef" }));

    // `noUncheckedIndexedAccess` is on for the test project, so the single
    // element is `string | undefined` — assert the shape before indexing it
    // rather than sprinkling non-null assertions through the file.
    expect(lines).toHaveLength(1);
    const [only] = lines;
    expect(only).toBeDefined();
    const record = JSON.parse(only as string);
    expect(record.msg).toBe("webhook ingest rejected");
    expect(only!.includes("\n")).toBe(false);
  });
});
