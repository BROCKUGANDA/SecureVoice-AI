/**
 * Feature-flag behaviour that must not regress silently.
 *
 * The flags this registry controls touch money (ElevenLabs live voice), PII
 * handling (redaction), and the realtime transport, so the tests here are
 * deliberately about the *safe* direction: a bad value fails loudly, a missing
 * value falls back to the conservative default, and a client never learns a
 * server-only fact.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  FLAG_NAMES,
  flag,
  allFlags,
  describeFlag,
  realtimeConfigured,
  clientFlags,
  type FlagName,
} from "../src/lib/flags.ts";

/** Every var this module can read, so each test starts from a clean slate. */
const TOUCHED = [
  "FEATURE_REALTIME",
  "FEATURE_ELEVEN_LABS_LIVE",
  "FEATURE_PII_REDACTION",
  "FEATURE_CONSOLE_LIVE_FEED",
  "ELEVENLABS_DRY_RUN",
  "REALTIME_INGEST_SECRET",
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of TOUCHED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("defaults", () => {
  test("realtime defaults OFF — it is an accelerator, never a source of truth", () => {
    expect(flag("realtime")).toBe(false);
  });

  test("console live feed defaults OFF so the SSE fallback is what ships first", () => {
    expect(flag("consoleLiveFeed")).toBe(false);
  });

  test("PII redaction defaults ON — the unsafe direction must never be implicit", () => {
    expect(flag("piiRedaction")).toBe(true);
  });

  test("ElevenLabs live voice defaults OFF so the demo cannot burn quota", () => {
    expect(flag("elevenLabsLive")).toBe(false);
  });
});

describe("env parsing", () => {
  test("reads an explicit true", () => {
    process.env.FEATURE_REALTIME = "true";
    expect(flag("realtime")).toBe(true);
  });

  test("is case-insensitive, matching how operators write env files", () => {
    process.env.FEATURE_REALTIME = "TRUE";
    expect(flag("realtime")).toBe(true);
    process.env.FEATURE_REALTIME = "False";
    expect(flag("realtime")).toBe(false);
  });

  test("trims surrounding whitespace from copy-pasted values", () => {
    process.env.FEATURE_CONSOLE_LIVE_FEED = "  true  ";
    expect(flag("consoleLiveFeed")).toBe(true);
  });

  test("rejects a malformed value instead of reading it as false", () => {
    // The failure this prevents: a deploy sets FEATURE_REALTIME=yes, the app
    // reads it as off, and nobody notices until realtime is mysteriously dead.
    process.env.FEATURE_REALTIME = "yes";
    expect(() => flag("realtime")).toThrow(/must be "true" or "false"/);
  });

  test("rejects an empty value rather than falling back to the default", () => {
    process.env.FEATURE_PII_REDACTION = "";
    expect(() => flag("piiRedaction")).toThrow();
  });

  test("rejects a numeric value", () => {
    process.env.FEATURE_CONSOLE_LIVE_FEED = "1";
    expect(() => flag("consoleLiveFeed")).toThrow();
  });

  test("names the offending var in the error so the fix is obvious", () => {
    process.env.FEATURE_REALTIME = "on";
    expect(() => flag("realtime")).toThrow(/FEATURE_REALTIME/);
  });
});

describe("legacy override", () => {
  test("ELEVENLABS_DRY_RUN still controls the ElevenLabs flag", () => {
    // Existing deploys are tested against this var; the provider client reads
    // it directly, so the flag must not disagree with it.
    process.env.ELEVENLABS_DRY_RUN = "true";
    expect(flag("elevenLabsLive")).toBe(false);
    process.env.ELEVENLABS_DRY_RUN = "false";
    expect(flag("elevenLabsLive")).toBe(true);
  });

  test("the legacy var wins over the new one to avoid reporting a state the app does not obey", () => {
    process.env.ELEVENLABS_DRY_RUN = "true";
    process.env.FEATURE_ELEVEN_LABS_LIVE = "true";
    expect(flag("elevenLabsLive")).toBe(false);
  });

  test("the new var is used when the legacy one is absent", () => {
    process.env.FEATURE_ELEVEN_LABS_LIVE = "true";
    expect(flag("elevenLabsLive")).toBe(true);
  });
});

describe("realtimeConfigured", () => {
  test("is false with the flag off even when a secret exists", () => {
    process.env.REALTIME_INGEST_SECRET = "s3cret";
    expect(realtimeConfigured()).toBe(false);
  });

  test("is false with the flag on and NO secret — on-without-secret is an outage", () => {
    // The realtime service rejects every handshake without a secret, so
    // accepting connections here would look like a network fault, not a
    // missing variable.
    process.env.FEATURE_REALTIME = "true";
    expect(realtimeConfigured()).toBe(false);
  });

  test("is true only with both the flag and a secret", () => {
    process.env.FEATURE_REALTIME = "true";
    process.env.REALTIME_INGEST_SECRET = "s3cret";
    expect(realtimeConfigured()).toBe(true);
  });

  test("treats an empty secret as absent", () => {
    process.env.FEATURE_REALTIME = "true";
    process.env.REALTIME_INGEST_SECRET = "";
    expect(realtimeConfigured()).toBe(false);
  });
});

describe("client exposure", () => {
  test("exposes only client-safe flags", () => {
    expect(Object.keys(clientFlags())).toEqual(["consoleLiveFeed"]);
  });

  test("never leaks the realtime or redaction flags to the browser", () => {
    // A client-visible realtime flag would imply the server has a secret,
    // which is exactly the inference that must not be available.
    process.env.FEATURE_REALTIME = "true";
    process.env.FEATURE_PII_REDACTION = "false";
    const sent = clientFlags();
    expect(sent).not.toHaveProperty("realtime");
    expect(sent).not.toHaveProperty("piiRedaction");
    expect(sent).not.toHaveProperty("elevenLabsLive");
  });
});

describe("registry integrity", () => {
  test("every flag has a default", () => {
    for (const n of FLAG_NAMES) {
      expect(() => flag(n as FlagName)).not.toThrow();
    }
  });

  test("allFlags covers the whole registry with no extras", () => {
    const all = allFlags();
    expect(Object.keys(all).sort()).toEqual([...FLAG_NAMES].sort());
  });

  test("describeFlag reports the env var that actually controlled it", () => {
    expect(describeFlag("realtime").source).toBe("default");
    expect(describeFlag("realtime").envVar).toBe("FEATURE_REALTIME");
    process.env.FEATURE_REALTIME = "true";
    expect(describeFlag("realtime")).toMatchObject({ value: true, source: "env" });
  });

  test("describeFlag names the legacy var when that is what won", () => {
    process.env.ELEVENLABS_DRY_RUN = "true";
    expect(describeFlag("elevenLabsLive").envVar).toBe("ELEVENLABS_DRY_RUN");
  });
});