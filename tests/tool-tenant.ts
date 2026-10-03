/**
 * Test helper — a real per-tenant agent-tool credential.
 *
 * The tool routes authenticate on the presented secret and resolve WHICH TENANT
 * from it: a per-tenant `AgentToolSecret` names exactly one org, and the
 * deployment-wide platform key is confined to the default namespace. Tool tests
 * therefore cannot keep seeding org-scoped cases while presenting the platform
 * key — the lookup is correctly scoped and finds nothing.
 *
 * This helper provisions the tenant row plus a credential bound to it and hands
 * back the plaintext, so a test exercises the same path production uses rather
 * than asserting against a mock. One organization and one secret per process;
 * `rotateTenantSecret()` mints a fresh secret when a test needs a known-good
 * value after another test revoked or rewrote it.
 */
import { randomBytes, createHash } from "node:crypto";
import { db } from "@/lib/db";

/** Fixed so repeated runs share one tenant instead of littering organizations. */
export const TOOL_TENANT_ORG_ID = "11111111-2222-4333-8444-555555555555";
const SLUG = "tool-test-tenant";

export function generateToolSecret(): string {
  return `svt_${randomBytes(24).toString("hex")}`;
}

export function hashToolSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

async function ensureOrganization(): Promise<void> {
  await db.organization.upsert({
    where: { id: TOOL_TENANT_ORG_ID },
    create: {
      id: TOOL_TENANT_ORG_ID,
      name: "Tool Test Tenant",
      slug: SLUG,
      createdAt: new Date(),
    },
    update: {},
  });
}

/** Provision the tenant and return a plaintext secret valid for it. */
export async function issueTenantToolSecret(label = "tool-tests"): Promise<string> {
  await ensureOrganization();
  const plaintext = generateToolSecret();
  await db.agentToolSecret.create({
    data: {
      label,
      keyHash: hashToolSecret(plaintext),
      orgId: TOOL_TENANT_ORG_ID,
    },
  });
  return plaintext;
}

/** Remove every credential issued to the tool-test tenant. */
export async function revokeTenantToolSecrets(): Promise<void> {
  await db.agentToolSecret.deleteMany({ where: { orgId: TOOL_TENANT_ORG_ID } });
}
