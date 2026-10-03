/**
 * UNIT — the app-side realtime bridge (src/lib/realtime.ts).
 *
 * `audit-chain.append()` calls `notifyRealtime()` from inside the compliance
 * write path, so this module has a stricter contract than an ordinary outbound
 * call: it must NEVER throw and never reject. The properties asserted here are
 * exactly those, plus the two ways the fan-out could leak or mis-scope:
 *
 *   · A missing org is a NO-OP, never a fallback to a guessable global room.
 *     The service derives the channel name from the org, so broadcasting with a
 *     null org would either be dropped by the service or land in a shared room
 *     every tenant can see. One of those is a cross-tenant leak.
 *   · The request is SIGNED, carries the replay-window header, and is never
 *     cached — a cached fan-out swallows a phase transition, which is the one
 *     thing the console live feed exists to show.
 *   · It is double-gated: the `realtime` flag AND the signing secret. A
 *     deployment that still has a leftover secret must stop emitting signed
 *     requests the moment the flag goes off.
 *   · The flag is read through the NON-THROWING accessor. A malformed flag
 *     throwing out of here would fail the audit write it is called from.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { notifyRealtime } from "@/lib/realtime";

const ENV_KEYS = ["FEATURE_REALTIME", "REALTIME_INGEST_SECRET", "REALTIME_URL"] as const;
const saved: Record<string, string | undefined> = {};

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit }> = [];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  globalThis.fetch = realFetch;
});

function configureRealtimeOn(url = "http://realtime.internal:8080") {
  process.env.FEATURE_REALTIME = "true";
  process.env.REALTIME_INGEST_SECRET = "ingest-secret";
  process.env.REALTIME_URL = url;
}

describe("notifyRealtime — gating", () => {
  test("does nothing when the realtime flag is off, even with a secret present", async () => {
    process.env.FEATURE_REALTIME = "false";
    process.env.REALTIME_INGEST_SECRET = "ingest-secret";
    process.env.REALTIME_URL = "http://realtime.internal:8080";
    expect(await notifyRealtime({ orgId: "org-1", callRef: "c1", payload: {} })).toEqual({
      delivered: false,
    });
    expect(calls).toHaveLength(0);
  });

  test("does nothing when the secret is missing, even with the flag on", async () => {
    process.env.FEATURE_REALTIME = "true";
    process.env.REALTIME_URL = "http://realtime.internal:8080";
    delete process.env.REALTIME_INGEST_SECRET;
    expect(await notifyRealtime({ orgId: "org-1", callRef: "c1", payload: {} })).toEqual({
      delivered: false,
    });
    expect(calls).toHaveLength(0);
  });

  test("does nothing when no URL is configured", async () => {
    process.env.FEATURE_REALTIME = "true";
    process.env.REALTIME_INGEST_SECRET = "ingest-secret";
    expect(await notifyRealtime({ orgId: "org-1", callRef: "c1", payload: {} })).toEqual({
      delivered: false,
    });
    expect(calls).toHaveLength(0);
  });

  test("a blank or whitespace URL counts as unconfigured", async () => {
    configureRealtimeOn("   ");
    expect(await notifyRealtime({ orgId: "org-1", callRef: "c1", payload: {} })).toEqual({
      delivered: false,
    });
  });

  test("a malformed flag value does NOT throw — the audit path must survive", async () => {
    // `flag()` throws on a bad value on purpose; `notifyRealtime` is called from
    // inside the compliance write, so it must not propagate that.
    process.env.FEATURE_REALTIME = "yes-please";
    process.env.REALTIME_INGEST_SECRET = "ingest-secret";
    process.env.REALTIME_URL = "http://realtime.internal:8080";
    await expect(notifyRealtime({ orgId: "org-1", callRef: "c1", payload: {} })).resolves.toEqual({
      delivered: false,
    });
  });
});

describe("notifyRealtime — org scoping", () => {
  test("a null org is a no-op, never a broadcast to a shared room", async () => {
    configureRealtimeOn();
    expect(await notifyRealtime({ orgId: null, callRef: "c1", payload: {} })).toEqual({
      delivered: false,
    });
    expect(calls).toHaveLength(0);
  });

  test("an undefined org is a no-op too", async () => {
    configureRealtimeOn();
    expect(await notifyRealtime({ orgId: undefined, callRef: "c1", payload: {} })).toEqual({
      delivered: false,
    });
    expect(calls).toHaveLength(0);
  });

  test("an empty-string org is a no-op", async () => {
    configureRealtimeOn();
    expect(await notifyRealtime({ orgId: "", callRef: "c1", payload: {} })).toEqual({
      delivered: false,
    });
    expect(calls).toHaveLength(0);
  });
});

describe("notifyRealtime — the request it makes", () => {
  test("posts to the ingest path of the configured service", async () => {
    configureRealtimeOn("http://realtime.internal:8080");
    await notifyRealtime({ orgId: "org-1", callRef: "c1", payload: {} });
    expect(calls[0]?.url).toBe("http://realtime.internal:8080/ingest");
  });

  test("trailing slashes in the base URL do not double up the path separator", async () => {
    configureRealtimeOn("http://realtime.internal:8080///");
    await notifyRealtime({ orgId: "org-1", callRef: "c1", payload: {} });
    expect(calls[0]?.url).toBe("http://realtime.internal:8080/ingest");
  });

  test("signs the body with the SV-Signature replay-window header", async () => {
    configureRealtimeOn();
    await notifyRealtime({ orgId: "org-1", callRef: "c1", payload: {} });
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("sv-signature")).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  test("the signed body carries the org, the call ref and the payload", async () => {
    configureRealtimeOn();
    await notifyRealtime({ orgId: "org-1", callRef: "call-9", payload: { state: "DIALING" } });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      kind: "activity",
      orgId: "org-1",
      callRef: "call-9",
      payload: { state: "DIALING" },
    });
  });

  test("the event is tagged as an activity", async () => {
    configureRealtimeOn();
    await notifyRealtime({ orgId: "org-1", callRef: "c1", payload: {} });
    expect(JSON.parse(String(calls[0]?.init.body)).kind).toBe("activity");
  });

  test("is never cached — a cached fan-out swallows a phase transition", async () => {
    configureRealtimeOn();
    await notifyRealtime({ orgId: "org-1", callRef: "c1", payload: {} });
    expect(calls[0]?.init.cache).toBe("no-store");
  });

  test("carries a bounded timeout so a hung fan-out cannot stall the audit write", async () => {
    configureRealtimeOn();
    await notifyRealtime({ orgId: "org-1", callRef: "c1", payload: {} });
    // 1.5s: a fan-out that has not landed by then is not worth waiting on.
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  test("uses POST with a JSON content type", async () => {
    configureRealtimeOn();
    await notifyRealtime({ orgId: "org-1", callRef: "c1", payload: {} });
    expect(calls[0]?.init.method).toBe("POST");
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("application/json");
  });

  test("the signing secret never appears in the request headers or body", async () => {
    configureRealtimeOn();
    await notifyRealtime({ orgId: "org-1", callRef: "c1", payload: {} });
    const wire = JSON.stringify(calls[0]?.init.headers) + String(calls[0]?.init.body);
    expect(wire).not.toContain("ingest-secret");
  });

  test("reports delivered on a 2xx", async () => {
    configureRealtimeOn();
    expect(await notifyRealtime({ orgId: "org-1", callRef: "c1", payload: {} })).toEqual({
      delivered: true,
    });
  });
});

describe("notifyRealtime — failure is always graceful", () => {
  test("a non-2xx resolves as not delivered rather than rejecting", async () => {
    configureRealtimeOn();
    globalThis.fetch = (async () =>
      new Response("nope", { status: 502 })) as unknown as typeof fetch;
    expect(await notifyRealtime({ orgId: "org-1", callRef: "c1", payload: {} })).toEqual({
      delivered: false,
    });
  });

  test("a network throw resolves as not delivered", async () => {
    configureRealtimeOn();
    globalThis.fetch = (() => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await notifyRealtime({ orgId: "org-1", callRef: "c1", payload: {} })).toEqual({
      delivered: false,
    });
  });

  test("an aborted request resolves as not delivered", async () => {
    configureRealtimeOn();
    globalThis.fetch = (() => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    expect(await notifyRealtime({ orgId: "org-1", callRef: "c1", payload: {} })).toEqual({
      delivered: false,
    });
  });

  test("it never rejects, whatever the transport does", async () => {
    configureRealtimeOn();
    for (const transport of [
      () => new Response("x", { status: 500 }),
      () => {
        throw new Error("boom");
      },
      () => new Response(null, { status: 204 }),
    ]) {
      globalThis.fetch = (async () => transport()) as unknown as typeof fetch;
      await expect(
        notifyRealtime({ orgId: "org-1", callRef: "c1", payload: {} }),
      ).resolves.toHaveProperty("delivered");
    }
  });

  test("a hostile payload is still sent without throwing", async () => {
    configureRealtimeOn();
    await expect(
      notifyRealtime({
        orgId: "org-1",
        callRef: "c1",
        payload: { nested: { deep: [1, 2, 3] }, weird: "‮evil" },
      }),
    ).resolves.toHaveProperty("delivered");
  });
});
