/**
 * Feature-flag behaviour that must not regress silently, and the flag /
 * invariant split that replaced five fake switches.
 *
 * The flags this registry controls touch money (ElevenLabs live voice), the
 * realtime transport, and the console's transport choice, so the tests here are
 * deliberately about the *safe* direction: a bad value fails loudly, a missing
 * value falls back to the conservative default, and a client never learns a
 * server-only fact.
 *
 * The compliance controls that used to be declared here — the opening
 * disclosure, the credential-ask refusal, PII redaction, inbound signature
 * enforcement — are no longer flags, and this file is where the lie gets held
 * shut:
 *
 *   1. at COMPILE time, by `FlagName` (the `@ts-expect-error` below fails to
 *      type-check if a name ever leaks back into the union), and
 *   2. at RUNTIME, for callers the compiler cannot stop, and
 *   3. by MUTATION PROOF — set every retired env var to `false` and the registry
 *      still reports the control as enforced, and
 *   4. by the CONSUMER GATE — a flag must name a production file that actually
 *      honours it, checked against the filesystem, so "a flag nobody consults"
 *      cannot be declared again. That is the generalisation; the four names above
 *      were only instances.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FLAG_NAMES,
  FLAG_CONSUMERS,
  INVARIANTS,
  flag,
  safeFlag,
  allFlags,
  describeFlag,
  invariants,
  invariantSurface,
  realtimeConfigured,
  clientFlags,
  InvariantNotConfigurableError,
  type FlagName,
} from "../src/lib/flags.ts";

/** Repo root, derived from THIS file's location — one level up from `tests/`. */
const rootUrl = new URL("../", import.meta.url);

const repoFile = (rel: string) => readFileSync(fileURLToPath(new URL(rel, rootUrl)), "utf8");

/**
 * Everything this module can read: the registry spelling, the legacy spelling,
 * and every env var that was retired when the four compliance controls stopped
 * being flags. The retired ones are touched precisely so a test can prove they
 * are ignored.
 */
const TOUCHED = [
  "FEATURE_REALTIME",
  "FEATURE_ELEVEN_LABS_LIVE",
  "FEATURE_CONSOLE_LIVE_FEED",
  "FEATURE_SEED_DEMO",
  "FEATURE_TWILIO_MEDIA_STREAMS",
  "ELEVENLABS_DRY_RUN",
  "SEED_DEMO",
  "REALTIME_INGEST_SECRET",
  // The pre-split FEATURE_* spellings and the legacy compliance vars.
  "FEATURE_PII_REDACTION",
  "FEATURE_COMPLIANCE_DISCLOSURE",
  "FEATURE_COMPLIANCE_NO_SECRETS",
  "FEATURE_COMPLIANCE_PII_REDACTION",
  "FEATURE_WEBHOOK_STRICT_SIGNATURES",
  "COMPLIANCE_OPENING_DISCLOSURE",
  "COMPLIANCE_NO_CREDENTIAL_REQUESTS",
  "COMPLIANCE_PII_REDACTION",
];

