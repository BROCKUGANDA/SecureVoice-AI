import "server-only";

/**
 * THE SECOND KNOWLEDGE PLANE — the bank's own policy document, handed to the
 * ElevenLabs agent itself.
 *
 * Why a second plane exists at all: `vectorizeDocument` embeds an uploaded PDF into
 * Pinecone and `searchDocuments` grounds a live draft from there (`src/lib/llm.ts`).
 * That makes the policy's CONTENT reachable — through our retriever, on our turn.
 * The platform agent runs its OWN retrieval:
 * `conversation_config.agent.prompt.knowledge_base` + `.rag`, which today holds the
 * two shipped disposition-policy documents declared in
 * `agent/securevoice.agent.yaml` and applied by `scripts/agent-apply.ts`. Uploading
 * a policy into plane one changes nothing in plane two, so on the call the agent
 * still cites the platform's generic policy rather than the bank's. This module
 * publishes the same text there.
 *
 * Four rules, every one inherited from the code this fits into:
 *
 *  1. **Off unless configured.** `KB_PLATFORM_SYNC=true` plus an agent to attach
 *     to. Without the flag this module is never reached, writes no row, and the
 *     deployment behaves exactly as it did before it existed. With the flag and no
 *     agent id or no key the attempt is REFUSED *and recorded* — half-configured is
 *     the worst state, which is the same reasoning `qstashConfigured()` follows.
 *  2. **Idempotent from the row, not from the vendor.** `Document.platformDocId` is
 *     the anchor: create once, then PATCH the document it names. A QStash retry or
 *     an operator Retry must never stack a second copy of one policy onto a shared
 *     agent.
 *  3. **A platform failure is not a RAG failure.** The tenant's vectors are already
 *     written and correct, so this path reports on its own columns (`platformError`)
 *     and never touches `status` — but it is not silent either: row, audit chain and
 *     `logWarn`, the same three places `vectorizeDocument` records a failure.
 *  4. **Merge, never write over.** The agent PATCH is built from the LIVE config,
 *     read back first, and only appends. The two shipped documents are never
 *     replaced, our own entry is never added twice, and the write is verified by a
 *     second read because a 200 on PATCH does not prove persistence — the rule
 *     `scripts/agent-apply.ts` already refuses to break.
 *
 * Egress goes through `src/lib/elevenlabs/egress.ts`, the only code in this repo
 * that opens a socket to ElevenLabs, so the throttle, the breaker, the monthly
 * budget and the commercial-use attestation cover a document publish like any
 * other vendor call.
 */

import { db } from "@/lib/db";
import { env } from "@/lib/config";
import { append as auditAppend } from "@/lib/audit-chain";
import { decryptSecret } from "@/lib/byok";
import { elevenLabsFetch, type EgressError } from "@/lib/elevenlabs/egress";
import { withTenantScope } from "@/lib/tenancy/db-scope";
import { logWarn, sanitiseLogString } from "@/lib/validation/safe-log";

export type PlatformKbResult =
  /** The plane is off: nothing was called and nothing was written. */
  | { attempted: false; reason: "disabled" }
  | {
      attempted: true;
      ok: true;
      platformDocId: string;
      action: "created" | "updated";
      /** True when the agent's live `knowledge_base` now lists this document. */
      attached: boolean;
    }
  | { attempted: true; ok: false; error: string };

export type PlatformKbInput = {
  documentId: string;
  /** Tenant scope. Required and non-empty: an unscoped publish is unrepresentable. */
  orgId: string;
  title: string;
  lang: string;
  /** The platform document already published for THIS row, or null. */
  platformDocId: string | null;
  /** The text the chunker was built from — never a second parse of the PDF. */
  text: string;
};

/** Vendor-side name ceiling; the platform lists documents by name in its console. */
const MAX_NAME_CHARS = 200;

/** The text a scrubbed document is left holding: no policy, legible in a vendor console. */
const REVOKED_CONTENT =
  "This document has been revoked by the institution that uploaded it. It is retained only as a placeholder and holds no policy text.";

