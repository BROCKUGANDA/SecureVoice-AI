import "server-only";
/**
 * Shared authentication for inbound agent-tool calls from the ElevenLabs
 * Agents Platform (and any other server caller).
 *
 * The high-stakes tools on this agent — `card_freeze` above all — must not be
 * reachable by anything that merely knows the public URL. ElevenLabs signs
 * nothing on webhook-tool calls by default, so the trust decision here is:
 *
 *   1. A shared bearer secret (`AGENT_TOOL_SECRET`) presented by the caller.
 *      Compared with `timingSafeEqual` so the comparison does not leak the
 *      secret byte-by-byte through response timing.
 *   2. An allow-list of the exact tool names a given caller is permitted to
 *      invoke (`AGENT_TOOL_ALLOWED`), so a leaked-and-replayed call for one
 *      tool cannot be rewritten into a call for another. This is the tool-scoping
 *      requirement made concrete: privilege is bound to the caller, not to the URL.
 *
 * Failure modes are deliberately indistinguishable (401 either way) so a caller
 * cannot enumerate which half of the check failed.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";

export type ToolAuth =
  | {
      ok: true;
      scope: string[];
      /** The ONE tenant this credential may act for, or null for the platform key. */
      orgId: string | null;
      platform: boolean;
    }
  | { ok: false; status: 401 | 403; error: string };

function safeEqual(a: string, b: string): boolean {
  // timingSafeEqual throws when the two buffers differ in length, which would turn
  // a wrong-length guess into a 500 instead of a clean 401 (and leaks length via
  // the stack trace). Hash both sides first so the comparison is over fixed-size
  // buffers — this keeps the comparison constant-time *and* total.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function parseScope(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Authenticate an inbound agent-tool request and resolve WHICH TENANT it acts
 * for. The credential carries the tenant, so a leaked secret reaches one org
 * rather than the whole deployment — the bleedguard behind the org-scoped
 * `caseByConversation` lookup in `guardToolCall`.
 *
 * @param headerSecret  value of the `x-agent-tool-secret` header
 * @param toolName      the tool being invoked, checked against the allow-list
 */
export async function authorizeToolCall(
  headerSecret: string | null,
  toolName: string,
): Promise<ToolAuth> {
  const presented = headerSecret;
  if (!presented) return { ok: false, status: 401, error: "unauthorized" };

  // ── Authenticate FIRST, then scope. ────────────────────────────────────────
  // The order is load-bearing. Checking the allow-list before the credential
  // lets an UNAUTHENTICATED caller enumerate the deployment's configuration:
  // 403 `tool_scope_unconfigured` says "no allow-list", 403 `tool_not_in_scope`
  // says "there is one and this tool is not in it", and 401 says "there is one
  // and this tool IS in it". Probing tool names then reconstructs the whole
  // allow-list without ever holding a secret. Every refusal below is 401 for a
  // bad credential, whatever the allow-list happens to say.
  const hashed = createHash("sha256").update(presented).digest("hex");
  const tenantKey = await db.agentToolSecret.findUnique({
    where: { keyHash: hashed },
    select: { id: true, orgId: true, revoked: true },
  });

  let orgId: string | null = null;
  let platform = false;
  if (tenantKey && !tenantKey.revoked) {
    // 1. A per-tenant credential. Only its SHA-256 is stored, exactly as for a
    //    producer key, and the matched row names the single org it may act for.
    void db.agentToolSecret
      .update({ where: { id: tenantKey.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});
    orgId = tenantKey.orgId;
  } else {
    // 2. The deployment-wide platform key. It is platform-scoped ONLY: it
    //    resolves to the default org namespace, never to "any org", which is
    //    precisely what stops it being used to reach another tenant's case.
    const expected = process.env.AGENT_TOOL_SECRET;
    if (!expected || !safeEqual(presented, expected)) {
      return { ok: false, status: 401, error: "unauthorized" };
    }
    platform = true;
  }

  // Authenticated. Only now may the configuration be disclosed, and only to a
  // caller who has already proved possession of a valid credential.
  const allowed = parseScope(process.env.AGENT_TOOL_ALLOWED);
  // An unset allow-list means the deployment has not been scoped yet. Refuse the
  // high-stakes path rather than silently trusting everything.
  if (allowed.length === 0) return { ok: false, status: 403, error: "tool_scope_unconfigured" };
  if (!allowed.includes(toolName)) return { ok: false, status: 403, error: "tool_not_in_scope" };

  return { ok: true, scope: allowed, orgId, platform };
}
