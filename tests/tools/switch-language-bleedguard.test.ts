/**
 * The switch_language bleedguard — WP-3's one route that used to resolve its
 * case by conversation_id ALONE.
 *
 * The other four agent tools fold the caller's org into the case lookup via
 * guardToolCall → caseByConversation, where a null orgId means the default
 * namespace and never "any org". switch_language ran its own guarded UPDATE
 * without that predicate, so any caller holding any valid credential could
 * rewrite any live case's language — cross-tenant and MCP-reachable.
 *
 * This is the real database: the credential is a real per-tenant
 * AgentToolSecret and the foreign case is a real row, so the assertion is
 * about the lookup, not about a mock's opinion of it. Like its siblings in
 * tests/tools/guard.test.ts it therefore needs a reachable Postgres
 * (TEST_DATABASE_URL) — against no database it fails on the setup, not on the
 * property.
 *
 *   bun test tests/tools/switch-language-bleedguard.test.ts
 */
import { test, expect } from "bun:test";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { POST as switchLang } from "@/app/api/elevenlabs/tools/switch-language/route";
import { TOOL_TENANT_ORG_ID, issueTenantToolSecret } from "../tool-tenant";

process.env.ELEVENLABS_DRY_RUN = "true";
process.env.AGENT_TOOL_SECRET = process.env.AGENT_TOOL_SECRET ?? "test-tool-secret";
process.env.AGENT_TOOL_ALLOWED = "switch_language";

// A credential bound to TOOL_TENANT_ORG_ID — valid, and pointed at a case that
// belongs to somebody else.
const SECRET = await issueTenantToolSecret("switch-language-bleedguard");

test("switch_language cannot reach another tenant's case", async () => {
  const otherOrg = "99999999-8888-4777-8666-555555555555";
  const otherConversation = `conv-other-tenant-${Date.now().toString(36)}`;
  const foreign = await db.case.create({
    data: {
      caseRef: `SV-FOREIGN-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      conversationId: otherConversation,
      orgId: otherOrg,
      state: "ANSWERED",
      language: "en",
    },
    select: { caseRef: true },
  });

  try {
    const res = await switchLang(
      new NextRequest("http://localhost/api/elevenlabs/tools/switch-language", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-tool-secret": SECRET,
        },
        body: JSON.stringify({ conversation_id: otherConversation, language: "ur" }),
      } as ConstructorParameters<typeof NextRequest>[1]),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    // The refusal does not even confirm the case exists — "no live case" is
    // the same answer another tenant's unknown id gets.
    expect(body.error).toBe("no live case for this conversation_id");

    // And nothing was written.
    const after = await db.case.findUnique({ where: { caseRef: foreign.caseRef } });
    expect(after!.language).toBe("en");
  } finally {
    await db.case.deleteMany({ where: { caseRef: foreign.caseRef } });
    await db.$disconnect();
  }
}, 60_000);
