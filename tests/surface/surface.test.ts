/**
 * Public surface gate (WP-24).
 *
 * The claim being defended: **no authenticated route is reachable by a search
 * engine, and no declared security header is missing from a served response.**
 *
 * Both halves are checked against the real code path wherever that is possible
 * without a network or a database, because a test that only greps a config
 * file proves the config file is well-formed, not that the app emits the
 * header. So:
 *
 *   - `X-Robots-Tag` and `Permissions-Policy` are verified by INVOKING the real
 *     exported proxy (`src/proxy.ts`, the Next 16 middleware) with real
 *     `NextRequest` objects and reading the response headers back. That is a
 *     genuine end-to-end assertion through the same function Next runs.
 *   - The headers that live in `next.config.ts` (CSP, HSTS, nosniff,
 *     Referrer-Policy, X-Frame-Options, COOP, CORP) CANNOT be observed this way:
 *     `headers()` is applied by the framework's routing layer, downstream of
 *     the proxy, and NextResponse objects returned from the proxy do not carry
 *     it. Those are verified by parsing the config, and the test says so
 *     explicitly rather than implying they were observed.
 *   - An optional live check runs when SURFACE_BASE_URL is set, which fetches
 *     real HTTP headers off a running deployment. This is the only way to
 *     observe the next.config.ts half for real; without the env var it is
 *     skipped and reported as skipped, never as passed.
 *
 * The negatives are asserted as loudly as the positives. A gate that only
 * checks what should be present passes just as happily when the thing it was
 * protecting is published, so every "must not appear" case gets its own
 * assertion of ABSENCE.
 *
 *   bun test tests/surface
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NextResponse } from "next/server";
import { NextRequest } from "next/server";

import proxy, {
  INDEXABLE_PATHS,
  MICROPHONE_ALLOWLIST,
  applySurfaceHeaders,
  permissionsPolicyFor,
  robotsTagFor,
} from "../../src/proxy.ts";
import robots, {
  NO_INDEX as ROBOTS_FORBIDDEN,
  siteOrigin as robotsOrigin,
} from "../../src/app/robots.ts";
import sitemap, {
  INDEXABLE_PATHS as SITEMAP_PATHS,
  MUST_NOT_LIST as SITEMAP_FORBIDDEN,
  siteOrigin as sitemapOrigin,
} from "../../src/app/sitemap.ts";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const nextConfig = read("next.config.ts");
const manifest = JSON.parse(read("public/site.webmanifest")) as Record<string, unknown>;

/**
 * Run the real middleware and read a response header back.
 *
 * The middleware runs fine with no session: it resolves to "signed out" and passes
 * the request through, which is exactly the state an unauthenticated crawler is in.
 * So this exercises the production function, not a reimplementation of it.
 */
async function headersFor(pathname: string): Promise<Headers> {
  const res = await proxy(new NextRequest(`https://surface.test${pathname}`));
  // The middleware may decline a request (null/undefined), which is a legitimate
  // outcome, so it must be asserted rather than dereferenced.
  expect(res).toBeDefined();
  expect(res).not.toBeNull();
  if (res === null || res === undefined)
    throw new Error(`the middleware declined to handle ${pathname}`);
  expect(res.status).toBe(200);
  return res.headers;
}

/** Paths a crawler must never be pointed at, covering each distinct reason. */
const NO_INDEX_PATHS = [
  "/api/status", // operator-only: heap, DB latency, telephony mode
  "/api/console/events", // the Command Center live feed + audit chain
  "/api/metrics", // dependency + queue telemetry
  "/v1/interventions", // the /v1 alias, rewritten to /api/v1/interventions
  "/inspector", // webhook signature debug tool
  "/api/auth/get-session", // Better Auth session endpoint
  "/totally/unknown/route", // fail-closed default for anything added later
];

