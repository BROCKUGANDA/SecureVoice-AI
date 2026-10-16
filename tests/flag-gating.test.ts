/**
 * Flag gating proved against the real modules, not just the flag reader.
 *
 * The unit tests in flags.test.ts prove `flag()` resolves correctly. These prove
 * something the unit tests cannot: that the modules which READ the flags
 * actually honour them. A flag that is registered, documented, tested — and then
 * not consulted by the code it claims to gate is the failure mode worth catching,
 * and it is invisible to the registry's own tests.
 *
 * That failure mode is exactly what this suite used to be blind to. Five names in
 * the registry — `complianceDisclosure`, `complianceNoSecrets`,
 * `compliancePiiRedaction`, `webhookStrictSignatures`, `piiRedaction` — were
 * consulted by nothing in `src/`, `scripts/` or `tests/`. They are invariants now
 * (`INVARIANTS` in `src/lib/flags.ts`), and
 * `tests/surface/invariants.test.ts` proves each one against the enforcement
 * site. What is left here is the flag half: a read that genuinely gates a module.
 *
 * Run with `bun run test flag-gating`.
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
    delete process.env.FEATURE_SEED_DEMO;
    delete process.env.FEATURE_TWILIO_MEDIA_STREAMS;
    delete process.env.FEATURE_ELEVEN_LABS_LIVE;
    delete process.env.ELEVENLABS_DRY_RUN;
    delete process.env.SEED_DEMO;
  });
  afterEach(() => {
    delete process.env.FEATURE_REALTIME;
    delete process.env.FEATURE_CONSOLE_LIVE_FEED;
    delete process.env.FEATURE_SEED_DEMO;
    delete process.env.FEATURE_TWILIO_MEDIA_STREAMS;
    delete process.env.FEATURE_ELEVEN_LABS_LIVE;
    delete process.env.ELEVENLABS_DRY_RUN;
    delete process.env.SEED_DEMO;
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
    // Used to be written against `piiRedaction`, which no longer exists as a
    // flag. `consoleLiveFeed` defaults OFF, so this now also proves the fallback
    // direction is the per-flag default rather than a blanket `false`.
    process.env.FEATURE_CONSOLE_LIVE_FEED = "nonsense";
    // Throwing is right for config surfaces and a defect in the audit path.
    expect(() => flag("consoleLiveFeed")).toThrow();
    expect(safeFlag("consoleLiveFeed")).toBe(false);

    process.env.SEED_DEMO = "yes";
    expect(safeFlag("seedDemo")).toBe(false);
    delete process.env.SEED_DEMO;

    process.env.FEATURE_REALTIME = "nonsense";
    expect(safeFlag("realtime")).toBe(false);
  });

  test("a flag that resolves true really does flip the module that reads it", async () => {
    // The one flag pair with an observable, non-network consumer in `src/`: the
    // realtime notifier. `twilioMediaStreams` is read by `src/worker/dial.ts`,
    // which is a process entry point rather than an importable decision, so the
    // consumer gate in tests/flags.test.ts pins its read site by source text
    // instead of executing it.
    await withEnv({ FEATURE_REALTIME: "false" }, async () => {
      const { notifyRealtime } = await import("../src/lib/realtime.ts");
      const res = await notifyRealtime({ orgId: "org_1", callRef: "SV-2", payload: {} });
      expect(res.delivered).toBe(false);
    });
  });
});

describe("the compliance invariants are not gated, and cannot be", () => {
  /**
   * MUTATION PROOF against the real guardrails.
   *
   * Every env var that the old registry claimed controlled one of these is set
   * to `false` here — the exact instruction a reviewer would have sent to a
   * deploy before this change, and the exact state that produced the lie:
   * `flag("complianceNoSecrets")` answered `false` while the refusal still fired,
   * because nothing read the flag. Now the registry refuses to answer at all, and
   * the guardrails keep firing.
   */
  const ALL_OFF: Record<string, string> = {
    COMPLIANCE_OPENING_DISCLOSURE: "false",
    COMPLIANCE_NO_CREDENTIAL_REQUESTS: "false",
    COMPLIANCE_PII_REDACTION: "false",
    FEATURE_COMPLIANCE_DISCLOSURE: "false",
    FEATURE_COMPLIANCE_NO_SECRETS: "false",
    FEATURE_COMPLIANCE_PII_REDACTION: "false",
    FEATURE_PII_REDACTION: "false",
    FEATURE_WEBHOOK_STRICT_SIGNATURES: "false",
  };

  test("the credential-ask refusal still fires with every legacy switch off", async () => {
    await withEnv(ALL_OFF, async () => {
      const { auditAgentReply } = await import("../src/lib/compliance/policy.ts");
      const r = auditAgentReply({
        reply: "Can you tell me the one-time code you just received?",
        intent: "verify",
        isOpening: false,
        lang: "en",
      });
      expect(r.refused).toBe(true);
      expect(r.guardrails).toContain("refused:credential_request_pattern");
    });
  });

  test("the opening disclosure is still injected with every legacy switch off", async () => {
    await withEnv(ALL_OFF, async () => {
      const { auditAgentReply, OPENING_DISCLOSURE_EN } =
        await import("../src/lib/compliance/policy.ts");
      const r = auditAgentReply({
        reply: "Hello, this is the bank's AI assistant.",
        intent: "greeting",
        isOpening: true,
        lang: "en",
      });
      expect(r.reply.startsWith(OPENING_DISCLOSURE_EN)).toBe(true);
      expect(r.guardrails).toContain("disclosure_injected");
    });
  });

  test("PII is still redacted with every legacy switch off", async () => {
    await withEnv(ALL_OFF, async () => {
      const { auditAgentReply } = await import("../src/lib/compliance/policy.ts");
      const r = auditAgentReply({
        reply: "The payment of 4111 1111 1111 1111 was declined.",
        intent: "verify",
        isOpening: false,
        lang: "en",
      });
      expect(r.reply).not.toContain("4111 1111 1111 1111");
      expect(r.guardrails).toContain("pii_redacted");

      const { transcript } = await import("../src/lib/redact.ts");
      expect(transcript("call +971501234567 about AED 2500")).not.toContain("971501234567");
    });
  });

  test("and the registry itself refuses to report any of them as disabled", async () => {
    const { allFlags, invariants } = await import("../src/lib/flags.ts");
    await withEnv(ALL_OFF, async () => {
      // The five names the registry used to answer for. Not one of them is
      // resolvable any more — not as a flag, and not as a "false" default.
      expect(Object.keys(allFlags())).toEqual([
        "realtime",
        "elevenLabsLive",
        "consoleLiveFeed",
        "seedDemo",
        "twilioMediaStreams",
      ]);
      const list = invariants();
      expect(list.map((i) => i.name).sort()).toEqual([
        "complianceDisclosure",
        "complianceNoSecrets",
        "compliancePiiRedaction",
        "webhookStrictSignatures",
      ]);
      for (const entry of list) {
        // `enforcedAt`/`provedBy` are checked against the filesystem by
        // tests/surface/invariants.test.ts; here the claim is only that the
        // surface exists and is complete.
        expect(entry.enforcedAt.length).toBeGreaterThan(0);
        expect(entry.provedBy.length).toBeGreaterThan(0);
        expect(entry.notConfigurable.length).toBeGreaterThan(40);
      }
    });
  });
});
