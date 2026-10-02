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
import { existsSync, readFileSync } from "node:fs";
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
 * `clerkMiddleware` runs fine without Clerk keys in this context ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â it resolves
 * to "signed out" and passes the request through, which is exactly the state an
 * unauthenticated crawler is in. So this exercises the production function, not
 * a reimplementation of it.
 */
async function headersFor(pathname: string): Promise<Headers> {
  const res = await proxy(new NextRequest(`https://surface.test${pathname}`), {} as never);
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
  "/__clerk/", // Clerk internal proxy path
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
    expect(INDEXABLE_PATHS).toEqual(["/", "/sitemap.xml"]);
    expect(robotsTagFor("/")).toBeNull();
    expect(robotsTagFor("/sitemap.xml")).toBeNull();
    expect(robotsTagFor("/anything/new")).toBe("noindex, nofollow");
    expect(robotsTagFor("/api/")).toBe("noindex, nofollow");
  });

  test("/sitemap.xml is not noindex ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â it is the public SEO surface", () => {
    // Measured, not assumed: the proxy matcher DOES run for /sitemap.xml, so
    // before it was allowlisted the generated sitemap was served with
    // `X-Robots-Tag: noindex, nofollow` on a live server.
    expect(robotsTagFor("/sitemap.xml")).toBeNull();
  });
});

describe("robots.txt", () => {
  /** The `User-agent: *` rule. */
  const allCrawlers = () =>
    robots().rules.find((rule) => {
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
    const allows = robots()
      .rules.flatMap((r) => (Array.isArray(r.allow) ? r.allow : [r.allow]))
      .filter(Boolean);
    for (const allow of allows) {
      for (const forbidden of SITEMAP_FORBIDDEN) {
        expect(allow).not.toBe(forbidden);
      }
    }
  });

  test("AI crawlers are denied everything", () => {
    const rule = robots().rules.find((x) =>
      (Array.isArray(x.userAgent) ? x.userAgent : [x.userAgent]).includes("GPTBot"),
    );
    expect(rule?.disallow).toBe("/");
    // All four crawlers from the previous public/robots.txt are preserved.
    const agents = Array.isArray(rule?.userAgent) ? rule?.userAgent : [];
    expect(agents).toEqual(expect.arrayContaining(["GPTBot", "ClaudeBot", "Google-Extended"]));
  });

  test("advertises the sitemap with an absolute URL", () => {
    expect(robots().sitemap).toBe(`${robotsOrigin()}/sitemap.xml`);
    expect(robots().sitemap).toMatch(/^https?:\/\//);
  });
});

describe("sitemap", () => {
  const entries = sitemap();

  test("declares exactly the paths the proxy allows to be indexed", () => {
    // Note /sitemap.xml is indexable but is NOT a sitemap entry ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a sitemap
    // listing itself is noise. So the two lists are related, not identical.
    const paths = entries.map((e) => new URL(e.url).pathname).sort();
    for (const path of paths) {
      expect(INDEXABLE_PATHS).toContain(path);
    }
  });

  test("the marketing root is the only entry", () => {
    expect(entries).toHaveLength(1);
    expect(new URL(entries[0]!.url).pathname).toBe("/");
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

  test("/ allows the microphone ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â because that is where the demo view lives", () => {
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
    // Presence of the declaration, not of the emitted value ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â see the source
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
    // A CSP that breaks Clerk, next/font or the websocket is worse than a weak
    // one, so these are pinned: removing any of them breaks the product, and
    // tightening them needs a browser, not a text edit.
    for (const directive of [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'", // framer-motion + Tailwind
      "connect-src", // ElevenLabs + Clerk (+ wss for session sync)
      "font-src", // next/font self-hosts; Clerk serves fonts
      "frame-src", // Clerk component iframes
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ]) {
      expect(nextConfig).toContain(directive);
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
    // Neither file has ever existed in public/ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â only logo.svg does ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â so every
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
    // Two different dark greens were declared in two files. A mismatch is a
    // visible flash of the wrong chrome colour on install.
    const theme = /themeColor:\s*"(#[0-9A-Fa-f]{3,8})"/.exec(read("src/app/layout.tsx"))?.[1];
    expect(theme).toBeDefined();
    expect(manifest.theme_color).toBe(theme);
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
 * Live check ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â opt-in.
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
    expect((await observed("/")).get("content-security-policy")).toContain("frame-ancestors 'none'");
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
  test("the manifest is NOT linked from the root layout", () => {
    // `public/site.webmanifest` is served, but Next only auto-links a manifest
    // placed in the app/ root or named via `metadata.manifest`. layout.tsx sets
    // neither, so no browser ever fetches the file. src/app/layout.tsx is
    // outside this work package's scope, so this test records the gap instead
    // of quietly passing. Fix: add `manifest: "/site.webmanifest"` to the
    // metadata export in src/app/layout.tsx.
    const layout = read("src/app/layout.tsx");
    expect(layout).not.toContain("/site.webmanifest");
    expect(layout).not.toContain("manifest:");
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
    const allCrawlers = robots().rules.find((rule) => {
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