describe("indexing: authenticated and API routes are never indexable", () => {
  test.each(NO_INDEX_PATHS)("%s carries X-Robots-Tag: noindex, nofollow", async (path) => {
    const headers = await headersFor(path);
    expect(headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  test("the marketing root does NOT carry a robots header at all", async () => {
    // Negative, and deliberately so: emitting `index, follow` on the one page we
    // DO want indexed is noise, and if it ever disagreed with the sitemap the
    // disagreement would be invisible in a diff. Absence is the clean signal.
    const headers = await headersFor("/");
    expect(headers.get("X-Robots-Tag")).toBeNull();
  });

  test("noindex is applied to early rejections too, not just the happy path", () => {
    // A 413/429 that skipped this would leak a robots-invisible error page
    // precisely when something has gone wrong.
    const res = NextResponse.json({ error: "test" }, { status: 429 });
    applySurfaceHeaders(res, "/api/status");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(res.headers.get("Permissions-Policy")).toContain("microphone=()");
  });

  test("the allowlist is an allowlist: unknown paths are noindex by default", () => {
    // Every entry is a real HTTP route backed by a file. Anything not listed —
    // including any route added later without an entry here — is noindex, which
    // is the failure mode this list exists to prevent.
    expect(INDEXABLE_PATHS).toEqual([
      "/",
      "/sitemap.xml",
      "/pricing",
      "/terms",
      "/privacy",
      "/refund",
      "/docs",
      "/security",
      "/usecases",
    ]);
    for (const path of INDEXABLE_PATHS) expect(robotsTagFor(path)).toBeNull();
    expect(robotsTagFor("/anything/new")).toBe("noindex, nofollow");
    expect(robotsTagFor("/api/")).toBe("noindex, nofollow");
  });

  /**
   * Every indexable HTML route is allowlisted AND backed by a real route file.
   *
   * Two halves that have to hold together. A path on the allowlist that 404s is
   * worse than a path left off it: the sitemap advertises it, `X-Robots-Tag`
   * says "index me", and a crawler gets a 404. So each route is checked against
   * the filesystem as well as the allowlist.
   */
  test.each([
    { path: "/pricing", file: "src/app/pricing/page.tsx" },
    { path: "/terms", file: "src/app/terms/page.tsx" },
    { path: "/privacy", file: "src/app/privacy/page.tsx" },
    { path: "/refund", file: "src/app/refund/page.tsx" },
    { path: "/docs", file: "src/app/docs/page.tsx" },
    { path: "/security", file: "src/app/security/page.tsx" },
    { path: "/usecases", file: "src/app/usecases/page.tsx" },
  ])("$path is allowlisted AND backed by a real route", ({ path, file }) => {
    expect(INDEXABLE_PATHS).toContain(path);
    expect(existsSync(file)).toBe(true);
  });

  /**
   * The authenticated views must NEVER acquire a public route.
   *
   * The whole "no /console URL" defence rests on there being no path to
   * de-index. `VIEW_ACCESS` is what these routes would have to satisfy, so it is
   * asserted here rather than left to a comment: if someone routes `/console` or
   * `/dashboard` later and forget this list, the second layer of the Command
   * Center's protection is gone and nothing else fails.
   */
  test("no authenticated view is indexable", () => {
    // Parsed out of the store rather than hardcoded, so a new non-public view
    // is covered the day it is added.
    const store = read("src/lib/store.ts");
    const publicViews = [...store.matchAll(/^\s{2}(\w+):\s*"public",/gm)].map((m) => m[1]!);
    const guarded = ["demo", "dashboard", "product", "deck", "console", "settings", "setup"];
    expect(guarded.length).toBeGreaterThan(0);

    for (const view of guarded) {
      expect(publicViews, `${view} must not be a public view`).not.toContain(view);
      expect(INDEXABLE_PATHS, `${view} must not have an indexable route`).not.toContain(`/${view}`);
      expect(SITEMAP_PATHS).not.toContain(`/${view}`);
    }
    // Sanity: the regex actually found the map, so the assertions above are not
    // passing vacuously against an empty list.
    expect(publicViews).toEqual(
      expect.arrayContaining(["home", "docs", "security", "pricing", "usecases"]),
    );
  });

  test("/sitemap.xml is not noindex ÃƒÂ¢Ã¢šÂ¬Ã¢â‚¬Â it is the public SEO surface", () => {
    // Measured, not assumed: the proxy matcher DOES run for /sitemap.xml, so
    // before it was allowlisted the generated sitemap was served with
    // `X-Robots-Tag: noindex, nofollow` on a live server.
    expect(robotsTagFor("/sitemap.xml")).toBeNull();
  });
});

describe("robots.txt", () => {
  /** `rules` is typed as one rule OR a list; this route returns a list. The element
   *  type is taken from the route's own return value, since `MetadataRoute` is a
   *  Next global that this Bun test project does not pull in. */
  type RobotsRule = Extract<ReturnType<typeof robots>["rules"], unknown[]>[number];

  /** Every rule, always as a list, so callers never branch on the union. */
  const allRules = () => robots().rules as RobotsRule[];

  /** The `User-agent: *` rule. */
  const allCrawlers = () =>
    allRules().find((rule) => {
      const ua = Array.isArray(rule.userAgent) ? rule.userAgent : [rule.userAgent];
      return ua.includes("*");
    });

  test("allows the marketing root", () => {
    expect(allCrawlers()?.allow).toBe("/");
  });

  test.each([...ROBOTS_FORBIDDEN])("disallows %s for every crawler", (prefix) => {
    const disallow = allCrawlers()?.disallow;
    const list = Array.isArray(disallow) ? disallow : [disallow];
    expect(list).toContain(prefix);
  });

  test("never lists a console or API path in an ALLOW position", () => {
    // Negative assertion: an accidentally broad `allow` would still look right
    // in review. Assert the absence of any allow entry naming these.
    const allows = allRules()
      .flatMap((r) => (Array.isArray(r.allow) ? r.allow : [r.allow]))
      .filter(Boolean);
    for (const allow of allows) {
      for (const forbidden of SITEMAP_FORBIDDEN) {
        expect(allow).not.toBe(forbidden);
      }
    }
  });

  /**
   * AI crawlers are split by PURPOSE, not lumped together.
   *
   * The previous single rule denied GPTBot, ClaudeBot, PerplexityBot and
   * Google-Extended everything, on the theory that the audit chain should not end
   * up in a training corpus. That rule never protected the audit chain — `/api/`
   * was already disallowed for every crawler in the rule above — and it did block
   * the search indexes this site's pricing, FAQ and JSON-LD exist to be found by.
   * See the long comment on SEARCH_CRAWLERS in src/app/robots.ts.
   */
  test("training-only crawlers are denied everything", () => {
    const rule = allRules().find((x) =>
      (Array.isArray(x.userAgent) ? x.userAgent : [x.userAgent]).includes("GPTBot"),
    );
    expect(rule?.disallow).toBe("/");
    // No `allow` key: the absence of an allow rule is what makes this a deny-all.
    expect(rule?.allow).toBeUndefined();
    const agents = Array.isArray(rule?.userAgent) ? rule?.userAgent : [];
    expect(agents).toEqual(expect.arrayContaining(["GPTBot", "Google-Extended"]));
  });

  test("search/answer indexers are allowed, but still cannot reach /api", () => {
    const rule = allRules().find((x) =>
      (Array.isArray(x.userAgent) ? x.userAgent : [x.userAgent]).includes("OAI-SearchBot"),
    );
    expect(rule?.allow).toBe("/");
    // The protection the blanket deny used to imply is now explicit: the path
    // disallows apply to these agents exactly as they do to everyone else.
    const disallow = Array.isArray(rule?.disallow) ? rule.disallow : [rule?.disallow];
    expect(disallow).toEqual(expect.arrayContaining(["/api/", "/v1/", "/inspector"]));
    const agents = Array.isArray(rule?.userAgent) ? rule?.userAgent : [];
    expect(agents).toEqual(
      expect.arrayContaining(["OAI-SearchBot", "ChatGPT-User", "PerplexityBot"]),
    );
  });

  test("advertises the sitemap with an absolute URL", () => {
    expect(robots().sitemap).toBe(`${robotsOrigin()}/sitemap.xml`);
    expect(robots().sitemap).toMatch(/^https?:\/\//);
  });
});

describe("sitemap", () => {
  const entries = sitemap();

  test("declares exactly the paths the proxy allows to be indexed", () => {
    // Note /sitemap.xml is indexable but is NOT a sitemap entry ÃƒÂ¢Ã¢šÂ¬Ã¢â‚¬Â a sitemap
    // listing itself is noise. So the two lists are related, not identical.
    const paths = entries.map((e) => new URL(e.url).pathname).sort();
    for (const path of paths) {
      expect(INDEXABLE_PATHS).toContain(path);
    }
  });

  test("every public route is listed exactly once, and `/` is first", () => {
    // Eight entries: the single-page app plus the seven standalone documents.
    // The count is asserted rather than derived so that ADDING a route to the
    // list without thinking about the sitemap fails here instead of shipping.
    expect(entries).toHaveLength(8);
    const paths = entries.map((e) => new URL(e.url).pathname);
    expect(paths).toEqual([
      "/",
      "/pricing",
      "/terms",
      "/privacy",
      "/refund",
      "/docs",
      "/security",
      "/usecases",
    ]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("every entry is an absolute URL that parses", () => {
    for (const entry of entries) {
      expect(entry.url).toMatch(/^https?:\/\//);
      expect(() => new URL(entry.url)).not.toThrow();
    }
  });

  test.each([...SITEMAP_FORBIDDEN])("does NOT list %s", (forbidden) => {
    // The negative the brief asks for: prove absence, do not infer it.
    for (const entry of entries) {
      const path = new URL(entry.url).pathname;
      expect(path === forbidden || path.startsWith(`${forbidden}/`)).toBe(false);
    }
  });

  test("does not point at the API surface", () => {
    for (const entry of entries) {
      expect(new URL(entry.url).pathname.startsWith("/api")).toBe(false);
    }
  });

  test("lastModified is pinned to build time, not Date.now()", () => {
    // A metadata route is cached by default, so `new Date()` would be frozen at
    // first evaluation while LOOKING dynamic. Pinning it is the honest form.
    for (const entry of entries) {
      expect(entry.lastModified).toBeInstanceOf(Date);
    }
    expect(read("src/app/sitemap.ts")).toContain("BUILD_TIME");
  });

  test("declared sitemap paths are a subset of the proxy's indexable list", () => {
    for (const path of SITEMAP_PATHS) {
      expect(INDEXABLE_PATHS).toContain(path);
    }
  });
});

describe("Permissions-Policy", () => {
  test("denies camera, geolocation and payment on every path", () => {
    for (const path of ["/", "/api/status", "/inspector", "/v1/interventions"]) {
      const policy = permissionsPolicyFor(path);
      expect(policy).toContain("camera=()");
      expect(policy).toContain("geolocation=()");
      expect(policy).toContain("payment=()");
    }
  });

  test.each(["/api/status", "/v1/interventions", "/inspector"])(
    "%s denies the microphone",
    (path) => {
      expect(permissionsPolicyFor(path)).toContain("microphone=()");
    },
  );

  test("/ allows the microphone ÃƒÂ¢Ã¢šÂ¬Ã¢â‚¬Â because that is where the demo view lives", () => {
    // Honest counterweight to the test above. `getUserMedia` is called from
    // src/views/Demo.tsx and src/lib/voice-client.ts, both reachable from the
    // `demo` VIEW, which src/app/page.tsx renders at path `/`. Denying the mic
    // on `/` breaks the product. This asserts the current, deliberate state so
    // that the day the demo moves to /widget this test fails and somebody has
    // to make the decision consciously.
    expect(MICROPHONE_ALLOWLIST).toEqual(["/"]);
    expect(permissionsPolicyFor("/")).toContain("microphone=(self)");
  });

  test("the served response carries the per-path policy", async () => {
    expect((await headersFor("/api/status")).get("Permissions-Policy")).toContain("microphone=()");
    expect((await headersFor("/")).get("Permissions-Policy")).toContain("microphone=(self)");
  });
});

describe("declared security headers", () => {
  /**
   * Header sources, honestly labelled.
   *
   * `proxy` = set by src/proxy.ts, so the checks below OBSERVED it on a real
   * response. `next.config` = set by `headers()` in next.config.ts, which the
   * framework applies downstream of the proxy; these are asserted against the
   * config source only and have NOT been observed on a response in this run
   * unless SURFACE_BASE_URL was set.
   */
  const REQUIRED = [
    {
      header: "X-Robots-Tag",
      source: "proxy" as const,
      pattern: /noindex/,
    },
    {
      header: "Permissions-Policy",
      source: "proxy" as const,
      pattern: /camera=\(\)/,
    },
    {
      header: "Content-Security-Policy",
      source: "next.config" as const,
      pattern: /frame-ancestors 'none'/,
    },
    {
      header: "Strict-Transport-Security",
      source: "next.config" as const,
      pattern: /max-age=63072000/,
    },
    {
      header: "X-Content-Type-Options",
      source: "next.config" as const,
      pattern: /nosniff/,
    },
    {
      header: "Referrer-Policy",
      source: "next.config" as const,
      pattern: /strict-origin-when-cross-origin/,
    },
    {
      header: "X-Frame-Options",
      source: "next.config" as const,
      pattern: /DENY/,
    },
    {
      header: "Cross-Origin-Opener-Policy",
      source: "next.config" as const,
      pattern: /same-origin/,
    },
    {
      header: "Cross-Origin-Resource-Policy",
      source: "next.config" as const,
      pattern: /same-origin/,
    },
  ];

  test.each(REQUIRED)("declares $header", ({ header }) => {
    // Presence of the declaration, not of the emitted value ÃƒÂ¢Ã¢šÂ¬Ã¢â‚¬Â see the source
    // label and the SURFACE.md table for what that does and does not prove.
    const source = REQUIRED.find((r) => r.header === header)!.source;
    expect(nextConfig.includes(`"${header}"`) || source === "proxy").toBe(true);
  });

  test.each(REQUIRED.filter((r) => r.source === "proxy"))(
    "$header is present on a live proxy response",
    async ({ header, pattern }) => {
      const headers = await headersFor("/api/status");
      expect(headers.get(header)).toMatch(pattern);
    },
  );

  test("CSP keeps the directives the app genuinely depends on", () => {
    // A CSP that breaks next/font or the websocket is worse than a weak one, so
    // these are pinned: removing any of them breaks the product, and tightening
    // them needs a browser, not a text edit.
    for (const directive of [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'", // framer-motion + Tailwind
      "connect-src", // ElevenLabs
      "font-src",
      "frame-src",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ]) {
      expect(nextConfig).toContain(directive);
    }
  });

  test("the production CSP permits the inline scripts Next actually emits", async () => {
    // Not a style preference — an outage. This build ships Next's RSC flight
    // payload as inline `self.__next_f.push(...)` scripts carrying no nonce and no
    // hash, so a `script-src 'self'` with nothing else blocks them, hydration
    // never happens (React #412) and the app-shell splash sits at 0% forever.
    // Tightening the directive took the live site dark and NO existing assertion
    // could see it: the CSP tests here check which directives exist and that no
    // third-party origin snuck in, which is all still true of a policy that
    // breaks the page. So this asserts the EFFECTIVE policy, by calling the same
    // `headers()` the server uses, rather than grepping the source text.
    //
    // Evaluated as PRODUCTION, explicitly. `headers()` is built from a
    // module-level const computed from `process.env.NODE_ENV` at import time,
    // so importing it under the test runner's env evaluates the WRONG policy:
    // a suite running with NODE_ENV=development would inspect a policy
    // containing the intentional dev-only 'unsafe-eval' and fail for no
    // reason, while a production-only regression (a re-tightened script-src, a
    // production-only 'unsafe-eval') would pass unseen. The import below is
    // cache-busted so the module re-evaluates under production, and the
    // previous env is restored in `finally` so no other test observes it.
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    let config: {
      headers?: () => Promise<{ headers: { key: string; value: string }[] }[]>;
    };
    try {
      config = (await import(`../../next.config?csp-production`)).default;
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
    // `headers` is optional on the typed shape, so `config.headers?.()` can be
    // `undefined` before the `await` — the assertion below is what proves a CSP
    // exists, so coalescing here keeps the type honest without weakening it.
    const entries = ((await config.headers?.()) ?? []).flatMap((r) => r.headers);
    const csp = entries.find((h) => h.key.toLowerCase() === "content-security-policy")?.value;
    expect(csp, "no Content-Security-Policy header is configured").toBeTruthy();
    // Directive-boundary match: `script-srcx 'unsafe-inline'` is not script-src
    // (browsers ignore the unknown directive and block the flight scripts), and
    // a substring regex would accept it.
    const scriptSrc = /(?:^|;)\s*script-src\s+([^;]*)/.exec(csp ?? "")?.[1]?.trim() ?? "";
    expect(scriptSrc, "script-src is missing from the CSP").not.toBe("");
    // 'unsafe-inline' AND nothing else inline-authorizing. A nonce or hash
    // source is not a second way to pass — it is a way to fail: browsers
    // IGNORE 'unsafe-inline' whenever script-src carries a nonce or hash, and
    // this build's flight scripts carry neither, so `script-src 'self'
    // 'nonce-…' 'unsafe-inline'` blocks hydration exactly like `script-src
    // 'self'`. Accepting "any nonce or hash" would pass a policy that breaks
    // the page. The day a real per-request nonce lands on the flight scripts,
    // THIS assertion is what gets rewritten — alongside a browser-proven
    // hydration run, never a text edit alone.
    expect(
      scriptSrc.includes("'unsafe-inline'"),
      `script-src "${scriptSrc}" blocks Next's inline flight scripts — the page will not hydrate`,
    ).toBe(true);
    expect(
      /'nonce-[^']+|'sha256-[^']+|'sha384-[^']+|'sha512-[^']+/.test(scriptSrc),
      `script-src "${scriptSrc}" carries a nonce/hash browsers honor INSTEAD of 'unsafe-inline' — this build's flight scripts carry neither, so hydration breaks`,
    ).toBe(false);
    // Production-only, evaluated as production above: 'unsafe-eval' is a
    // dev-server requirement (React refresh) and must never ship. Asserting it
    // here rather than on the dev policy is what makes the assertion mean
    // "production is clean" instead of "whichever env ran the suite is clean".
    expect(scriptSrc).not.toContain("unsafe-eval");
  });

  test("no script-bearing markup injection path exists in first-party code", () => {
    // script-src 'unsafe-inline' is load-bearing (see above), so the
    // compensating control is at the source: first-party code must not render
    // attacker-reachable markup as HTML. Two allowlisted sites, both reviewed:
    //   ui/chart.tsx — a <style> block of chart colours. Style, not script.
    //   seo/JsonLd.tsx — schema.org JSON-LD. Script-TYPE but never executed;
    //     `JSON.stringify` output with `<` escaped as `<`, so the classic
    //     `</script><script>` payload cannot terminate the element early.
    //
    // SCOPED TO src/, and that is the fix for a real flake. This walk used to
    // read every candidate file unconditionally, and on a loaded runner (CI,
    // with the compile job sharing the disk) it tripped Bun's default 5s
    // per-test budget and reported `[5134ms] (fail)` — a timeout masquerading as
    // an assertion failure. The name filter now runs BEFORE the read, so the walk
    // is a listing rather than a scan.
    const SRC = fileURLToPath(new URL("../../src", import.meta.url));
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "generated")
          continue;
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(tsx?|jsx?)$/.test(entry.name)) continue;
        if (readFileSync(full, "utf8").includes("dangerouslySetInnerHTML")) hits.push(full);
      }
    };
    walk(SRC);
    expect(
      hits.map((h) => h.replace(/\\/g, "/")),
      "a new dangerouslySetInnerHTML appeared — review it before merging",
    ).toEqual([
      expect.stringContaining("src/components/seo/JsonLd.tsx"),
      expect.stringContaining("src/components/ui/chart.tsx"),
    ]);
  });

  test("the JSON-LD block cannot be closed early by its own payload", () => {
    // The one property that makes JsonLd's dangerouslySetInnerHTML safe, pinned
    // so a future edit that drops the escaping fails here rather than in an
    // incident. JSON.stringify does NOT escape `<`; without this the injected
    // script element would execute.
    const source = read("src/components/seo/JsonLd.tsx");
    expect(source).toContain('replace(/</g, "\\\\u003c")');
    // And it must not interpolate anything unescaped into the markup.
    expect(source).not.toMatch(/dangerouslySetInnerHTML=\{\{ __html: `\$\{/);
  });

  test("CSP grants no third-party auth origin", () => {
    // Regression guard for the Clerk -> Better Auth cutover. Better Auth is served
    // from THIS origin at /api/auth/*, so every vendor allowance that existed for
    // the old provider should be gone rather than swapped for a new one. This
    // fails if someone reintroduces a remote auth origin, which would re-open
    // script-src and frame-src to a third party for no functional reason.
    for (const origin of [
      "api.clerk.com",
      "clerk.accounts.dev",
      "img.clerk.com",
      "fonts.clerk.com",
    ]) {
      expect(nextConfig).not.toContain(origin);
    }
  });

  test("CSP does not carry unsafe-eval outside development", () => {
    // next.config.ts gates it on NODE_ENV; assert the gate exists so a
    // production build cannot pick it up.
    expect(nextConfig).toContain('process.env.NODE_ENV === "development"');
  });
});

describe("web app manifest", () => {
  test("parses as JSON and declares the required fields", () => {
    expect(typeof manifest).toBe("object");
    for (const field of ["name", "short_name", "start_url", "display", "theme_color", "icons"]) {
      expect(manifest).toHaveProperty(field);
      expect(manifest[field]).toBeTruthy();
    }
  });

  test("every declared icon exists in public/", () => {
    // The previous manifest declared /favicon-192.png and /favicon-512.png.
    // Neither file has ever existed in public/ ÃƒÂ¢Ã¢šÂ¬Ã¢â‚¬Â only logo.svg does ÃƒÂ¢Ã¢šÂ¬Ã¢â‚¬Â so every
    // install icon 404'd. This is the assertion that caught it.
    const icons = manifest.icons as Array<{ src: string }>;
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      expect(icon.src.startsWith("/")).toBe(true);
      const path = fileURLToPath(new URL(`../../public${icon.src}`, import.meta.url));
      expect(() => readFileSync(path)).not.toThrow();
    }
  });

  test("declares a maskable icon", () => {
    const icons = manifest.icons as Array<{ purpose?: string }>;
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
  });

  test("start_url is the marketing root, never a console route", () => {
    expect(manifest.start_url).toBe("/");
  });

  test("theme_color matches the viewport themeColor in the root layout", () => {
    // Two different dark greens declared in two files is a visible flash of the
    // wrong chrome colour on install. `themeColor` is now an array (light + dark
    // media queries), so every declared colour is collected and the manifest must
    // match one of them — the manifest can only carry one.
    const themes = [...read("src/app/layout.tsx").matchAll(/color:\s*"(#[0-9A-Fa-f]{3,8})"/g)].map(
      (m) => m[1],
    );
    expect(themes.length).toBeGreaterThan(0);
    expect(themes).toContain(manifest.theme_color);
  });

  test("theme_color and background_color are valid hex colours", () => {
    for (const key of ["theme_color", "background_color"]) {
      expect(manifest[key] as string).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

describe("origin resolution", () => {
  function restore(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  test("robots and sitemap derive the same origin", () => {
    expect(robotsOrigin()).toBe(sitemapOrigin());
  });

  test("prefers NEXT_PUBLIC_SITE_URL and strips a trailing slash", () => {
    const savedUrl = process.env.NEXT_PUBLIC_SITE_URL;
    const savedHost = process.env.SITE_ADDRESS;
    try {
      process.env.NEXT_PUBLIC_SITE_URL = "https://voice.example.com/";
      expect(sitemapOrigin()).toBe("https://voice.example.com");
      expect(robotsOrigin()).toBe("https://voice.example.com");
      // An explicit URL wins over the TLS hostname.
      process.env.SITE_ADDRESS = "other.example.com";
      expect(sitemapOrigin()).toBe("https://voice.example.com");
    } finally {
      restore("NEXT_PUBLIC_SITE_URL", savedUrl);
      restore("SITE_ADDRESS", savedHost);
    }
  });

  test("promotes the bare SITE_ADDRESS to an https origin", () => {
    const savedUrl = process.env.NEXT_PUBLIC_SITE_URL;
    const savedHost = process.env.SITE_ADDRESS;
    try {
      delete process.env.NEXT_PUBLIC_SITE_URL;
      process.env.SITE_ADDRESS = "voice.example.com";
      expect(sitemapOrigin()).toBe("https://voice.example.com");
    } finally {
      restore("NEXT_PUBLIC_SITE_URL", savedUrl);
      restore("SITE_ADDRESS", savedHost);
    }
  });

  test("falls back to localhost so a dev build still emits valid output", () => {
    const savedUrl = process.env.NEXT_PUBLIC_SITE_URL;
    const savedHost = process.env.SITE_ADDRESS;
    try {
      delete process.env.NEXT_PUBLIC_SITE_URL;
      process.env.SITE_ADDRESS = "localhost";
      expect(sitemapOrigin()).toBe("http://localhost:3000");
    } finally {
      restore("NEXT_PUBLIC_SITE_URL", savedUrl);
      restore("SITE_ADDRESS", savedHost);
    }
  });
});

/**
 * Live check ÃƒÂ¢Ã¢šÂ¬Ã¢â‚¬Â opt-in.
 *
 * This is the ONLY way to observe the `next.config.ts` headers (CSP, HSTS,
 * nosniff, Referrer-Policy, X-Frame-Options) on real responses, because the
 * framework applies `headers()` downstream of the proxy and a NextResponse
 * built inside the proxy does not carry them.
 *
 *   SURFACE_BASE_URL=https://voice.example.com bun test tests/surface
 *
 * Without the env var these are reported as SKIPPED by Bun, never as passed.
 * Do not read a green run as proof the CSP shipped.
 */
const BASE_URL = process.env.SURFACE_BASE_URL?.replace(/\/+$/, "");

describe.skipIf(!BASE_URL)("live deployment (SURFACE_BASE_URL)", () => {
  const observed = async (path: string) =>
    (await fetch(`${BASE_URL}${path}`, { redirect: "manual" })).headers;

  test("a representative public route carries the full header set", async () => {
    const headers = await observed("/");
    for (const header of [
      "content-security-policy",
      "strict-transport-security",
      "x-content-type-options",
      "referrer-policy",
      "x-frame-options",
      "permissions-policy",
      "cross-origin-opener-policy",
    ]) {
      expect(headers.get(header), `${header} missing on /`).not.toBeNull();
    }
  });

  test("the CSP includes frame-ancestors 'none'", async () => {
    expect((await observed("/")).get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  test("a representative API route is noindex", async () => {
    expect((await observed("/api/status")).get("x-robots-tag")).toContain("noindex");
  });

  test("robots.txt and sitemap.xml are served and agree on the origin", async () => {
    const robotsTxt = await (await fetch(`${BASE_URL}/robots.txt`)).text();
    expect(robotsTxt).toContain("Disallow: /api/");
    expect(robotsTxt).not.toContain("Allow: /console");

    const sitemapXml = await (await fetch(`${BASE_URL}/sitemap.xml`)).text();
    expect(sitemapXml).toContain("<urlset");
    expect(sitemapXml).not.toContain("/console");
    expect(sitemapXml).not.toContain("/api");
  });

  test("the web manifest is served and parses", async () => {
    const res = await fetch(`${BASE_URL}/site.webmanifest`);
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as Record<string, unknown>;
    expect(parsed.name).toBeTruthy();
    expect(parsed.icons).toBeTruthy();
  });
});

describe("known gaps, asserted so they cannot be forgotten", () => {
  test("CLOSED 2026-10-10: the manifest IS linked from the root layout", () => {
    // This used to assert the GAP: `public/site.webmanifest` was served, but Next
    // only auto-links a manifest placed in the app/ root or named via
    // `metadata.manifest`, so no browser ever fetched it and the file was inert.
    // layout.tsx now declares `manifest: "/site.webmanifest"`. The assertion is
    // inverted so the gap cannot silently reopen.
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain('manifest: "/site.webmanifest"');
  });

  test("CLOSED 2026-10-10: the favicon set is declared and the files exist", () => {
    // The site shipped two SVGs and nothing else. Safari and iOS do not render
    // SVG favicons, and Windows asks for /favicon.ico unprompted — so a browser
    // could show a blank tab while every check that looked at "the logo file"
    // passed. Declared in metadata AND present on disk, which is the pair that
    // actually produces a favicon.
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain("/favicon.ico");
    expect(layout).toContain("/apple-icon.png");
    for (const file of [
      "src/app/favicon.ico",
      "src/app/apple-icon.png",
      "src/app/icon.svg",
      "public/icon-192.png",
      "public/icon-512.png",
      "public/icon-maskable-512.png",
      "public/og-image.png",
    ]) {
      expect(existsSync(file), `${file} is declared but missing`).toBe(true);
    }
  });

  test("the manifest's icons are real rasters, not SVG", () => {
    // A `maskable` entry pointing at an SVG is rejected by launcher audits, and
    // `sizes: "any"` on a raster is meaningless. Both are cheap to get wrong and
    // invisible in a browser tab.
    const icons = manifest.icons as { src: string; sizes: string; type: string; purpose: string }[];
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      expect(icon.type, `${icon.src} should be a raster`).toBe("image/png");
      expect(icon.sizes).toMatch(/^\d+x\d+$/);
      expect(existsSync(`public${icon.src}`), `${icon.src} referenced but missing`).toBe(true);
    }
  });

  test("CLOSED 2026-10-02: public/robots.txt no longer collides with app/robots.ts", () => {
    // MEASURED, then FIXED. `next dev` served `GET /robots.txt -> 500` with
    // "A conflicting public file and page file was found for path /robots.txt".
    // `public/robots.txt` was removed, leaving `src/app/robots.ts` the single
    // owner of the path. The assertion is now INVERTED: the collision must not
    // come back, and the app route must still exist as the real owner.
    // The collision must not come back, and the app route must remain the real
    // owner of the path. Before the fix, the legacy file ALSO claimed
    // `Allow: /` with only four AI-crawler blocks and no app-scoped Disallow,
    // so a crawler obeying robots.txt exactly was free to walk /api/*.
    expect(existsSync("public/robots.txt")).toBe(false);
    expect(existsSync("src/app/robots.ts")).toBe(true);

    // The generated file closes that gap.
    // `rules` is typed as one rule OR a list; this route returns a list. The
    // element type comes from the route itself (`MetadataRoute` is a Next
    // global this Bun test project does not pull in).
    type RobotsRule = Extract<ReturnType<typeof robots>["rules"], unknown[]>[number];
    const rules = robots().rules as RobotsRule[];
    const allCrawlers = rules.find((rule) => {
      const ua = Array.isArray(rule.userAgent) ? rule.userAgent : [rule.userAgent];
      return ua.includes("*");
    });
    expect(allCrawlers?.disallow).toContain("/api/");
  });

  test("security.txt is a placeholder, not a working contact", () => {
    // RFC 9116 is only worth publishing if someone answers. The placeholder
    // mailbox is recorded here so it cannot quietly ship as a real contact.
    expect(read("public/security.txt")).toContain("security@example.com");
  });
});
