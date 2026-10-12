/**
 * Which origin the deployment publishes as its own identity.
 *
 * `siteOrigin()` decides the `<link rel="canonical">` on every page, the `<loc>` of
 * every sitemap entry, the `Sitemap:` line in robots.txt, and the Open Graph URL.
 * Get it wrong and the site is fully crawlable, fully correct, and permanently
 * unable to rank for its own name — because every document tells the crawler the
 * real page lives somewhere else.
 *
 * The wrong that actually happened: `SITE_ADDRESS` is the hostname Caddy issues TLS
 * for, and on the VPS that was `57.130.80.158.sslip.io` — a dynamic-DNS stand-in
 * that is perfect for a certificate and fatal as a canonical. `NEXT_PUBLIC_SITE_URL`
 * defaulted to it in `docker-compose.yml`, so the whole SEO identity followed.
 *
 * `siteOriginIsPlaceholder()` is the diagnostic for exactly that state. It changes
 * no behaviour on purpose: the alternative — deriving the canonical from the
 * request's own `Host` — would fix the tag and hand whoever forges the header the
 * ability to declare which domain this site says is real.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { siteOrigin, siteOriginIsPlaceholder } from "@/lib/site-origin";

const KEYS = ["NEXT_PUBLIC_SITE_URL", "SITE_DOMAIN", "SITE_ADDRESS", "APP_URL"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function configure(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v;
  }
}

describe("siteOrigin", () => {
  test("an explicit URL wins, and its trailing slash is stripped", () => {
    configure({
      NEXT_PUBLIC_SITE_URL: "https://securevoiceai.me/",
      SITE_ADDRESS: "57.130.80.158.sslip.io",
    });
    expect(siteOrigin()).toBe("https://securevoiceai.me");
  });

  test("SITE_DOMAIN is the bare-hostname spelling of the same answer", () => {
    configure({ SITE_DOMAIN: "securevoiceai.me", SITE_ADDRESS: "57.130.80.158.sslip.io" });
    expect(siteOrigin()).toBe("https://securevoiceai.me");
    // A value pasted in with its scheme or a trailing slash still resolves once.
    configure({ SITE_DOMAIN: "https://securevoiceai.me/" });
    expect(siteOrigin()).toBe("https://securevoiceai.me");
  });

  test("SITE_ADDRESS is still honoured — nothing that works today regresses", () => {
    configure({ SITE_ADDRESS: "console.example.ae" });
    expect(siteOrigin()).toBe("https://console.example.ae");
  });

  test("with nothing set, the dev fallback is used rather than a throw", () => {
    configure({});
    // A local build must still emit a parseable robots.txt and sitemap.
    expect(siteOrigin()).toMatch(/^https?:\/\//);
  });
});

describe("siteOriginIsPlaceholder", () => {
  test("names a real domain as publishable", () => {
    configure({ NEXT_PUBLIC_SITE_URL: "https://securevoiceai.me" });
    expect(siteOriginIsPlaceholder()).toBe(false);
  });

  test("names the stand-ins that silently deindex a site", () => {
    for (const host of [
      "57.130.80.158.sslip.io",
      "securevoice.nip.io",
      "demo.ngrok.app",
      "tunnel.trycloudflare.com",
      "157.245.1.20",
      "localhost",
    ]) {
      configure({ NEXT_PUBLIC_SITE_URL: `https://${host}` });
      expect(siteOriginIsPlaceholder(), host).toBe(true);
    }
  });

  test("a subdomain of a real domain is not a placeholder", () => {
    configure({ NEXT_PUBLIC_SITE_URL: "https://app.securevoiceai.me" });
    expect(siteOriginIsPlaceholder()).toBe(false);
  });
});