/**
 * The prompt keys an agent PATCH accepts, in WIRE form.
 *
 * `@elevenlabs/elevenlabs-js` declares the SAME field set for
 * `PromptAgentApiModelInput` and `PromptAgentApiModelOutput`, which is what makes the
 * merge below expressible without guessing: every key the GET can return is a key the
 * PATCH accepts, so the live prompt is echoed back key-for-key and only
 * `knowledge_base` changes. Echoing (rather than sending `knowledge_base` alone) is
 * the defensive half: if the platform treats `prompt` as replace-on-write, the
 * system prompt, the tools and the RAG settings survive it either way.
 */
const LIVE_PROMPT_FIELDS = [
  "prompt",
  "llm",
  "reasoning_effort",
  "thinking_budget",
  "enable_reasoning_summary",
  "temperature",
  "max_tokens",
  "tool_ids",
  "built_in_tools",
  "enable_parallel_tool_calls",
  "mcp_server_ids",
  "native_mcp_server_ids",
  "custom_llm",
  "ignore_default_personality",
  "rag",
  "timezone",
  "backup_llm_config",
  "cascade_timeout_seconds",
  "tools",
] as const;

type KbLocator = { type?: string; name?: string; id?: string };
type LivePrompt = Record<string, unknown> & { knowledge_base?: unknown };
type AgentSnapshot = {
  conversation_config?: { agent?: { prompt?: LivePrompt } };
};

/** Where a tenant's document is published: which agent, with which credential. */
type PlatformTarget = {
  agentId: string;
  apiKey: string | null;
  /** `org` = the tenant's own bound agent; `platform` = the deployment default. */
  via: "org" | "platform";
};

/**
 * The same normalised view `chunkText` produces, without the windowing.
 *
 * Publishing `chunks.join("\n\n")` instead would repeat every overlap window twice
 * inside one document, so the agent would read the bank's obligations back with
 * sentences duplicated — and duplication in a retrieved passage is how a model
 * starts treating a fragment as the important part.
 */
function normaliseText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * `[org fragment] title (lang)`.
 *
 * The org fragment is not decoration: several tenants' documents end up listed
 * side by side in one vendor console and one agent's `knowledge_base`, and a title
 * like "Refund Policy" is not an owner. It is a fragment rather than the full id
 * because the name is vendor-visible text; the row and the audit chain hold the
 * whole id.
 */
function platformDocName(input: PlatformKbInput): string {
  const org = sanitiseLogString(input.orgId, 8);
  const title = sanitiseLogString(input.title, MAX_NAME_CHARS - 24) || "Policy document";
  return `[${org}] ${title} (${input.lang})`.slice(0, MAX_NAME_CHARS);
}

/**
 * Strip any credential this deployment (or this tenant) issued, out of vendor text
 * before it becomes a durable row value, audit entry or log line.
 *
 * Not paranoia: the reason the egress guard hands back is the vendor's own response
 * body, and an authentication failure is exactly the error that quotes the key it was
 * given. This module writes that reason into `Document.platformError`, into the audit
 * chain and into `logWarn`, and the first of those is read back by a tenant's console.
 * "Never print a secret" therefore cannot rest on a guess about what the vendor puts in
 * an error message.
 */
function withoutCredential(text: string, apiKey?: string | null): string {
  let out = text;
  for (const secret of [env.elevenLabsApiKey, apiKey]) {
    const value = (secret ?? "").trim();
    // Under 8 characters there is nothing to distinguish from ordinary text, and a
    // substring this short would eat real words out of the reason.
    if (value.length >= 8) out = out.split(value).join("[redacted]");
  }
  return out;
}

/** One-line, bounded, secret-free description of a guard or vendor refusal. */
function describeError(error: EgressError, apiKey?: string | null): string {
  return sanitiseLogString(withoutCredential(`status=${error.status} ${error.body}`, apiKey), 220);
}

