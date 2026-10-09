/**
 * E2E — the operator model-layer surface (LLM-agnostic + fallback cascade).
 *
 * Two properties:
 *
 *   1. The cascade ORDER matches provider()'s real precedence (groq → lite_llm
 *      → gemini), and the active provider is a cascade NAME or null — so the
 *      panel can show "LLM-agnostic, with failover" faithfully.
 *
 *   2. NO CREDENTIAL LEAKS. provider() resolves the active fallback with its
 *      key and base URL; the route reads only `.name`. This asserts no key, no
 *      base URL, and no secret string appears in the response — the same
 *      contract the sibling /api/operator/* metadata routes hold.
 *
 *   bun scripts/run-tests.mjs operator-model-layer
 */
import { expect, test } from "bun:test";
import { NextRequest } from "next/server";

test("operator model-layer exposes the cascade and leaks no secret values", async () => {
  const { GET } = await import("@/app/api/operator/model-layer/route");
  const res = await GET(new NextRequest("http://localhost/api/operator/model-layer"));
  expect(res.status).toBe(200);

  const body = (await res.json()) as {
    ok: boolean;
    agent_plane: { llm: string; note: string };
    fallback_cascade: { order: string[]; active: string | null; note: string };
    byok_note: string;
  };

  expect(body.ok).toBe(true);
  expect(body.agent_plane.llm.length).toBeGreaterThan(0);

  // The cascade order is exactly provider()'s precedence.
  expect(body.fallback_cascade.order).toEqual(["groq", "lite_llm", "gemini"]);
  // Active is a name in the cascade, or null — never a key or URL.
  expect(
    body.fallback_cascade.active === null ||
      body.fallback_cascade.order.includes(body.fallback_cascade.active),
  ).toBe(true);

  // No credential leaks: names + prose only.
  const raw = JSON.stringify(body);
  expect(raw).not.toMatch(/sk_[A-Za-z0-9]{8,}/);
  expect(raw).not.toMatch(/https?:\/\//);
  expect(raw.toLowerCase()).not.toContain("secret");
  expect(raw.toLowerCase()).not.toContain("apikey");
  expect(raw.toLowerCase()).not.toContain("baseurl");
});
