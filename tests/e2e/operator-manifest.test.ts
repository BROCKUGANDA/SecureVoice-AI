/**
 * E2E — the operator capability manifest (Knowledge Base + RAG, Tools & Actions).
 *
 * Two properties are pinned here, and the second is the one that matters.
 *
 *   1. The shape the dashboard renders is actually served: the two KB
 *      documents, the RAG + source-attribution config, the five safe tools,
 *      the backends they reach, and the MCP front door. A panel that names a
 *      capability the agent does not have is worse than no panel.
 *
 *   2. NO SECRET VALUE APPEARS IN THE RESPONSE. Capability, never credential:
 *      no API key, no AGENT_TOOL_SECRET, no BYOK material — the same contract
 *      /api/operator/webhooks holds. This assertion keeps the route from
 *      becoming the one endpoint that publishes the material every other route
 *      guards.
 *
 *   bun scripts/run-tests.mjs operator-manifest
 */
import { expect, test } from "bun:test";
import { NextRequest } from "next/server";

test("operator manifest lists KB/RAG + tools and leaks no secret values", async () => {
  const { GET } = await import("@/app/api/operator/manifest/route");
  const req = new NextRequest("http://localhost/api/operator/manifest");
  const res = await GET(req);
  expect(res.status).toBe(200);

  const body = (await res.json()) as {
    ok: boolean;
    knowledge_base: Array<{ id: string; lang: string; version: string }>;
    rag: { enabled: boolean; source_attribution: boolean; include_source_urls: boolean };
    tools: Array<{ name: string; trust: string; mcp: boolean; backend: string }>;
    backends: Array<{ id: string }>;
    mcp: { endpoint: string };
    counts: { tools: number; documents: number; privileged_tools: number };
  };

  expect(body.ok).toBe(true);

  // Knowledge base + RAG + source attribution
  expect(body.knowledge_base.length).toBe(body.counts.documents);
  expect(body.knowledge_base.map((d) => d.lang).sort()).toEqual(["ar", "en"]);
  expect(body.rag.enabled).toBe(true);
  expect(body.rag.source_attribution).toBe(true);
  expect(body.rag.include_source_urls).toBe(true);

  // Tools & actions
  const names = body.tools.map((t) => t.name).sort();
  expect(names).toEqual([
    "card_freeze",
    "human_handoff",
    "switch_language",
    "verify_transaction",
    "warm_transfer",
  ]);
  expect(body.tools.length).toBe(body.counts.tools);
  for (const tool of body.tools) {
    expect(tool.mcp).toBe(true); // every tool is MCP-exposed
    expect(tool.backend.length).toBeGreaterThan(0); // every tool reaches a backend
  }
  // The trust story is present: card_freeze is the privileged one.
  expect(body.tools.find((t) => t.name === "card_freeze")?.trust).toBe("privileged");
  expect(body.counts.privileged_tools).toBe(1);

  // The three backends the brief names all appear.
  const backendIds = body.backends.map((b) => b.id);
  expect(backendIds).toContain("core-banking-sandbox");
  expect(backendIds).toContain("claims-rules-engine");
  expect(backendIds).toContain("case-management-mock");

  // NO SECRETS anywhere in the serialized response.
  const raw = JSON.stringify(body);
  expect(raw).not.toMatch(/sk_[A-Za-z0-9]{8,}/);
  expect(raw).not.toContain("AGENT_TOOL_SECRET");
  expect(raw).not.toContain("BANK_WEBHOOK_SECRET");
  expect(raw.toLowerCase()).not.toContain("secret");
});
