import "server-only";
/**
 * The moderation orchestrator — the ONE function every content boundary calls.
 *
 * ── The security model ────────────────────────────────────────────────────────
 *
 * Qwen3Guard is a CLASSIFIER, not an authority. This module's contract with
 * the rest of the platform is stated here because every call site depends on
 * it:
 *
 *   1. A `safe` verdict from this module authorises NOTHING. It only says the
 *      model layer found no violation. The deterministic guards
 *      (`llm-guard.ts`, `compliance/policy.ts`, `speech-gate.ts`,
 *      `tool-guard.ts`) run regardless of what this returns, and the tool
 *      authorization check is a separate, independent mechanism.
 *   2. An `unsafe` or `controversial` verdict is advisory-to-refuse for the
 *      calling boundary: conversation paths fall back to their scripted safe
 *      reply, speech is not synthesised, high-risk tool arguments are refused.
 *   3. Any non-model outcome — model unavailable, unreadable output, kill
 *      switch engaged, flag off — is NEVER reported as `safe`. It is reported
 *      as its own `source` with verdict `invalid`-adjacent semantics (see
 *      `ModerationOutcome.source`), and the calling boundary applies its own
 *      failure policy (degraded vs fail-closed). "The classifier had an
 *      outage" must never be indistinguishable from "the classifier said
 *      Safe".
 *   4. Every decision is persisted (`ModerationRequest`) and every decision
 *      records a span (`moderation_check`), with the caller's correlation IDs
 *      attached, so the STT → moderation → LLM → tools → TTS chain is
 *      reconstructible from evidence alone.
 *
 * ── Cost and latency discipline ──────────────────────────────────────────────
 *
 * Content is cached on (model, templateVersion, stage, policy version,
 * content hash) — all five, because a verdict is a function of all of them
 * and a cache key missing any one is a stale-verdict bug. The cache is
 * bounded (LRU, 512 entries, TTL from config) so a hot phrase cannot grow it
 * without limit and a policy change invalidates by version rather than by
 * hoping entries expire.
 */

import { createHash } from "node:crypto";
import { env } from "@/lib/config";
import { flag } from "@/lib/flags";
import { db } from "@/lib/db";
import { logError, logInfo, logWarn } from "@/lib/validation/safe-log";
import { recordSpanAndPersist } from "@/lib/telemetry/store";
import { classify, moderationBreakerState } from "./client";
import {
  DEFAULT_MODERATION_MODEL,
  TEMPLATE_VERSION,
  buildModerationMessages,
  describeStage,
  parseVerdict,
  type ModerationStage,
  type ModerationVerdict,
  type SafetyVerdict,
} from "./template";

/* ── Kill switch (env brake + operator DB switch) ────────────────────────── */

export const MODERATION_KILL_SWITCH_ENV = "MODERATION_KILL_SWITCH";
export const MODERATION_KILL_SWITCH_NAME = "moderation_kill_switch";

export function moderationKillSwitchEnvEngaged(): boolean {
  return process.env[MODERATION_KILL_SWITCH_ENV] === "true";
}

let cachedSwitch: { engaged: boolean; readAt: number; available: boolean } | null = null;
let switchReadFailureLogged = false;

/**
 * Metering sequence, one per `finish()`. Only used when the caller did not
 * supply a traceId: the evidence row is one-per-invocation (no dedupe key),
 * so the metering row is too — otherwise two turns moderating the same
 * phrase would collapse into one metered row and usage would undercount
 * exactly on the high-frequency path.
 */
let meterSeq = 0;

function switchCacheMs(): number {
  return env.breakerOpenMs > 0 ? Math.min(5_000, env.breakerOpenMs) : 5_000;
}

/**
 * The operator brake, read like the dial kill switch: cached briefly, and —
 * when the row CANNOT be read — treated as ENGAGED, because a brake that
 * fails silently is not a brake.
 */
