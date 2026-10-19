import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
import { readFileSync } from "node:fs";

/**
 * The version shown on the landing page.
 *
 * Read from package.json at BUILD time and inlined as NEXT_PUBLIC_APP_VERSION,
 * so the displayed number is always the number of the artifact that was actually
 * built. There is no hand-typed version string in the UI to forget: bump
 * package.json (`bun run version:bump 0.4.0`, or the release workflow) and the
 * next build re-injects it into every surface that renders it.
 *
 * Read rather than imported so the whole manifest is not pulled into the
 * config's module graph, and guarded so a malformed manifest degrades to a
 * visible placeholder instead of failing the build on a cosmetic string.
 */
function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL("./package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() !== ""
      ? parsed.version.trim()
      : "0.0.0-unknown";
  } catch {
    return "0.0.0-unknown";
  }
}

/**
 * Content-Security-Policy notes:
 *  - 'unsafe-inline' on style-src is required by Next.js + Tailwind injected styles.
 *  - 'unsafe-inline' on script-src is required in PRODUCTION, not just dev: this
 *    build emits Next's RSC flight payload as inline `self.__next_f.push(...)`
 *    scripts, and they carry no nonce and no hash. Blocking them does not degrade
 *    the page — it kills hydration outright (React #412) and the app-shell splash
 *    never advances past 0%, which is how this deployment went dark. Measured, not
 *    inferred: a headless load of the live origin reported six blocked inline
 *    scripts before any of the page's own JS could run.
 *  - A nonce or hash is NOT a second way to permit those scripts here — it is a
 *    way to break them. Browsers IGNORE 'unsafe-inline' whenever script-src
 *    carries a nonce or hash source, so `script-src 'self' 'nonce-…'
 *    'unsafe-inline'` blocks the flight scripts exactly like `script-src 'self'`.
 *    This build's flight scripts carry neither token, so any nonce/hash in the
 *    directive is unmatched by definition. The surface suite rejects it
 *    (tests/surface/surface.test.ts) rather than accepting "any nonce or hash".
 *  - Injection tradeoff, stated plainly: script-src 'unsafe-inline' means an
 *    attacker who can inject script-bearing markup gets it executed. The
 *    compensating control is at the source — first-party code renders no
 *    attacker-reachable HTML (the only dangerouslySetInnerHTML in the app is a
 *    <style> block of chart colors, pinned by the surface suite), and every
 *    other executable directive is closed: object-src 'none', base-uri 'self',
 *    form-action 'self', frame-ancestors 'none', no 'unsafe-eval' in production.
 *  - The strict alternative is a per-request nonce (`script-src 'nonce-…'
 *    'strict-dynamic'`) generated in proxy.ts with dynamic rendering. It is NOT in
 *    place here, and nothing in this version of Next was found to add the nonce to
 *    its own flight scripts automatically. Anyone re-attempting the tightening must
 *    prove hydration in a real browser against a production build first — a text
 *    edit on a CSP is exactly the change that CI cannot judge.
 *  - connect-src carries ElevenLabs (voice) and Paddle (its SDK calls
 *    api.paddle.com / sandbox-api.paddle.com). Authentication is Better Auth,
 *    served from THIS origin at /api/auth/*, so it needs no cross-origin
 *    allowance at all.
 *  - Paddle is the ONLY third-party origin in script-src / frame-src, and it is
 *    there because the billing SDK injects its own CDN script and renders its
 *    card frame from Paddle's host — see PADDLE_*_ORIGINS below for the measured
 *    failure that made this necessary. The Clerk-era allowances in img-src /
 *    font-src are still gone: every directive that can be reduced was reduced,
 *    and tests/surface/csp.test.ts pins the exact set so it stays that way.
 */
// 'unsafe-eval' is a dev-server requirement (React refresh); it never ships
// in a production CSP.

// The connect-src allowance must follow ELEVENLABS_API_BASE_URL so a gateway/
// region override stays reachable from the browser; see `connectSrcDirective`.

// 'unsafe-inline' is in BOTH modes on purpose. Dropping it from the production
// list is what took the live site down; see the CSP notes above.
const scriptSrc = [
  "script-src 'self' 'unsafe-inline'",
  ...(process.env.NODE_ENV === "development" ? ["'unsafe-eval'"] : []),
].join(" ");

/**
 * Paddle needs three origins, and it needed them the day billing was wired.
 *
 * This file's own stated policy was "no third-party origins remain in
 * script-src / img-src / font-src / frame-src" — a deliberate hardening — and
 * `@paddle/paddle-js` injects `https://cdn.paddle.com/paddle/v2/paddle.js` at
 * runtime and renders its card frame from `buy.paddle.com`. So the two
 * decisions contradicted each other and the browser settled it: the script was
 * blocked, `initializePaddle` rejected with "Failed to load Paddle.js", and no
 * checkout on the site could open — on `/pricing` as much as on `/checkout`.
 * Measured 2026-10-14 in the deployed origin's console.
 *
 * The allowance is therefore named and minimal, not a loosening: script from the
 * CDN, frames from the two checkout hosts, and connections only to the hosts the
 * SDK itself calls. `tests/surface/csp.test.ts` pins the exact set so widening it
 * later is a decision someone has to make in review, not a slip.
 */
const PADDLE_SCRIPT_ORIGIN = "https://cdn.paddle.com";
const PADDLE_FRAME_ORIGINS = ["https://buy.paddle.com", "https://sandbox-buy.paddle.com"];
const PADDLE_CONNECT_ORIGINS = [
  "https://cdn.paddle.com",
  "https://api.paddle.com",
  "https://sandbox-api.paddle.com",
];

