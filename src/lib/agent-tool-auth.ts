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

/** The tool names a tenant credential may be scoped to. */
export const AGENT_TOOL_NAMES = [
  "card_freeze",
  "human_handoff",
  "switch_language",
  "verify_transaction",
  "warm_transfer",
  "signed_url",
] as const;

export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

type TenantSecret = {
  id: string;
  orgId: string;
  revoked: boolean;
  toolScope?: string | null;
};

/**
 * Unknown until the first credential lookup. Once a database reports that the
 * additive column is absent, every later lookup uses the legacy select: a
 * rolling deploy must not pay a failed query on every tool call (the tool
 * latency gate measures p95, and the extra round trip was visible there).
 *
 * ── But the NEGATIVE answer expires, and it used not to ─────────────────────
 *
 * The flag used to be pinned to `false` for the life of the process. The
 * moment ANY lookup in that process hit `P2022`, every later lookup — in
 * every worker, in every replica, for the rest of the deployment's uptime —
 * selected the credential WITHOUT `toolScope`, and `authorizeToolCall` then
 * skipped the per-credential scope check entirely. A credential scoped to
 * `card_freeze` could invoke `warm_transfer` or `signed_url` for as long as
 * the process lived, and the scoping column could be applied by a migration
 * without the running code ever noticing.
 *
 * A privilege boundary that can be silently switched off by a transient
 * schema error is not a boundary. So the negative answer is cached for a
 * SHORT time and then re-probed: the rolling deploy still gets its grace
 * period (a minute of legacy reads), and a process that outlives the
 * migration recovers on its own.
 */
let toolScopeSupported: boolean | null = null;

/** How long the "this column does not exist" answer is trusted. */
const TOOL_SCOPE_PROBE_TTL_MS = 60_000;
let toolScopeUnsupportedUntil = 0;

function isMissingToolScopeColumn(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  return (
    e?.code === "P2022" ||
    (typeof e?.message === "string" &&
      /toolScope/.test(e.message) &&
      /column|field/i.test(e.message))
  );
}

/**
 * Read the credential row, tolerating a database that has not applied the
 * `toolScope` migration yet. The fallback is deliberately not an error: an
 * additive column must not take every existing tenant tool offline on a
 * rolling deploy. Once the migration is applied, the scoped read is the only
 * path.
 */
async function findTenantSecret(hashed: string): Promise<TenantSecret | null> {
  if (toolScopeSupported === false && Date.now() < toolScopeUnsupportedUntil) {
    return db.agentToolSecret.findUnique({
      where: { keyHash: hashed },
      select: { id: true, orgId: true, revoked: true },
    });
  }
  try {
    const row = await db.agentToolSecret.findUnique({
      where: { keyHash: hashed },
      select: { id: true, orgId: true, revoked: true, toolScope: true },
    });
    toolScopeSupported = true;
    toolScopeUnsupportedUntil = 0;
    return row;
  } catch (err) {
    if (!isMissingToolScopeColumn(err)) throw err;
    // The column is missing RIGHT NOW. Cache the answer for a minute — long
    // enough to cover a rolling deploy, short enough that the process
    // recovers by itself once the migration lands.
    toolScopeSupported = false;
    toolScopeUnsupportedUntil = Date.now() + TOOL_SCOPE_PROBE_TTL_MS;
    return db.agentToolSecret.findUnique({
      where: { keyHash: hashed },
      select: { id: true, orgId: true, revoked: true },
    });
  }
}

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
  let tenantKey: TenantSecret | null;
  try {
    tenantKey = await findTenantSecret(hashed);
  } catch {
    // A credential lookup fault is an authentication failure, not a 500, and
    // it must never fall through to the platform-secret branch.
    return { ok: false, status: 401, error: "unauthorized" };
  }

  let orgId: string | null = null;
  let platform = false;
  if (tenantKey && !tenantKey.revoked) {
    // 1. A per-tenant credential. Only its SHA-256 is stored, exactly as for a
    //    producer key, and the matched row names the single org it may act for.
    void db.agentToolSecret
      .update({
        where: { id: tenantKey.id },
        data: { lastUsedAt: new Date() },
        select: { id: true },
      })
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

  // A tenant credential may narrow the deployment allow-list further. A missing
  // scope is the legacy shape (all allow-listed tools); a present-but-empty
  // scope is a malformed credential and is refused rather than widened.
  if (tenantKey?.toolScope !== undefined && tenantKey.toolScope !== null) {
    const tenantScope = parseScope(tenantKey.toolScope);
    if (tenantScope.length === 0) {
      return { ok: false, status: 403, error: "tool_not_in_scope" };
    }
    if (!tenantScope.includes(toolName)) {
      return { ok: false, status: 403, error: "tool_not_in_scope" };
    }
  }

  return { ok: true, scope: allowed, orgId, platform };
}
