import type { NextConfig } from "next";

/**
 * Content-Security-Policy notes:
 *  - 'unsafe-inline' on style-src is required by Next.js + Tailwind injected styles.
 *  - script-src 'unsafe-inline' is needed for Next.js's inline bootstrap scripts in
 *    dev; in production Next hashes/nonces these where possible, but the app-shell
 *    rendering (framer-motion inline styles) keeps style-src 'unsafe-inline'.
 *  - connect-src includes ElevenLabs (voice) and Clerk (auth: api.clerk.com +
 *    the dev Frontend API *.clerk.accounts.dev, wss for session sync).
 *  - script/frame/font/img allowances cover the Clerk JS bundle, embedded
 *    component iframes, fonts, and profile images (img.clerk.com).
 */
// 'unsafe-eval' is a dev-server requirement (React refresh); it never ships
// in a production CSP.
const scriptSrc = [
  "script-src 'self' 'unsafe-inline'",
  ...(process.env.NODE_ENV === "development" ? ["'unsafe-eval'"] : []),
  "https://clerk.accounts.dev https://*.clerk.accounts.dev https://api.clerk.com",
].join(" ");

const CSP = [
  "default-src 'self'",
  scriptSrc,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: https://img.clerk.com https://*.clerk.accounts.dev",
  "font-src 'self' data: https://fonts.clerk.com https://clerk.accounts.dev https://*.clerk.accounts.dev",
  "media-src 'self' blob:",
  "connect-src 'self' https://api.elevenlabs.io https://api.clerk.com https://*.clerk.accounts.dev wss://*.clerk.accounts.dev",
  "worker-src 'self' blob:",
  "frame-src 'self' https://*.clerk.accounts.dev",
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
  async rewrites() {
    return [
      { source: "/v1/interventions", destination: "/api/interventions" },
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