export async function moderationKillSwitchDbState(): Promise<{
  engaged: boolean;
  available: boolean;
}> {
  const now = Date.now();
  if (cachedSwitch && now - cachedSwitch.readAt < switchCacheMs()) {
    return { engaged: cachedSwitch.engaged, available: cachedSwitch.available };
  }
  try {
    const row = await db.platformSwitch.findUnique({
      where: { name: MODERATION_KILL_SWITCH_NAME },
      select: { engaged: true },
    });
    const engaged = row?.engaged === true;
    cachedSwitch = { engaged, readAt: now, available: true };
    if (switchReadFailureLogged) {
      switchReadFailureLogged = false;
      logInfo("[moderation] the kill switch is readable again", { engaged });
    }
    return { engaged, available: true };
  } catch (err) {
    cachedSwitch = { engaged: true, readAt: now, available: false };
    if (!switchReadFailureLogged) {
      switchReadFailureLogged = true;
      logError("[moderation] could not read the kill switch; treating it as ENGAGED", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { engaged: true, available: false };
  }
}

/** Engage/release the operator brake. Console-only. */
export async function setModerationKillSwitch(engaged: boolean, actor: string): Promise<void> {
  await db.platformSwitch.upsert({
    where: { name: MODERATION_KILL_SWITCH_NAME },
    create: { name: MODERATION_KILL_SWITCH_NAME, engaged, reason: "operator toggle", actor },
    update: { engaged, reason: "operator toggle", actor },
  });
  cachedSwitch = null;
}

/* ── Verdict cache ───────────────────────────────────────────────────────── */

type CacheEntry = { verdict: ModerationVerdict; at: number };

const CACHE_LIMIT = 512;
const verdictCache = new Map<string, CacheEntry>();

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function cacheKey(args: {
  stage: ModerationStage;
  text: string;
  policyVersion: number | null;
}): string {
  return [
    env.qwen3guardModel,
    TEMPLATE_VERSION,
    args.stage,
    args.policyVersion ?? 0,
    contentHash(args.text),
  ].join("|");
}

export function clearModerationCacheForTests(): void {
  verdictCache.clear();
}

/* ── Outcome ─────────────────────────────────────────────────────────────── */

/**
 * Where the outcome came from. `model` is the only source that can produce a
 * `safe` verdict; every other source exists so callers can distinguish "the
 * classifier said Safe" from "the classifier was not consulted".
 */
export type ModerationSource =
  "model" | "invalid" | "degraded" | "kill_switch" | "flag_off" | "quota";

export type ModerationOutcome = {
  /** `safe` ONLY when `source === "model"` and the model said Safe. */
  verdict: SafetyVerdict;
  /** Official category names; empty unless the model named them. */
  categories: string[];
  /** Response moderation only: the draft was itself a refusal. */
  refusal: boolean;
  source: ModerationSource;
  stage: ModerationStage;
  model: string;
  templateVersion: string;
  latencyMs: number;
  /** sha256 of the exact classified content — the cache/dedupe identity. */
  inputHash: string;
  /** Present when the classifier was consulted and answered. */
  parsed?: ModerationVerdict;
  /** Present when the model layer did NOT answer. */
  reason?: string;
  /** Evidence row id — set when persistence was awaited (`persist: "await"`). */
  id?: string;
};

/** What callers consult: "may this content proceed?" — `true` only for a real
 *  model Safe, because everything else is an unresolved safety question. */
export function outcomeIsClean(outcome: ModerationOutcome): boolean {
  return outcome.source === "model" && outcome.verdict === "safe";
}

/* ── The entry point ─────────────────────────────────────────────────────── */

export type ModerateInput = {
  stage: ModerationStage;
  text: string;
  /** The user utterance, for output-stage response moderation context. */
  userText?: string;
  orgId?: string | null;
  caseRef?: string | null;
  conversationId?: string | null;
  traceId?: string | null;
  /**
   * Evidence-row persistence discipline. `background` (default) fires the
   * write and never delays the caller — the hot conversation path. `await`
   * resolves the row before returning so an API caller receives the id to
   * poll — the /v1/moderation contract.
   */
  persist?: "await" | "background";
};

/**
 * Classify content at a lifecycle boundary. NEVER THROWS: a moderation layer
 * that can crash a call is worse than no moderation layer, and every failure
 * is expressible as an outcome with `source !== "model"`.
 *
 * The `degraded` verdict is `invalid`, not `safe` — callers consult
 * `outcomeIsClean()` and apply their own failure mode
 * (`QWEN3GUARD_FAILURE_MODE`): conversation paths proceed on their
 * deterministic guards; high-risk tools and TTS fail closed.
 */
export async function moderateContent(args: ModerateInput): Promise<ModerationOutcome> {
  const startedAtMs = Date.now();
  const text = args.text ?? "";
  const inputHash = contentHash(text);
  const model = env.qwen3guardModel || DEFAULT_MODERATION_MODEL;

  const base = {
    verdict: "invalid" as SafetyVerdict,
    categories: [] as string[],
    refusal: false,
    stage: args.stage,
    model,
    templateVersion: TEMPLATE_VERSION,
    startedAtMs,
    inputHash,
  };

  // 1. Flag off — recorded, never silent, never "safe".
  if (!flag("qwen3guard")) {
    return finish({ ...base, source: "flag_off", reason: "feature flag off" }, args);
  }

  // 2. Kill switch — the operator brake outranks the flag.
  if (moderationKillSwitchEnvEngaged()) {
    return finish({ ...base, source: "kill_switch", reason: "env kill switch engaged" }, args);
  }
  const sw = await moderationKillSwitchDbState();
  if (sw.engaged) {
    return finish(
      {
        ...base,
        source: "kill_switch",
        reason: sw.available
          ? "operator kill switch engaged"
          : "kill switch unreadable; failing safe",
      },
      args,
    );
  }

  if (!text.trim()) {
    // Empty content has nothing to classify; callers already treat empty as
    // "do not speak / do not send". Record as invalid-source for the trail.
    return finish({ ...base, source: "invalid", reason: "empty content" }, args);
  }

  // 3. Policy version — part of the cache key so a policy change invalidates.
  const policyVersion = await loadPolicyVersion(args.orgId ?? null);
  const key = cacheKey({ stage: args.stage, text, policyVersion });
  const cached = verdictCache.get(key);
  if (cached && Date.now() - cached.at < env.qwen3guardCacheTtlMs) {
    // Refresh LRU order.
    verdictCache.delete(key);
    verdictCache.set(key, cached);
    return finish(
      {
        verdict: cached.verdict.verdict,
        categories: cached.verdict.categories,
        refusal: cached.verdict.refusal,
        source: "model",
        stage: args.stage,
        model,
        templateVersion: TEMPLATE_VERSION,
        latencyMs: Date.now() - startedAtMs,
        startedAtMs,
        inputHash,
        parsed: cached.verdict,
      },
      args,
      // A cache replay is not a model call: the classification that filled
      // the cache was metered when it ran. Metering per replay would charge
      // a hot phrase once per turn.
      { cached: true, modelCalled: false },
    );
  }

  // 4. Tenant quota — gates the billable step, so it sits AFTER the
  //    cache lookup (cached verdicts spend nothing) and BEFORE the gateway
  //    call. 0 = unlimited. The denial reuses the degraded semantics:
  //    verdict stays non-Safe, so high-risk tool calls refuse exactly as they
  //    do on a gateway outage; the evidence row is still recorded, so quota
  //    denials are auditable rather than invisible. Counts evidence rows
  //    (indexed by [orgId, createdAt]) for the UTC day; org-less moderation
  //    (platform surfaces) is unattributable and unquota'd, by design.
  const quota = env.qwen3guardDailyCallsPerTenant;
  if (quota > 0 && args.orgId) {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const used = await db.moderationRequest
      .count({ where: { orgId: args.orgId, createdAt: { gte: dayStart } } })
      .catch(() => 0);
    if (used >= quota) {
      return finish(
        { ...base, source: "quota", reason: `tenant daily moderation quota (${quota}) exceeded` },
        args,
      );
    }
  }

  // 5. The model.
  const messages = buildModerationMessages(args.stage, text, { userText: args.userText });
  try {
    const result = await classify(messages);
    const parsed = parseVerdict(result.text);
    const outcome: ModerationOutcome & { startedAtMs: number } = {
      verdict: parsed.verdict,
      categories: parsed.categories,
      refusal: parsed.refusal,
      source: parsed.verdict === "invalid" ? "invalid" : "model",
      stage: args.stage,
      model: result.model,
      templateVersion: TEMPLATE_VERSION,
      latencyMs: Date.now() - startedAtMs,
      startedAtMs,
      inputHash,
      parsed,
      ...(parsed.verdict === "invalid" ? { reason: "unreadable classifier output" } : {}),
    };
    if (parsed.verdict !== "invalid") {
      verdictCache.set(key, { verdict: parsed, at: Date.now() });
      if (verdictCache.size > CACHE_LIMIT) {
        const oldest = verdictCache.keys().next().value;
        if (oldest) verdictCache.delete(oldest);
      }
    }
    return finish(outcome, args, { modelCalled: true });
  } catch (err) {
    return finish(
      {
        ...base,
        source: "degraded",
        reason: err instanceof Error ? err.message : String(err),
      },
      args,
      // The attempt was made even though it threw — the gateway may have
      // consumed tokens before the failure, so this path is metered too.
      { modelCalled: true },
    );
  }
}

/* ── Policy version lookup (Step 4 surface, read here for the cache key) ─── */

async function loadPolicyVersion(orgId: string | null): Promise<number | null> {
  if (!orgId) return null;
  try {
    const row = await db.moderationPolicyVersion.findFirst({
      where: { orgId, active: true },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    return row?.version ?? null;
  } catch {
    // An unreadable policy must not crash moderation; version 0 keeps the
    // cache key stable for the unversioned default profile.
    return null;
  }
}

/* ── Span + persistence, shared by every return path ────────────────────── */

async function finish(
  outcome: Omit<ModerationOutcome, "latencyMs"> & {
    startedAtMs: number;
    latencyMs?: number;
  },
  args: ModerateInput,
  opts: { cached?: boolean; modelCalled?: boolean } = {},
): Promise<ModerationOutcome> {
  const latencyMs = outcome.latencyMs ?? Date.now() - outcome.startedAtMs;
  const full: ModerationOutcome = {
    verdict: outcome.verdict,
    categories: outcome.categories,
    refusal: outcome.refusal,
    source: outcome.source,
    stage: outcome.stage,
    model: outcome.model,
    templateVersion: outcome.templateVersion,
    latencyMs,
    inputHash: outcome.inputHash,
    parsed: outcome.parsed,
    reason: outcome.reason,
  };

  // Span: never throws, never blocks (the store owns durability).
  recordSpanAndPersist({
    span: "moderation_check",
    startedAtMs: outcome.startedAtMs,
    endedAtMs: outcome.startedAtMs + latencyMs,
    conversationId: args.conversationId ?? null,
    caseRef: args.caseRef ?? null,
    attributes: {
      stage: args.stage,
      source: full.source,
      verdict: full.verdict,
      model: full.model,
      cached: opts.cached === true,
    },
  });

  // Persistence: fire-and-forget by default, with its own error boundary. A
  // moderation-evidence write that fails must not fail the turn — the span
  // above and the structured log below still carry the decision, and a
  // persistent store outage is an incident the readyz check surfaces, not a
  // reason to leak unmoderated behaviour. `persist: "await"` (the /v1 API
  // contract) resolves the row first so the caller receives the id.
  const persistRow = async (): Promise<string | undefined> => {
    try {
      const row = await db.moderationRequest.create({
        data: {
          orgId: args.orgId ?? null,
          caseRef: args.caseRef ?? null,
          conversationId: args.conversationId ?? null,
          traceId: args.traceId ?? null,
          stage: args.stage,
          verdict: full.verdict,
          categories: full.categories,
          model: full.model,
          templateVersion: full.templateVersion,
          source: full.source,
          refused: full.verdict === "unsafe" || full.verdict === "controversial",
          inputHash: full.inputHash,
          sample: sampleOf(args.text),
          latencyMs,
          promptTokens: null,
          completionTokens: null,
        },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      logWarn("[moderation] evidence row write failed", {
        error: err instanceof Error ? err.message : String(err),
        stage: args.stage,
        source: full.source,
      });
      return undefined;
    }
  };

  if (args.persist === "await") {
    const id = await persistRow();
    if (id) full.id = id;
  } else {
    void persistRow();
  }

  // Usage metering, same discipline as the evidence row above: fire-and-
  // forget with its own error boundary, and never a moderation failure. A
  // ledger write that fails (DB down, lock timeout) must not fail the
  // decision — the span carries the outcome either way, and a persistently
  // failing ledger is an incident, not a reason to ship unmoderated speech.
  // Org-less moderation (platform surfaces) is unattributable and unmetered:
  // there is no tenant to charge the usage to, by design.
  //
  // THE GATE IS THE MODEL CALL, NOT THE DECISION. `opts.modelCalled` is true
  // only on the paths where the classifier was actually reached: a clean
  // verdict, an unreadable output, or a gateway attempt that threw. Flag-off,
  // kill switch, empty content and quota denials never touched the vendor, so
  // metering them would book usage that never happened — the operator's
  // per-tenant moderation analytics would then read high on every deployment
  // that runs with the flag off. A cached verdict is not metered either: the
  // original classification that filled the cache was already metered once,
  // and a hot phrase must not pay per replay.
  if (args.orgId && opts.modelCalled === true) {
    void (async () => {
      try {
        const { recordModerationUsage } = await import("@/lib/billing/ledger");
        meterSeq += 1;
        const traceId = args.traceId ?? `${full.inputHash}:${meterSeq}`;
        await recordModerationUsage({
          orgId: args.orgId!,
          traceId,
          stage: args.stage,
          verdict: full.verdict,
          units: Math.max(1, args.text.length),
          caseRef: args.caseRef ?? null,
        });
      } catch (err) {
        logWarn("[moderation] usage metering write failed", {
          error: err instanceof Error ? err.message : String(err),
          stage: args.stage,
        });
      }
    })();
  }

  if (full.source !== "model" || full.verdict !== "safe") {
    logInfo("[moderation] decision", {
      stage: describeStage(args.stage),
      verdict: full.verdict,
      source: full.source,
      categories: full.categories.join(","),
      reason: full.reason,
    });
  }

  return full;
}

/** Redacted-ish, truncated sample: operator triage without full-content
 *  retention. Full redaction happens upstream where the content's context is
 *  known; here we only cap length and strip control characters. */
function sampleOf(text: string): string {
  const cleaned = (text ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 240 ? `${cleaned.slice(0, 240)}…` : cleaned;
}

/** Live view for /api/readyz and the operator console. */
export function moderationHealth(): {
  flagOn: boolean;
  breaker: ReturnType<typeof moderationBreakerState>;
  failureMode: "degraded" | "fail_closed";
  model: string;
  cacheEntries: number;
} {
  return {
    flagOn: flag("qwen3guard"),
    breaker: moderationBreakerState(),
    failureMode: env.qwen3guardFailureMode,
    model: env.qwen3guardModel,
    cacheEntries: verdictCache.size,
  };
}