/**
 * The agent a tenant's document may be attached to, and the credential that may
 * address it.
 *
 * The tenant's OWN binding first (`Organization.elevenAgentId`, the same field the
 * inbound bleedguard resolves a call back through), and only then the deployment
 * default `ELEVENLABS_AGENT_ID` — which is what `src/lib/elevenlabs/outbound-call.ts`
 * dials for every tenant. HAZARD, stated rather than assumed away: on a deployment
 * that hosts several tenants on that one default agent, each tenant's policy becomes
 * retrievable on the others' calls. Such a deployment must bind an agent per
 * organisation; the fallback is correct for exactly one kind of deployment, the one
 * where the platform agent has one tenant.
 *
 * The key PAIRS with the agent, which is the part that cannot be got wrong quietly: a
 * tenant's own agent lives in the tenant's ElevenLabs account, so it is addressed with
 * the tenant's sealed BYOK key (`Organization.elevenKeyEnc`), and the platform default
 * is addressed with the platform key. Sending the platform credential at a tenant's
 * agent is a 401 that would read like a vendor fault; sending a tenant's credential at
 * the platform agent would be a cross-account write. `decryptSecret` returns null
 * rather than throwing when nothing can be unsealed, and then the platform credential
 * is used only because the agent is the platform's own.
 */
async function resolveTarget(orgId: string): Promise<PlatformTarget | null> {
  const org = await db.organization
    .findUnique({
      where: { id: orgId },
      select: { elevenAgentId: true, elevenKeyEnc: true },
    })
    .catch(() => null);

  const ownAgent = (org?.elevenAgentId ?? "").trim();
  const agentId = ownAgent || (env.elevenLabsAgentId ?? "").trim();
  if (!agentId) return null;

  const byok = ownAgent ? decryptSecret(org?.elevenKeyEnc ?? "") : null;
  const apiKey = byok || env.elevenLabsApiKey || null;
  return { agentId, apiKey, via: ownAgent ? "org" : "platform" };
}

/**
 * Write the platform columns, tenant-scoped. Returns whether the write landed.
 *
 * A `false` is not uniformly fatal, and the two cases differ by what the row is for.
 * Losing the `platformDocId` anchor IS fatal to the publish, because the anchor is the
 * only thing standing between a retry and a second copy of one policy on the vendor.
 * Losing the final "clear `platformError`" write is not: the document is published and
 * attached, the anchor already landed, and all that survives is a stale reason the next
 * successful run replaces. Both are logged, because a column that silently fails to
 * write is how an operator ends up trusting the wrong answer.
 */