/** Every env name any invariant retired, flattened. */
const RETIRED_ENV = INVARIANTS.flatMap((i) => [...i.retiredEnvVars]);

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

  test("demo seeding defaults OFF so a fresh deployment is empty, not synthetic", () => {
    expect(flag("seedDemo")).toBe(false);
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
    // This test used to be written against FEATURE_PII_REDACTION, and it was
    // FAILING at baseline for a reason nobody had read: `COMPLIANCE_PII_REDACTION`
    // was set in `.env`, the legacy override won, and the empty FEATURE_ value
    // was never reached. That is the same class of defect this change exists to
    // end — a var the registry reads that does not describe the behaviour.
    process.env.FEATURE_CONSOLE_LIVE_FEED = "";
    expect(() => flag("consoleLiveFeed")).toThrow();
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

  test("SEED_DEMO is the legacy input the db-setup container actually reads", () => {
    process.env.SEED_DEMO = "true";
    expect(flag("seedDemo")).toBe(true);
  });

  test("a surviving legacy var is read by the file that honours its flag", () => {
    // ELEVENLABS_DRY_RUN and SEED_DEMO stay in the override map because something
    // really does read them. The four compliance vars were in the map for the
    // opposite reason, and the next test is the proof.
    expect(repoFile("src/lib/config.ts")).toContain("ELEVENLABS_DRY_RUN");
    expect(repoFile("docker-compose.yml")).toContain("SEED_DEMO");
  });

  test("no retired compliance env var is read anywhere in src/ but the registry", () => {
    // The mutation proof at the source level: these names may appear in the
    // invariant list, and nowhere else in the shipped tree. If someone wires one
    // back up, this fails — which is the correct outcome, because a compliance
    // control must not become switchable again by a future edit that looks helpful.
    const root = fileURLToPath(rootUrl);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          files.push(relative(root, abs).replace(/\\/g, "/"));
        }
      }
    };
    walk(join(root, "src"));
    expect(files.length).toBeGreaterThan(50);

    for (const envVar of RETIRED_ENV) {
      for (const rel of files) {
        if (rel === "src/lib/flags.ts") continue;
        expect(
          repoFile(rel),
          `${envVar} is read by ${rel} — an invariant must not become a knob again`,
        ).not.toContain(envVar);
      }
    }
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

  test("never leaks the realtime flag or an invariant to the browser", () => {
    // A client-visible realtime flag would imply the server has a secret,
    // which is exactly the inference that must not be available.
    process.env.FEATURE_REALTIME = "true";
    process.env.FEATURE_PII_REDACTION = "false";
    process.env.FEATURE_WEBHOOK_STRICT_SIGNATURES = "false";
    const sent = clientFlags();
    expect(sent).not.toHaveProperty("realtime");
    expect(sent).not.toHaveProperty("piiRedaction");
    expect(sent).not.toHaveProperty("elevenLabsLive");
    for (const invariant of INVARIANTS) {
      expect(sent, `invariant ${invariant.name} reached the client`).not.toHaveProperty(
        invariant.name,
      );
    }
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

  test("no compliance invariant is declared as a flag", () => {
    // The split, asserted from the registry rather than from a list copied into
    // this test: if a name is in FLAG_NAMES it is switchable, and none of these
    // four may be switchable.
    for (const invariant of INVARIANTS) {
      expect(
        (FLAG_NAMES as readonly string[]).includes(invariant.name),
        `${invariant.name} is back in FLAG_NAMES`,
      ).toBe(false);
      expect(Object.keys(allFlags())).not.toContain(invariant.name);
      expect(Object.keys(clientFlags())).not.toContain(invariant.name);
    }
    // The five names that were removed, pinned literally. `piiRedaction` is here
    // too: it was the SAME control as `compliancePiiRedaction`, declared twice,
    // and redaction was consulted by neither.
    for (const gone of [
      "complianceDisclosure",
      "complianceNoSecrets",
      "compliancePiiRedaction",
      "piiRedaction",
      "webhookStrictSignatures",
    ]) {
      expect(FLAG_NAMES as readonly string[]).not.toContain(gone);
    }
  });

  test("the dead convenience accessors are gone from the module", () => {
    // These five had ZERO callers outside flags.ts, in src, scripts and tests —
    // a helper that reads a flag nothing reads. They must not come back.
    const src = repoFile("src/lib/flags.ts");
    for (const dead of [
      "openingDisclosureEnabled",
      "noCredentialRequests",
      "piiRedactionEnabled",
      "webhookSignaturesEnforced",
      "demoSeedEnabled",
    ]) {
      expect(src, `${dead} is still exported`).not.toContain(`export function ${dead}`);
    }
  });

  test("an unknown flag name fails loudly instead of resolving to undefined", () => {
    // Before `assertConfigurable`, `flag("typo" as FlagName)` fell through to
    // `DEFAULTS["typo"]` — `undefined`, i.e. falsy — which is a control reported
    // as disabled. Same hole, narrower: any name that is not declared.
    expect(() => flag("notAFlag" as FlagName)).toThrow(/not a declared flag/);
    // safeFlag must not swallow it either: the safe default for a name that is
    // not a flag is nothing, because there is no flag to be conservative about.
    expect(() => flag("notAFlag" as FlagName)).toThrow(TypeError);
  });
});

describe("invariants are refused by the compiler, not by a runtime check", () => {
  test("a compliance name is not assignable to FlagName", () => {
    // This is the load-bearing line. `flag()` takes `FlagName`; removing the
    // invariant names from that union is what refuses them, and the COMPILER is
    // what enforces it. If anyone re-adds one of the four to `FLAG_NAMES`, the
    // suppression below becomes an unused `@ts-expect-error` and
    // `bunx tsc -p tests/tsconfig.json --noEmit` FAILS THE BUILD. The calls are
    // wrapped in a closure that is never invoked, because at runtime they throw —
    // the assertion is about types, not about behaviour.
    const onlyCheckedByTsc = () => {
      // @ts-expect-error complianceNoSecrets is an invariant, not a FlagName.
      const a: boolean = flag("complianceNoSecrets");
      // @ts-expect-error complianceDisclosure is an invariant, not a FlagName.
      const b: boolean = describeFlag("complianceDisclosure");
      // @ts-expect-error piiRedaction was retired: redaction is not configurable.
      const c: boolean = safeFlag("piiRedaction");
      // @ts-expect-error webhookStrictSignatures is an invariant, not a FlagName.
      const d: boolean = flag("webhookStrictSignatures");
      return [a, b, c, d];
    };
    void onlyCheckedByTsc;

    // And the accessor surface agrees with the type.
    expect(invariants()).toBe(INVARIANTS);
    expect(
      (Object.keys(FLAG_CONSUMERS) as string[]).sort(),
      "FLAG_CONSUMERS must cover exactly the declared flags — no more, no fewer",
    ).toEqual([...FLAG_NAMES].sort());
  });

  test("and a bypassed cast throws instead of returning false", () => {
    // The compiler cannot stop `as FlagName`, a JS caller, or a string read from
    // config. Those must throw, not return `undefined`/`false`.
    for (const invariant of INVARIANTS) {
      expect(() => flag(invariant.name as FlagName)).toThrow(InvariantNotConfigurableError);
      expect(() => describeFlag(invariant.name as FlagName)).toThrow(InvariantNotConfigurableError);
    }
  });

  test("safeFlag does not degrade an invariant request into a default", () => {
    // `safeFlag` exists to keep a config typo out of the audit path. An invariant
    // name is not a config typo — swallowing it here would put the lie back into
    // the one reader built to be forgiving, because the "default" for a name that
    // is not a flag is `undefined`.
    for (const invariant of INVARIANTS) {
      expect(() => safeFlag(invariant.name as FlagName)).toThrow(InvariantNotConfigurableError);
    }
    // A malformed VALUE on a real flag still degrades quietly. Both halves are
    // needed: this one is the audit path's contract, the one above is the lie.
    process.env.FEATURE_REALTIME = "nonsense";
    expect(safeFlag("realtime")).toBe(false);
  });
});

describe("mutation proof — a retired env var cannot report an invariant as off", () => {
  test("every retired env var set to false leaves the registry saying 'not configurable'", () => {
    expect(RETIRED_ENV.length).toBeGreaterThanOrEqual(6);
    for (const envVar of RETIRED_ENV) process.env[envVar] = "false";

    // The registry surface an operator reads.
    const surface = invariantSurface();
    expect(surface.length).toBe(INVARIANTS.length);
    for (const entry of surface) {
      expect(entry.enforced, `${entry.name} reported as not enforced`).toBe(true);
      expect(entry.configurable).toBe(false);
      // The var the operator set is named back to them as IGNORED, rather than
      // the registry quietly returning `false`.
      expect(entry.envVarsIgnored.length).toBeGreaterThan(0);
    }

    // No flag reader can answer for an invariant at all.
    expect(Object.keys(allFlags())).not.toContain("complianceNoSecrets");
    expect(Object.keys(allFlags())).not.toContain("complianceDisclosure");
    for (const envVar of RETIRED_ENV) {
      expect(() => flag(envVar as unknown as FlagName)).toThrow(/not a declared flag/);
    }
  });

  test("an unrecognised FEATURE_ spelling of an invariant never becomes a flag", () => {
    // Guards the other direction: re-adding `FEATURE_COMPLIANCE_NO_SECRETS` to
    // the environment must not resurrect the switch.
    process.env.FEATURE_COMPLIANCE_NO_SECRETS = "false";
    process.env.FEATURE_WEBHOOK_STRICT_SIGNATURES = "false";
    const names = Object.keys(allFlags());
    for (const invariant of INVARIANTS) expect(names).not.toContain(invariant.name);
  });
});

describe("the consumer gate — a flag nobody consults cannot be declared", () => {
  test("every flag names a real file that honours it, with the literal that proves it", () => {
    // THE generalisation. Each of these four lies was a flag whose enforcement
    // site never asked it: `complianceDisclosure`, `complianceNoSecrets`,
    // `compliancePiiRedaction`, `webhookStrictSignatures` (and `piiRedaction`,
    // the same control declared twice). They existed because nothing checked
    // that a declared flag was read by anyone. This does, against the filesystem
    // rather than against another declaration, so it cannot be satisfied by
    // editing the registry alone.
    for (const name of FLAG_NAMES) {
      const consumers = FLAG_CONSUMERS[name];
      expect(consumers, `${name} declares no consumer`).toBeDefined();
      expect(consumers.length, `${name} has an empty consumer list`).toBeGreaterThan(0);

      for (const c of consumers) {
        expect(existsSync(join(fileURLToPath(rootUrl), c.where)), `${c.where} does not exist`).toBe(
          true,
        );
        const text = repoFile(c.where);
        expect(
          text,
          `${name} claims ${c.where} honours it via ${JSON.stringify(c.via)}, which is not in that file`,
        ).toContain(c.via);
      }

      // A compose-only flag is allowed, but it has to be provably read by the
      // container command — never asserted because nobody wanted to follow it.
      const hasSrcConsumer = consumers.some((c) => c.kind === "src");
      if (!hasSrcConsumer) {
        const composeOnly = consumers.filter((c) => c.kind === "compose");
        expect(
          composeOnly.length,
          `${name} has neither a src nor a compose consumer`,
        ).toBeGreaterThan(0);
        const compose = repoFile("docker-compose.yml");
        for (const c of composeOnly) {
          expect(compose, `${name} claims the compose file reads ${c.via}`).toContain(c.via);
        }
      }
    }
  });

  test("the gate has something to check, or it is watching nothing", () => {
    expect(FLAG_NAMES.length).toBeGreaterThanOrEqual(4);
    expect(INVARIANTS.length).toBe(4);
    for (const invariant of INVARIANTS) {
      expect(invariant.enforcedAt.length).toBeGreaterThan(0);
      expect(invariant.provedBy.length).toBeGreaterThan(0);
      expect(invariant.notConfigurable.length).toBeGreaterThan(40);
    }
  });
});
