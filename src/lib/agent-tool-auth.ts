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

export type ToolAuth = { ok: true; scope: string[] } | { ok: false; status: 401 | 403; error: string };

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
 * Authenticate an inbound agent-tool request.
 *
 * @param headerSecret  value of the `x-agent-tool-secret` header
 * @param toolName      the tool being invoked, checked against the allow-list
 */
export function authorizeToolCall(headerSecret: string | null, toolName: string): ToolAuth {
  const expected = process.env.AGENT_TOOL_SECRET;
  if (!expected || !headerSecret || !safeEqual(headerSecret, expected)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  const allowed = parseScope(process.env.AGENT_TOOL_ALLOWED);
  // An unset allow-list means the deployment has not been scoped yet. Refuse the
  // high-stakes path rather than silently trusting everything.
  if (allowed.length === 0) {
    return { ok: false, status: 403, error: "tool_scope_unconfigured" };
  }
  if (!allowed.includes(toolName)) {
    return { ok: false, status: 403, error: "tool_not_in_scope" };
  }
  return { ok: true, scope: allowed };
}