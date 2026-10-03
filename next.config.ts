import type { NextConfig } from "next";

/**
 * Content-Security-Policy notes:
 *  - 'unsafe-inline' on style-src is required by Next.js + Tailwind injected styles.
 *  - script-src 'unsafe-inline' is needed for Next.js's inline bootstrap scripts in
 *    dev; in production Next hashes/nonces these where possible, but the app-shell
 *    rendering (framer-motion inline styles) keeps style-src 'unsafe-inline'.
 *  - connect-src includes ElevenLabs (voice) only. Authentication is Better
 *    Auth, served from THIS origin at /api/auth/*, so it needs no cross-origin
 *    allowance at all.
 *  - No third-party origins remain in script-src / img-src / font-src / frame-src.
 *    Those entries existed only for the removed Clerk JS bundle and its embedded
 *    component iframes. Deleting them narrows the policy rather than swapping one
 *    vendor for another: every directive that can be reduced was reduced.
 */
// 'unsafe-eval' is a dev-server requirement (React refresh); it never ships
// in a production CSP.
const scriptSrc = [
  "script-src 'self' 'unsafe-inline'",
  ...(process.env.NODE_ENV === "development" ? ["'unsafe-eval'"] : []),
].join(" ");

const CSP = [
  "default-src 'self'",
  scriptSrc,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self' https://api.elevenlabs.io",
  "worker-src 'self' blob:",
  "frame-src 'self'",
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
    value: "camera=(), microphone=(self), geolocation=(), payment=()",
  },
  { key: "X-DNS-Prefetch-Control", value: "on" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  compress: true,
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

export default nextConfig;