async function recordOnRow(
  orgId: string,
  documentId: string,
  data: { platformDocId?: string; platformError?: string | null },
): Promise<boolean> {
  if (!orgId.trim()) return false;
  try {
    await withTenantScope(orgId, (tx) => tx.document.update({ where: { id: documentId }, data }));
    return true;
  } catch (err) {
    logWarn("[knowledge] platform knowledge-base outcome could not be recorded on the row", {
      documentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Serialise agent writes in this process.
 *
 * Two tenants finishing at once would otherwise both GET the same agent, both see
 * the same two documents, and both PATCH — the later write silently deleting the
 * earlier tenant's attachment. A per-process tail queue is the same control
 * `src/lib/audit-chain.ts` uses for the same read-modify-write shape; a multi-replica
 * deployment still has the vendor's own last-write-wins to race, which is why the
 * PATCH is followed by a read-back rather than trusted.
 */
let agentWriteTail: Promise<unknown> = Promise.resolve();
function withAgentWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = agentWriteTail.then(fn, fn);
  agentWriteTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Attach one document to one agent, by merging into its live configuration.
 *
 * Never a bare `{ knowledge_base: [ours] }`: that is the shape of a writer that
 * deletes whatever it did not read.
 */
async function attachToAgent(
  target: PlatformTarget,
  entry: KbLocator,
  orgId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const callerId = `knowledge:${orgId}`;
  const path = `/v1/convai/agents/${encodeURIComponent(target.agentId)}`;

  const live = await elevenLabsFetch<AgentSnapshot>({
    path,
    method: "GET",
    billableChars: 0,
    apiKey: target.apiKey ?? undefined,
    callerId,
  });
  if (!live.ok)
    return { ok: false, error: `agent_read_failed: ${describeError(live.error, target.apiKey)}` };

  const prompt = live.data?.conversation_config?.agent?.prompt;
  if (!prompt || typeof prompt !== "object") {
    // Refuse rather than guess. A PATCH built on an unreadable prompt is a PATCH
    // that could erase the system prompt, the tools or the two shipped documents.
    return { ok: false, error: "agent_prompt_unreadable" };
  }

  const current: KbLocator[] = Array.isArray(prompt.knowledge_base)
    ? (prompt.knowledge_base as KbLocator[])
    : [];
  if (current.some((d) => d && typeof d === "object" && d.id === entry.id)) {
    // Already attached. Returning without a PATCH is what makes a retry of a retry
    // cost nothing, and it leaves the live ordering untouched.
    return { ok: true };
  }

  const mergedPrompt: Record<string, unknown> = {};
  for (const key of LIVE_PROMPT_FIELDS) {
    if (prompt[key] !== undefined) mergedPrompt[key] = prompt[key];
  }
  mergedPrompt.knowledge_base = [...current, entry];

  const patched = await elevenLabsFetch({
    path,
    method: "PATCH",
    body: { conversation_config: { agent: { prompt: mergedPrompt } } },
    billableChars: 0,
    apiKey: target.apiKey ?? undefined,
    callerId,
  });
  if (!patched.ok) {
    return {
      ok: false,
      error: `agent_patch_failed: ${describeError(patched.error, target.apiKey)}`,
    };
  }

  const back = await elevenLabsFetch<AgentSnapshot>({
    path,
    method: "GET",
    billableChars: 0,
    apiKey: target.apiKey ?? undefined,
    callerId,
  });
  if (!back.ok) {
    return {
      ok: false,
      error: `agent_read_back_failed: ${describeError(back.error, target.apiKey)}`,
    };
  }
  const listed = Array.isArray(back.data?.conversation_config?.agent?.prompt?.knowledge_base)
    ? (back.data.conversation_config!.agent!.prompt!.knowledge_base as KbLocator[])
    : [];
  if (!listed.some((d) => d && typeof d === "object" && d.id === entry.id)) {
    return { ok: false, error: "agent_kb_not_persisted" };
  }
  return { ok: true };
}

/**
 * Erase one published document from the platform: wipe its content, then detach it.
 *
 * Not gated on `KB_PLATFORM_SYNC`. The row's anchor is the evidence that a document
 * exists on the vendor, and a deployment that has since switched the plane off must
 * still be able to erase what it published while it was on — an erasure request that
 * quietly no-ops because of a flag is the failure mode this whole module is written
 * against.
 *
 * ORDER: the content is scrubbed FIRST, because that is the moment the tenant's
 * policy stops being quotable on a call. Detaching the reference is tidiness after
 * that, so a detach failure is reported and logged but does not keep the row alive
 * for another erasure attempt that would change nothing.
 *
 * WHY scrub-and-detach rather than `DELETE /v1/convai/knowledge-base/{id}`: that
 * endpoint exists, but `elevenLabsFetch` — the one guarded socket this repo allows —
 * accepts GET/POST/PATCH/PUT only. Widening the shared egress core for an optional
 * step here would put the TTS, STT and dial paths in this change's blast radius, so
 * the document is neutralised in place instead and the vendor's own snapshot/apply
 * (`scripts/agent-apply.ts`) re-asserts the shipped list. The residual is a
 * zero-content shell with a tenant's name on it, which is a cleanup task, not a leak.
 */
export async function removeDocumentFromPlatformKb(input: {
  documentId: string;
  orgId: string;
  platformDocId: string;
}): Promise<{ ok: true; detached: boolean } | { ok: false; error: string }> {
  if (!input.orgId.trim()) return { ok: false, error: "org_id_required" };
  const callerId = `knowledge:${input.orgId}`;
  const target = await resolveTarget(input.orgId);
  if (!target) return { ok: false, error: "agent_not_configured" };

  const scrubbed = await elevenLabsFetch({
    path: `/v1/convai/knowledge-base/${encodeURIComponent(input.platformDocId)}`,
    method: "PATCH",
    body: { name: `revoked — ${input.documentId}`, content: REVOKED_CONTENT },
    billableChars: 0,
    apiKey: target.apiKey ?? undefined,
    callerId,
  });
  if (!scrubbed.ok) {
    return {
      ok: false,
      error: `platform_doc_scrub_failed: ${describeError(scrubbed.error, target.apiKey)}`,
    };
  }

  let detached = false;
  let detachError: string | null = null;
  const result = await withAgentWriteLock(() =>
    detachFromAgent(target, input.platformDocId, input.orgId),
  );
  if (result.ok) detached = true;
  else detachError = result.error;

  await auditAppend({
    callRef: `DOC-${input.documentId.slice(0, 24)}`,
    action: "consent",
    intent: "document_platform_kb_erased",
    callerId: "system-knowledge",
    orgId: input.orgId,
    redactedText: `platform knowledge-base document erased (${input.platformDocId})`,
    meta: { agentId: target.agentId, via: target.via, detached, error: detachError },
  }).catch(() => {});

  if (!detached) {
    logWarn("[knowledge] platform document content was erased but the agent reference remains", {
      documentId: input.documentId,
      platformDocId: input.platformDocId,
      error: detachError ?? "unknown",
    });
  }
  return { ok: true, detached };
}

/**
 * Remove one document id from an agent's live `knowledge_base`, leaving every other
 * entry exactly as it was found.
 *
 * Same read-merge-write-and-read-back discipline as the publish path: the two shipped
 * policy documents belong to the deployment, not to this tenant, and a delete of one
 * tenant's document must never be the reason they disappear.
 */
async function detachFromAgent(
  target: PlatformTarget,
  platformDocId: string,
  orgId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const callerId = `knowledge:${orgId}`;
  const apiKey = target.apiKey ?? undefined;
  const path = `/v1/convai/agents/${encodeURIComponent(target.agentId)}`;

  const live = await elevenLabsFetch<AgentSnapshot>({
    path,
    method: "GET",
    billableChars: 0,
    apiKey,
    callerId,
  });
  if (!live.ok)
    return { ok: false, error: `agent_read_failed: ${describeError(live.error, target.apiKey)}` };
  const prompt = live.data?.conversation_config?.agent?.prompt;
  if (!prompt || typeof prompt !== "object") return { ok: false, error: "agent_prompt_unreadable" };

  const current: KbLocator[] = Array.isArray(prompt.knowledge_base)
    ? (prompt.knowledge_base as KbLocator[])
    : [];
  const kept = current.filter((d) => !d || typeof d !== "object" || d.id !== platformDocId);
  if (kept.length === current.length) return { ok: true };

  const mergedPrompt: Record<string, unknown> = {};
  for (const key of LIVE_PROMPT_FIELDS) {
    if (prompt[key] !== undefined) mergedPrompt[key] = prompt[key];
  }
  mergedPrompt.knowledge_base = kept;

  const patched = await elevenLabsFetch({
    path,
    method: "PATCH",
    body: { conversation_config: { agent: { prompt: mergedPrompt } } },
    billableChars: 0,
    apiKey,
    callerId,
  });
  if (!patched.ok)
    return {
      ok: false,
      error: `agent_patch_failed: ${describeError(patched.error, target.apiKey)}`,
    };

  const back = await elevenLabsFetch<AgentSnapshot>({
    path,
    method: "GET",
    billableChars: 0,
    apiKey,
    callerId,
  });
  if (!back.ok)
    return {
      ok: false,
      error: `agent_read_back_failed: ${describeError(back.error, target.apiKey)}`,
    };
  const listed = Array.isArray(back.data?.conversation_config?.agent?.prompt?.knowledge_base)
    ? (back.data.conversation_config!.agent!.prompt!.knowledge_base as KbLocator[])
    : [];
  if (listed.some((d) => d && typeof d === "object" && d.id === platformDocId)) {
    return { ok: false, error: "agent_kb_still_lists_document" };
  }
  return { ok: true };
}

/**
 * Publish one READY tenant document into the agent's own knowledge base.
 *
 * Returns rather than throws: the caller has just finished writing the tenant's
 * vectors, and those are not this function's to undo.
 */
export async function syncDocumentToPlatformKb(input: PlatformKbInput): Promise<PlatformKbResult> {
  if (!env.kbPlatformSync) return { attempted: false, reason: "disabled" };

  const fail = async (error: string): Promise<PlatformKbResult> => {
    const reason = error.slice(0, 500);
    await recordOnRow(input.orgId, input.documentId, { platformError: reason });
    await auditAppend({
      callRef: `DOC-${input.documentId.slice(0, 24)}`,
      action: "agent",
      intent: "document_platform_kb_failed",
      callerId: "system-knowledge",
      orgId: input.orgId,
      redactedText: `platform knowledge-base publish failed for "${input.title}": ${reason.slice(0, 120)}`,
      meta: { error: reason.slice(0, 200) },
    }).catch(() => {});
    logWarn("[knowledge] platform knowledge-base publish failed", {
      documentId: input.documentId,
      orgId: input.orgId,
      error: reason.slice(0, 200),
    });
    return { attempted: true, ok: false, error: reason };
  };

  if (!input.orgId.trim()) return fail("org_id_required");

  const target = await resolveTarget(input.orgId);
  if (!target) return fail("agent_not_configured");
  if (!target.apiKey) return fail("elevenlabs_key_missing");
  const apiKey = target.apiKey;

  const text = normaliseText(input.text);
  if (!text) return fail("no_text_for_platform");

  const ceiling = env.kbPlatformMaxChars;
  if (text.length > ceiling) {
    return fail(`text_too_large: ${text.length} chars over the ${ceiling} char ceiling`);
  }

  const name = platformDocName(input);
  const callerId = `knowledge:${input.orgId}`;
  const existing = (input.platformDocId ?? "").trim();

  let platformDocId = existing;
  let action: "created" | "updated" = "updated";

  if (platformDocId) {
    const updated = await elevenLabsFetch({
      path: `/v1/convai/knowledge-base/${encodeURIComponent(platformDocId)}`,
      method: "PATCH",
      body: { name, content: text },
      billableChars: 0,
      apiKey,
      callerId,
    });
    if (!updated.ok) {
      return fail(`platform_doc_update_failed: ${describeError(updated.error, apiKey)}`);
    }
  } else {
    const created = await elevenLabsFetch<{ id?: string }>({
      path: "/v1/convai/knowledge-base/text",
      method: "POST",
      body: { text, name },
      billableChars: 0,
      apiKey,
      callerId,
    });
    if (!created.ok) {
      return fail(`platform_doc_create_failed: ${describeError(created.error, apiKey)}`);
    }
    platformDocId = (created.data?.id ?? "").trim();
    if (!platformDocId) return fail("platform_doc_create_returned_no_id");
    action = "created";
    // Persisted BEFORE the agent write on purpose: if the process dies between the
    // create and the attach, the next attempt finds this id and PATCHes instead of
    // POSTing a second copy of the same policy.
    //
    // And a row that cannot be written IS a failure, not a detail: the id lives only
    // there, so an unrecorded anchor is a guaranteed duplicate on the next retry —
    // and a duplicate policy document on a shared agent is exactly what this column
    // exists to prevent. The reason carries the id so an operator can restore it.
    const anchored = await recordOnRow(input.orgId, input.documentId, { platformDocId });
    if (!anchored) {
      return fail(
        `platform_doc_anchor_unrecorded: created ${platformDocId} but the document row ` +
          "could not be written — record that id on the row or the next retry duplicates it",
      );
    }
  }

  const attach = await withAgentWriteLock(() =>
    attachToAgent(target, { type: "text", name, id: platformDocId }, input.orgId),
  );
  if (!attach.ok) return fail(`agent_attach_failed: ${attach.error}`);

  await recordOnRow(input.orgId, input.documentId, {
    platformDocId,
    platformError: null,
  });
  await auditAppend({
    callRef: `DOC-${input.documentId.slice(0, 24)}`,
    action: "agent",
    intent: "document_platform_kb_published",
    callerId: "system-knowledge",
    orgId: input.orgId,
    redactedText: `platform knowledge-base document published for "${input.title}"`,
    meta: { agentId: target.agentId, via: target.via, action, platformDocId, chars: text.length },
  }).catch(() => {});

  return { attempted: true, ok: true, platformDocId, action, attached: true };
}
