/**
 * The CSRF origin allowlist, and the boot rules around it.
 *
 * The failure this file exists for is not subtle: a deployment whose
 * `BETTER_AUTH_URL` is still the `http://localhost:3000` that `docker-compose.yml`
 * and the `Dockerfile` both default to answers every public sign-in with
 * "Invalid origin". It builds, it boots, its health check is green, and its login
 * buttons do nothing. So the tests below are less about the parsing and more about
 * the three ways an allowlist goes wrong while looking correct:
 *
 *   · a loopback base URL surviving into a production boot;
 *   · a wildcard or a path being accepted as if it were an origin;
 *   · a string that LOOKS like a trusted host being trusted (`prefix.evil.com`).
 *
 * `src/lib/auth/origins.ts` is pure and takes its inputs as arguments, so none of
 * this needs a database, a server, or a mutated `process.env`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildTrustedOrigins,
  formatOrigin,
  isTrustedOrigin,
  parseOrigin,
  siblingOrigin,
  splitOriginList,
} from "@/lib/auth/origins";

describe("parseOrigin", () => {
  test("accepts scheme, host and optional port", () => {
    expect(parseOrigin("https://securevoiceai.me")).toEqual({
      scheme: "https",
      host: "securevoiceai.me",
      port: "",
    });
    expect(parseOrigin("http://localhost:3000")?.port).toBe(":3000");
    // Case and a trailing slash are formatting, not identity.
    expect(parseOrigin("HTTPS://SecureVoiceAI.me/")).toEqual(
      parseOrigin("https://securevoiceai.me"),
    );
  });

  test("refuses anything that cannot match a browser's Origin header", () => {
    for (const bad of [
      "",
      "   ",
      "securevoiceai.me", // no scheme
      "ftp://securevoiceai.me", // wrong scheme
      "https://securevoiceai.me/sign-in", // a path is not an origin
      "https://securevoiceai.me?", // a query is not an origin
      "https://securevoiceai.me#x", // a fragment is not an origin
      "https://user:pass@securevoiceai.me", // credentials in an origin
      "https://*", // wildcard
      "https://*.securevoiceai.me", // wildcard, dressed up
      "https://a b", // whitespace
      "javascript:alert(1)",
    ]) {
      expect(parseOrigin(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("siblingOrigin", () => {
  test("pairs apex and www, and invents nothing", () => {
    expect(siblingOrigin("https://securevoiceai.me")).toBe("https://www.securevoiceai.me");
    expect(siblingOrigin("https://www.securevoiceai.me")).toBe("https://securevoiceai.me");
    // A host with no dot has no sibling: there is no `www.localhost`.
    expect(siblingOrigin("http://localhost:3000")).toBeNull();
  });
});

describe("splitOriginList", () => {
  test("accepts the separators an env file actually contains", () => {
    expect(splitOriginList("https://a.me,https://b.me")).toEqual(["https://a.me", "https://b.me"]);
    expect(splitOriginList("https://a.me; https://b.me")).toEqual(["https://a.me", "https://b.me"]);
    expect(splitOriginList("https://a.me\nhttps://b.me")).toEqual(["https://a.me", "https://b.me"]);
    expect(splitOriginList(undefined)).toEqual([]);
    expect(splitOriginList("  ,, ")).toEqual([]);
  });
});

describe("buildTrustedOrigins", () => {
  test("a missing or unusable base URL is a boot failure that names the variable", () => {
    for (const baseURL of [undefined, "", "securevoiceai.me", "https://securevoiceai.me/app"]) {
      let message = "";
      try {
        buildTrustedOrigins({ baseURL, extra: undefined, production: false });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message, String(baseURL)).toContain("BETTER_AUTH_URL");
    }
  });

  test("a loopback base URL under NODE_ENV=production refuses to boot", () => {
    // This is the deployment bug that produces "Invalid origin" for every real
    // user while the laptop keeps working.
    let message = "";
    try {
      buildTrustedOrigins({
        baseURL: "http://localhost:3000",
        extra: undefined,
        production: true,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("NODE_ENV=production");
    expect(message).toContain("Invalid origin");
    expect(message).toContain("BETTER_AUTH_URL");
  });

  test("the same loopback base URL is fine in development", () => {
    const cfg = buildTrustedOrigins({
      baseURL: "http://localhost:3000",
      extra: undefined,
      production: false,
    });
    expect(cfg.origins).toEqual(["http://localhost:3000"]);
    expect(cfg.rejected).toEqual([]);
  });

  // ── build phase ───────────────────────────────────────────────────────────
  //
  // `trustedOriginsFromEnv` decides `production` as `NODE_ENV=production &&
  // !inProductionBuild()`. These two tests pin BOTH halves of that, because the
  // exemption is only safe while the other half still holds: the hazard the
  // refusal guards is a SERVING process answering sign-ins, and `next start`
  // never sets NEXT_PHASE, so a server cannot reach the exemption.
  //
  // Driven through the real process.env rather than by passing `production`
  // directly, because the thing under test IS the combination of the two env
  // values — a test that called `buildTrustedOrigins({production:false})` would
  // pass even if `inProductionBuild()` were deleted.
  describe("NEXT_PHASE=phase-production-build", () => {
    const PHASE = process.env.NEXT_PHASE;
    const NODE_ENV = process.env.NODE_ENV;
    // `NODE_ENV` is declared readonly (next/types/global.d.ts), so the writes below
    // go through this alias. It is the same object and the same runtime operations;
    // only the typing of the mutation site changes.
    const env = process.env as Record<string, string | undefined>;

    afterEach(() => {
      if (PHASE === undefined) delete env.NEXT_PHASE;
      else env.NEXT_PHASE = PHASE;
      if (NODE_ENV === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = NODE_ENV;
    });

    /**
     * A fresh module, so the memoised cache does not answer for us.
     *
     * A monotonic counter, NOT `Date.now()`: two of these calls can land inside the
     * same millisecond, which gives the SAME specifier, which gives the SAME cached
     * module — and the test then asserts against the previous case's captured
     * `process.env`. That is exactly how this file passed on a laptop and failed in
     * CI: the flake was clock resolution, and the failure message was the tell
     * ("a production BOOT on a loopback origin still refuses" reporting the
     * earlier case's `https://localhost:61015`). The code under test was never
     * wrong; the probe was.
     */
    let reloads = 0;
    const reload = () => import(`@/lib/auth/origins?t=${++reloads}`);

    test("a production BOOT on a loopback origin still refuses", async () => {
      env.NODE_ENV = "production";
      delete env.NEXT_PHASE;
      env.BETTER_AUTH_URL = "http://localhost:3000";
      const mod = await reload();
      expect(() => mod.trustedOriginsFromEnv()).toThrow(/loopback/i);
    });

    test("a production BUILD on the same loopback origin is allowed", async () => {
      env.NODE_ENV = "production";
      env.NEXT_PHASE = "phase-production-build";
      env.BETTER_AUTH_URL = "https://localhost:61015";
      const mod = await reload();
      // The CI smoke test allocates a random loopback port and builds against
      // it; this is that case, and it used to kill every run at
      // "Failed to collect page data for /_not-found".
      const cfg = mod.trustedOriginsFromEnv();
      expect(cfg.origins).toContain("https://localhost:61015");
    });

    test("an UNRELATED phase value grants nothing", async () => {
      env.NODE_ENV = "production";
      env.NEXT_PHASE = "phase-development-server";
      env.BETTER_AUTH_URL = "http://localhost:3000";
      const mod = await reload();
      expect(() => mod.trustedOriginsFromEnv()).toThrow(/loopback/i);
    });
  });

  test("the public origin brings its www sibling", () => {
    const cfg = buildTrustedOrigins({
      baseURL: "https://securevoiceai.me",
      extra: undefined,
      production: true,
    });
    expect(cfg.baseURL).toBe("https://securevoiceai.me");
    expect(cfg.origins).toContain("https://securevoiceai.me");
    expect(cfg.origins).toContain("https://www.securevoiceai.me");
  });

  test("extra entries are added, and an unusable one is reported rather than trusted", () => {
    const cfg = buildTrustedOrigins({
      baseURL: "https://securevoiceai.me",
      extra: "https://crucible.svalley.tech, https://console.securevoiceai.me/, nonsense",
      production: true,
    });
    expect(cfg.origins).toContain("https://crucible.svalley.tech");
    expect(cfg.origins).toContain("https://console.securevoiceai.me");
    expect(cfg.rejected).toEqual(["nonsense"]);
    // A dropped entry never becomes a wildcard, an empty string, or a trust.
    expect(cfg.origins).not.toContain("nonsense");
    expect(cfg.origins.every((o) => parseOrigin(o) !== null)).toBe(true);
  });

  test("a trailing slash on the base URL does not fork the allowlist", () => {
    const withSlash = buildTrustedOrigins({
      baseURL: "https://securevoiceai.me/",
      extra: undefined,
      production: true,
    });
    expect(withSlash.baseURL).toBe("https://securevoiceai.me");
    expect(withSlash.origins).toEqual(
      buildTrustedOrigins({
        baseURL: "https://securevoiceai.me",
        extra: undefined,
        production: true,
      }).origins,
    );
  });
});

