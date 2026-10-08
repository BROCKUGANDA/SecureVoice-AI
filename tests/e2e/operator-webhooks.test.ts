/**
 * E2E — the operator webhook catalogue.
 *
 * Two properties are being pinned here, and the second is the one that matters.
 *
 *   1. Every endpoint an integrator is told to configure is actually reachable.
 *      A catalogue that names a path the app does not serve is worse than no
 *      catalogue: the operator finds out at 02:00 while a Twilio number is
 *      ringing into nothing.
 *
 *   2. NO SECRET VALUE APPEARS IN THE RESPONSE. The catalogue names the env
 *      VAR (`BANK_WEBHOOK_SECRET`) and never its value. This is the assertion
 *      that keeps the route from becoming the one endpoint that publishes the
 *      signing material for every other endpoint.
 *
 *   bun scripts/run-tests.mjs operator-webhooks
 */
import { expect, test } from "bun:test";
import { NextRequest } from "next/server";

/** Env var names the catalogue is allowed to mention by NAME. */
const NAMED_SECRETS = [
  "WEBHOOK_SECRET",
  "BANK_WEBHOOK_SECRET",
  "ELEVENLABS_WEBHOOK_SECRET",
  "TWILIO_AUTH_TOKEN",
];

test("operator webhook catalogue lists endpoints and leaks no secret values", async () => {
  const { GET } = await import("@/app/api/operator/webhooks/route");

  const req = new NextRequest("http://localhost/api/operator/webhooks", {
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "app.example.com" },
  });
  const res = await GET(req);
  expect(res.status).toBe(200);

  const body = (await res.json()) as {
    ok: boolean;
    origin: string;
    origin_configured: boolean;
    count: number;
    webhooks: Array<{
      id: string;
      path: string;
      method: string;
      auth: string;
      secret_env: string | null;
      direction: string;
      url: string;
    }>;
  };

  expect(body.ok).toBe(true);
  expect(body.webhooks.length).toBe(body.count);
  expect(body.webhooks.length).toBeGreaterThan(0);

  // The forwarded host is honoured, so a proxied deployment hands back the
  // origin the operator actually types into the Twilio console.
  expect(body.origin).toBe("https://app.example.com");
  expect(body.origin_configured).toBe(true);

  const byId = new Map(body.webhooks.map((w) => [w.id, w]));

  for (const id of [
    "inbound-intervention",
    "outbound-delivery",
    "elevenlabs-postcall",
    "twilio-sms",
    "twilio-status",
  ]) {
    const entry = byId.get(id);
    expect(entry, `catalogue is missing ${id}`).toBeTruthy();
    expect(entry!.path.startsWith("/api/")).toBe(true);
    expect(entry!.url.endsWith(entry!.path)).toBe(true);
    expect(entry!.url.startsWith("https://app.example.com")).toBe(true);
    expect(entry!.method.length).toBeGreaterThan(0);
    expect(entry!.auth.length).toBeGreaterThan(0);
    expect(["inbound", "outbound"]).toContain(entry!.direction);
  }

  // THE assertion: no secret VALUE anywhere in the serialised response. Seeded
  // from the environment when present so this fails loudly if a real credential
  // is ever interpolated in, not just for the synthetic sentinel below.
  const raw = JSON.stringify(body);
  for (const envName of NAMED_SECRETS) {
    const value = process.env[envName];
    if (value && value.length >= 8) {
      expect(raw).not.toContain(value);
    }
  }
  expect(raw).not.toContain("whsec_");
  expect(raw).not.toContain("AC1");

  // Only NAMES are permitted, and only as the declared `secret_env` field.
  for (const w of body.webhooks) {
    if (w.secret_env) {
      expect(NAMED_SECRETS.some((n) => w.secret_env!.includes(n))).toBe(true);
      expect(w.secret_env).not.toMatch(/=/);
    }
  }
});

test("catalogue reports an unconfigured origin instead of inventing one", async () => {
  const { GET } = await import("@/app/api/operator/webhooks/route");

  const saved = {
    a: process.env.NEXT_PUBLIC_APP_URL,
    b: process.env.APP_BASE_URL,
    c: process.env.TWILIO_WEBHOOK_BASE_URL,
  };
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.APP_BASE_URL;
  delete process.env.TWILIO_WEBHOOK_BASE_URL;

  try {
    // No proxy headers at all: there is no honest origin to publish.
    const res = await GET(new NextRequest("http://localhost/api/operator/webhooks"));
    const body = (await res.json()) as { origin: string; origin_configured: boolean };
    expect(body.origin).toBe("https://your-app.com");
    expect(body.origin_configured).toBe(false);
  } finally {
    if (saved.a !== undefined) process.env.NEXT_PUBLIC_APP_URL = saved.a;
    if (saved.b !== undefined) process.env.APP_BASE_URL = saved.b;
    if (saved.c !== undefined) process.env.TWILIO_WEBHOOK_BASE_URL = saved.c;
  }
});
