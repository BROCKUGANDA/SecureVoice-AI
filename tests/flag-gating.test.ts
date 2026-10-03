/**
 * Flag gating proved against the real modules, not just the flag reader.
 *
 * The unit tests in flags.test.ts prove `flag()` resolves correctly. These prove
 * something the unit tests cannot: that the modules which READ the flags
 * actually honour them. A flag that is registered, documented, tested — and then
 * not consulted by the code it claims to gate is the failure mode worth catching,
 * and it is invisible to the registry's own tests.
 *
 * Run with `bun tests/flag-gating.test.ts`.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";

const SECRET = "gating-secret";

/** Import lazily so each case sees the env as it was when the module loaded. */
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("realtime notifier honours the flags", () => {
  test("does not attempt ingest when the flag is off, even with a URL and secret", async () => {
    await withEnv(
      {
        FEATURE_REALTIME: "false",
        REALTIME_URL: "http://127.0.0.1:59999",
        REALTIME_INGEST_SECRET: SECRET,
      },
      async () => {
        const { notifyRealtime } = await import("../src/lib/realtime.ts");
        // Pointed at a closed port: if the gate did not hold, this would try a
        // real fetch and burn the timeout. `delivered:false` alone cannot tell
        // those apart, so assert it returns immediately instead.
        const t0 = Date.now();
        const res = await notifyRealtime({ orgId: "org_1", callRef: "SV-1", payload: {} });
        expect(res.delivered).toBe(false);
        expect(Date.now() - t0).toBeLessThan(500);
      },
    );
  });

  test("reports not-delivered when the flag is on but the secret is absent", async () => {
    await withEnv(
      {
        FEATURE_REALTIME: "true",
        REALTIME_URL: "http://127.0.0.1:59999",
        REALTIME_INGEST_SECRET: undefined,
      },
      async () => {
        const { notifyRealtime } = await import("../src/lib/realtime.ts");
        const t0 = Date.now();
        const res = await notifyRealtime({ orgId: "org_1", callRef: "SV-1", payload: {} });
        expect(res.delivered).toBe(false);
        expect(Date.now() - t0).toBeLessThan(500);
      },
    );
  });

  test("does not throw on a malformed flag value — it takes the safe default", async () => {
    await withEnv({ FEATURE_REALTIME: "yes" }, async () => {
      const { notifyRealtime } = await import("../src/lib/realtime.ts");
      // A throwing flag read inside the audit path would be exactly the failure
      // the notifier's no-throw contract exists to prevent. This regression
      // test is why `safeFlag()` exists: a config typo must degrade to "off",
      // not propagate out of `audit-chain.append()`.
      const res = await notifyRealtime({ orgId: "org_1", callRef: "SV-1", payload: {} });
      expect(res.delivered).toBe(false);
    });
  });
});

describe("every declared flag is reachable from an env var", () => {
  beforeEach(() => {
    delete process.env.FEATURE_REALTIME;
    delete process.env.FEATURE_CONSOLE_LIVE_FEED;
    delete process.env.FEATURE_PII_REDACTION;
    delete process.env.FEATURE_ELEVEN_LABS_LIVE;
    delete process.env.ELEVENLABS_DRY_RUN;
  });
  afterEach(() => {
    delete process.env.FEATURE_REALTIME;
    delete process.env.FEATURE_CONSOLE_LIVE_FEED;
    delete process.env.FEATURE_PII_REDACTION;
    delete process.env.FEATURE_ELEVEN_LABS_LIVE;
    delete process.env.ELEVENLABS_DRY_RUN;
  });

  test("every flag maps to an env var following the FEATURE_* convention", async () => {
    const { FLAG_NAMES, describeFlag } = await import("../src/lib/flags.ts");
    for (const n of FLAG_NAMES) {
      // elevenLabsLive is the one deliberate exception: it also reads
      // ELEVENLABS_DRY_RUN, which is why the legacy override map exists.
      if (n === "elevenLabsLive") continue;
      expect(describeFlag(n).envVar).toMatch(/^FEATURE_[A-Z_]+$/);
    }
  });

  test("the realtime flag and secret together are what the notifier requires", async () => {
    // REALTIME_INGEST_SECRET may legitimately exist in the developer's .env
    // (Bun auto-loads it) — the "no secret yet" half must control it explicitly.
    await withEnv({ FEATURE_REALTIME: "true", REALTIME_INGEST_SECRET: undefined }, async () => {
      const { realtimeConfigured } = await import("../src/lib/flags.ts");
      expect(realtimeConfigured()).toBe(false); // no secret yet
      process.env.REALTIME_INGEST_SECRET = SECRET;
      expect(realtimeConfigured()).toBe(true);
    });
  });

  test("safeFlag swallows a bad value and takes the conservative default", async () => {
    const { flag, safeFlag } = await import("../src/lib/flags.ts");
    process.env.FEATURE_PII_REDACTION = "nonsense";
    // Throwing is right for config surfaces and a defect in the audit path.
    expect(() => flag("piiRedaction")).toThrow();
    // Note the default it falls back to is `true` for this flag — the safe
    // direction is per-flag, not always `false`.
    expect(safeFlag("piiRedaction")).toBe(true);

    process.env.FEATURE_REALTIME = "nonsense";
    expect(safeFlag("realtime")).toBe(false);
  });
});
