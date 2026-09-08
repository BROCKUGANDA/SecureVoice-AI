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
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://clerk.accounts.dev https://*.clerk.accounts.dev https://api.clerk.com",
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