/**
 * The `connect-src` directive, built from the same variables the SDKs read.
 *
 * Error reporting was missing from this list. The DSN in this deployment points at
 * Better Stack's Sentry-compatible host, and because that origin was never allowed,
 * every browser-side exception was refused by our own CSP — measured 2026-10-19 in a
 * live demo session: "Fetch API cannot load
 * https://s2791972.us-west-2a.betterstackdata.com/api/2791978/envelope/ … Refused".
 * The consequence is not cosmetic: what Better Stack shows for client errors
 * undercounts what users actually hit, and the platform was reporting itself as
 * quieter than it is.
 *
 * Derived from `SENTRY_DSN` rather than written out, so rotating the DSN cannot leave
 * the policy pointing at the old host — and so a DSN change that outgrows the policy
 * fails `tests/surface/csp.test.ts` instead of silently disabling reporting again.
 */
export function connectSrcDirective(
  elevenLabsBase: string,
  sentryDsn?: string,
): { directive: string; rejectedDsn: boolean } {
  const origins = [
    new URL(elevenLabsBase).origin,
    "https://cdn.paddle.com",
    "https://api.paddle.com",
    "https://sandbox-api.paddle.com",
  ];
  let rejectedDsn = false;
  if (sentryDsn) {
    try {
      const origin = new URL(sentryDsn).origin;
      if (origin && origin !== "null") origins.push(origin);
      else rejectedDsn = true;
    } catch {
      // A malformed DSN must not inject garbage into the policy. The SDK will fail on
      // its own terms; the CSP stays as narrow as it was.
      rejectedDsn = true;
    }
  }
  return { directive: `connect-src 'self' ${origins.join(" ")}`, rejectedDsn };
}

const CONNECT_SRC = connectSrcDirective(
  process.env.ELEVENLABS_API_BASE_URL ?? "https://api.elevenlabs.io",
  process.env.SENTRY_DSN,
);
if (CONNECT_SRC.rejectedDsn) {
  console.warn(
    "[csp] SENTRY_DSN is set but unparseable — client error reporting will be blocked by CSP; fix the DSN, do not widen the directive",
  );
}

export const CSP = [
  "default-src 'self'",
  `${scriptSrc} ${PADDLE_SCRIPT_ORIGIN}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  CONNECT_SRC.directive,
  "worker-src 'self' blob:",
  `frame-src 'self' ${PADDLE_FRAME_ORIGINS.join(" ")}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "on" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  compress: true,
  // Inlined into the client bundle at build time. `env` (rather than only
  // process.env) is what makes it readable in a client component — only
  // NEXT_PUBLIC_* and this map survive the compiler's dead-code elimination.
  env: {
    NEXT_PUBLIC_APP_VERSION: readPackageVersion(),
  },
  typescript: {
    // Fail the build on type errors — verified clean as of this hardening pass.
    ignoreBuildErrors: false,
  },
  experimental: {
    // Proxy (src/proxy.ts) clones and buffers the request body so both it and the
    // route handler can read it. The default cap is 10MB, but /api/asr accepts a
    // base64 recording up to MAX_ASR_BODY_BYTES = 34_000_000 — so without this,
    // any recording over ~7.5MB of audio reached the handler already truncated and
    // failed `req.json()` with 400 instead of a 413. Set above the ASR limit.
    proxyClientMaxBodySize: "40mb",
  },
  // Headless-API aliases — the integration contract a bank's fraud engine
  // follows (pitch/docs) uses the /v1/ prefix; these serve the same handlers.
  //
  // CRITICAL: /v1/interventions must resolve to the HARDENED handler at
  // src/app/api/v1/interventions/route.ts — the one with the policy gate, the
  // abuse gate, planTier, the Case row and the durable dial queue.
  //
  // It previously pointed at /api/interventions, an older ingest with NO
  // policy gate, NO abuse gate, NO Case row and an in-request carrier call. So
  // the endpoint every bank is told to call, and the endpoint the operator
  // console fires through, both bypassed every guardrail in the system. The
  // hardened handler existed, was tested, and was unreachable in production.
  async rewrites() {
    return [
      { source: "/v1/interventions", destination: "/api/v1/interventions" },
      { source: "/v1/enroll", destination: "/api/enroll" },
      { source: "/v1/status", destination: "/api/status" },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

// Sentry's build wrapper IS exported by `@sentry/nextjs@11.4.0` — from the
// `./config` subpath, not the root entry. A note left here previously claimed the
// wrapper did not exist, which is how browser-side error capture stayed switched
// off while the code that configures it sat in the repo looking complete.
//
// Applied only when upload credentials exist. `SENTRY_DSN` governs RUNTIME
// reporting (see src/instrumentation-client.ts); `SENTRY_AUTH_TOKEN` governs
// BUILD-TIME source-map upload, and running the wrapper without it makes the
// build do work it cannot finish for a reason that has nothing to do with the
// application. `telemetry: false` because a build must not phone home.
export function withObservability(
  config: NextConfig,
  env: Record<string, string | undefined> = process.env,
): NextConfig {
  if (!env.SENTRY_AUTH_TOKEN || !env.SENTRY_DSN) return config;
  return withSentryConfig(config, {
    org: env.SENTRY_ORG,
    project: env.SENTRY_PROJECT,
    telemetry: false,
    silent: true,
  });
}

export default withObservability(nextConfig);