describe("isTrustedOrigin", () => {
  const allowlist = buildTrustedOrigins({
    baseURL: "https://securevoiceai.me",
    extra: "https://crucible.svalley.tech:8443",
    production: true,
  }).origins;

  test("matches the way a browser sends it", () => {
    expect(isTrustedOrigin("https://securevoiceai.me", allowlist)).toBe(true);
    expect(isTrustedOrigin("https://www.securevoiceai.me", allowlist)).toBe(true);
    expect(isTrustedOrigin("https://crucible.svalley.tech:8443", allowlist)).toBe(true);
    // Formatting only.
    expect(isTrustedOrigin("HTTPS://SecureVoiceAI.me", allowlist)).toBe(true);
  });

  test("refuses the shapes that look like a match and are not", () => {
    for (const hostile of [
      // Prefix confusion: a subdomain of the attacker's own domain.
      "https://securevoiceai.me.evil.com",
      "https://evil-securevoiceai.me",
      // Same host, different port — the allowlist entry carried none.
      "https://securevoiceai.me:8443",
      // Downgrade.
      "http://securevoiceai.me",
      // A path is not an origin, and must not be treated as one.
      "https://securevoiceai.me/sign-in",
      // Absent.
      "",
      "null",
    ]) {
      expect(isTrustedOrigin(hostile, allowlist), hostile).toBe(false);
    }
    expect(isTrustedOrigin(null, allowlist)).toBe(false);
    expect(isTrustedOrigin(undefined, allowlist)).toBe(false);
  });

  test("a port-bearing entry does not match the bare host", () => {
    // `:8443` in the list means that port, not "any port on that host" — the
    // difference is what an origin-scoped cookie or a CSRF check depends on.
    expect(isTrustedOrigin("https://crucible.svalley.tech", allowlist)).toBe(false);
  });
});

describe("formatOrigin", () => {
  test("round-trips a parsed origin", () => {
    const parsed = parseOrigin("https://example.com:8443");
    expect(parsed && formatOrigin(parsed)).toBe("https://example.com:8443");
  });
});
