/**
 * E2E JOURNEY — the inbound agent-tool surface.
 *
 * Six endpoints stand between the ElevenLabs Agents Platform and
 * money-adjacent state. `card_freeze` is the one that matters: it takes a
 * caller's word ("I did not make that charge") and stages a freeze on a real
 * case. Everything else in the platform is recoverable; a freeze staged on the
 * wrong case, by a caller who should not have been allowed to ask, is not.
 *
 * Each route is invoked through its real exported `POST` handler with a real
 * `NextRequest`, so what is asserted here is the deployed contract, not a unit
 * of the auth helper.
 *
 * ── The authorisation contract, asserted through the routes ────────────────
 *
 *   1. FAIL CLOSED. With no `AGENT_TOOL_SECRET` configured, every tool route
 *      refuses — including `card_freeze`. An unset secret must not degrade into
 *      "no authentication required", which is the single most expensive way to
 *      misconfigure a payment-adjacent endpoint.
 *   2. SCOPE IS NOT "HAS THE SECRET". A correct secret on a tool missing from
 *      `AGENT_TOOL_ALLOWED` is 403 `tool_not_in_scope` and performs no action.
 *      Privilege is bound to the caller's configured tool list, not to the URL
 *      being reachable — otherwise a captured call for `human_handoff` can be
 *      rewritten into a `card_freeze` call and replayed.
 *   3. A WRONG-LENGTH SECRET IS A CLEAN 401. `safeEqual` hashes both sides
 *      before `timingSafeEqual` precisely because the latter THROWS on a length
 *      mismatch; unguarded, a one-character guess against a long secret is a 500
 *      and leaks the secret's length through the stack trace.
 *   4. ORDERING: the secret is checked before the allow-list, so a caller with
 *      no valid secret learns nothing about which tools are configured.
 *   5. A REFUSAL ARMS NOTHING. Asserted against the database seams rather than
 *      the response body: the case read, the case write, the audit write and the
 *      raw query are all instrumented, and the claim "nothing happened" is a
 *      claim about which of them were reached.
 *   6. A REFUSAL SAYS NOTHING IT SHOULD NOT. No refusal echoes the configured
 *      secret, the allow-list, or a case reference — including one belonging to
 *      a different tenant.
 *
 * ── Everything else these endpoints guarantee ─────────────────────────────
 *
 *   · card_freeze STAGES a freeze; it never commits one. `staged: true` with
 *     `committed: false` and a 300-second reversal window is the whole point of
 *     the endpoint, and it is invariant I-2.
 *   · A FREEZE THAT CANNOT BE AUDITED IS REFUSED (503 `audit_unavailable`).
 *     The audit chain is the record of who froze what; a freeze that happened
 *     without one is a freeze nobody can explain afterwards.
 *   · A handoff summary is REDACTED before it reaches the specialist queue, so
 *     the OTP the caller read out loud does not outlive the call.
 *   · switch_language keeps the hot path at ONE database round trip; its
 *     refusals are allowed a second, and the test counts them.
 *   · signed_url refuses an agent_id that disagrees with the server-side pin,
 *     so a browser cannot aim a minted credential at a different agent.
 *   · The webhook is signature-verified before anything is written, and every
 *     verification failure is a 4xx — never a 5xx, never a partial write.
 *
 * ── Why this suite never touches the database ─────────────────────────────
 *
 * Every Prisma seam these handlers can reach is replaced in `beforeEach` and
 * restored in `afterEach`. That is not only to keep this file off the shared
 * Postgres that four other suites are using: it makes "a rejected call arms
 * nothing" a measurement instead of a claim, and a route that grows a new
 * query shows up as a stub that was reached without an override installed
 * rather than as a quietly-passing assertion. `fetch` is stubbed the same way,
 * so no test in this file can reach the real ElevenLabs API.
 *
 * What is genuinely DB-backed and therefore NOT covered here — the real round
 * trip `transitionCase` performs, and the real webhook ingest in
 * `processInboundEvent` — is already covered by tests/tools/guard.test.ts and
 * tests/webhooks/elevenlabs-inbound.test.ts. This file covers what those
 * suites cannot reach: the requests that are refused before the database is
 * ever involved.
 *
 * Response bodies are parsed through Zod rather than cast. A cast would
 * silence a shape change; a parse turns it into a failing assertion naming the
 * field, which is the entire point of gating an authorisation contract.
 *
 * ── One real defect this suite found ──────────────────────────────────────
 *
 * `withChainLock` (src/lib/audit-chain.ts:104-110) stores `run.finally(…)`
 * and returns `run`. A rejected append therefore leaves `tracked` — a sibling
 * promise nobody handles — rejected, and Node ≥15 / Bun / Next.js treat that as
 * fatal. A transient audit-chain outage escalates these routes' clean 503
 * `audit_unavailable` into taking the instance down. Reproduced, worked around
 * in `absorbOrphanedAuditRejection`, and left unfixed here on purpose; the
 * call sites that need the workaround say why.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { db, dbAudit } from "@/lib/db";
import { append as auditAppend } from "@/lib/audit-chain";
import { POST as cardFreeze } from "@/app/api/elevenlabs/tools/card-freeze/route";
import { POST as verifyTransaction } from "@/app/api/elevenlabs/tools/verify-transaction/route";
import { POST as humanHandoff } from "@/app/api/elevenlabs/tools/human-handoff/route";
import { POST as switchLanguage } from "@/app/api/elevenlabs/tools/switch-language/route";
import { POST as signedUrl } from "@/app/api/elevenlabs/signed-url/route";
import { POST as elevenLabsWebhook } from "@/app/api/webhooks/elevenlabs/route";

/* ───────────────────────────── environment ─────────────────────────────── */

const SECRET = "journey-shared-tool-secret-2f7c";
const WEBHOOK_SECRET = "3a91c0de44b7".repeat(4);
const PINNED_AGENT = "agent_pinned_0123456789";
const CONVERSATION_ID = "conv-journey-tenant-a";

/** A case reference belonging to a tenant this caller has no business seeing. */
const OTHER_TENANT_CASE_REF = "SV-OTHERTENANT-9F3A2C";

const ENV_KEYS = [
  "AGENT_TOOL_SECRET",
  "AGENT_TOOL_ALLOWED",
  "ELEVENLABS_WEBHOOK_SECRET",
  "ELEVENLABS_AGENT_ID",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_DRY_RUN",
  "TELEMETRY_SPAN_LOG",
] as const;

/** Snapshot taken at module load so `afterEach` can put the runner's env back. */
const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

/* ─────────────────────────── database instrumentation ───────────────────── */

/** Every Prisma seam a handler in this suite could reach. */
type Seam =
  | "case.findFirst"
  | "case.findUnique"
  | "case.update"
  | "notification.findUnique"
  | "notification.create"
  | "notification.update"
  | "$queryRaw"
  | "auditLog.findFirst"
  | "auditLog.create"
  | "audit.$executeRaw"
  | "audit.$transaction"
  | "webhookEvent.create"
  | "webhookEvent.findFirst"
  | "webhookEvent.findUnique";

/**
 * Mutable state the stubs read. A test sets a field only when it means to let
 * that operation happen; anything left alone is either recorded and returned
 * empty, or recorded and rejected, so an unplanned database round trip fails
 * loudly instead of quietly reaching the shared instance.
 */
const seams = {
  /** Which seams were actually reached — the evidence for "arms nothing". */
  touched: [] as Seam[],
  /** Audit entries the stubbed chain recorded, in write order. */
  audit: [] as Record<string, unknown>[],
  /** When true the audit chain is down and every append rejects. */
  auditDown: false,
  /** What `Case.findFirst` resolves to. `null` means "no live case". */
  caseRow: null as Record<string, unknown> | null,
  /** What `Case.findUnique` resolves to (the transition writer's re-read). */
  caseByRef: null as Record<string, unknown> | null,
  /** What `Case.update` resolves to. */
  caseUpdated: null as Record<string, unknown> | null,
  /** Arguments every `Case.update` was called with. */
  caseUpdates: [] as Record<string, unknown>[],
  /** Results handed to successive `db.$queryRaw` calls, in order. */
  rawResults: [] as unknown[][],
  /**
   * What `WebhookEvent.findUnique` resolves to. This is the FIRST statement
   * `processInboundEvent` runs, and a `null` there makes the whole ingest a
   * no-op — which is how the webhook route's fire-and-forget hand-off is
   * neutralised without mocking the module. A `mock.module` of
   * `@/lib/elevenlabs/inbound` would leak into every other suite in the same
   * `bun test` run and silently disable their ingest; verified, and rejected
   * for that reason.
   */
  webhookLookup: null as Record<string, unknown> | null,
  /** What `WebhookEvent.create` resolves to, or the error it throws. */
  webhookCreate: null as Record<string, unknown> | Error | null,
  /** The row `WebhookEvent.create` was handed. */
  webhookRow: null as Record<string, unknown> | null,
  /** What `WebhookEvent.findFirst` resolves to (the replay lookup). */
  webhookFound: null as Record<string, unknown> | null,
};

const pristine = { ...seams };

function resetSeams(): void {
  seams.touched = [];
  seams.audit = [];
  seams.auditDown = false;
  seams.caseRow = null;
  seams.caseByRef = null;
  seams.caseUpdated = null;
  seams.caseUpdates = [];
  seams.rawResults = [];
  seams.webhookCreate = null;
  seams.webhookLookup = null;
  seams.webhookRow = null;
  seams.webhookFound = null;
}

const unstubbed = (seam: Seam): Error => new Error(`unstubbed database seam reached: ${seam}`);

/** A case row shaped the way `Case.findFirst` / `Case.findUnique` resolve it. */
const caseRow = (
  state: string,
  caseRef = "SV-JOURNEY-CASE",
  orgId = "org-tenant-a",
): Record<string, unknown> => ({
  id: `case-${caseRef}`,
  caseRef,
  conversationId: CONVERSATION_ID,
  orgId,
  state,
  // `card_freeze` reads this to date the freeze-staged span.
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

/**
 * The one place a chain entry is recorded, shared by the fast single-statement
 * append and the transactional one. `auditDown` is how a test models a chain
 * that cannot be written, which is the condition every tool route must refuse.
 */
async function recordAudit(data: Record<string, unknown>): Promise<{
  id: string;
  chainHash: string;
}> {
  if (seams.auditDown) throw new Error("audit chain unavailable");
  seams.audit.push(data);
  return { id: "audit-stub", chainHash: "chain-stub" };
}

/**
 * The client the transactional append path runs its statements on. That path
 * takes a per-callRef advisory lock before it reads the chain head, so two
 * replicas cannot fork the chain — the lock is part of the seam.
 */
const auditTx = {
  $executeRaw: (async () => {
    seams.touched.push("audit.$executeRaw");
    return 0;
  }) as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>,
  auditLog: {
    findFirst: async (): Promise<null> => {
      seams.touched.push("auditLog.findFirst");
      return null;
    },
    create: async (args: { data: Record<string, unknown> }) => {
      seams.touched.push("auditLog.create");
      return recordAudit(args.data);
    },
  },
};

/**
 * `auditAppend` canonicalises `meta` to a JSON string before hashing it, so a
 * stored entry carries serialised metadata. Reading it back as an object is
 * what makes a field-level assertion possible at all.
 */
function auditMeta(index = 0): Record<string, unknown> {
  const serialised = seams.audit[index]?.meta;
  if (typeof serialised !== "string") throw new Error("audit entry has no serialised meta");
  return AuditMeta.parse(JSON.parse(serialised));
}

/**
 * Prisma model delegates are generic over their argument and select shapes, so
 * a stub that takes one concrete shape does not structurally match the real
 * method type. These are the four delegates this suite replaces wholesale; the
 * view is taken once here rather than cast at every assignment.
 */
const caseModel = db.case as unknown as Record<string, unknown>;
const notificationModel = db.notification as unknown as Record<string, unknown>;
const auditLogModel = dbAudit.auditLog as unknown as Record<string, unknown>;
const webhookEventModel = db.webhookEvent as unknown as Record<string, unknown>;

const realCaseFindUnique = caseModel.findUnique;
const realCaseUpdate = caseModel.update;
const realNotificationFindUnique = notificationModel.findUnique;
const realNotificationCreate = notificationModel.create;
const realNotificationUpdate = notificationModel.update;
const realQueryRaw = db.$queryRaw;
const realAuditFindFirst = auditLogModel.findFirst;
const realAuditCreate = auditLogModel.create;
const realAuditTransaction = dbAudit.$transaction;
const realWebhookCreate = webhookEventModel.create;
const realWebhookFindFirst = webhookEventModel.findFirst;
const realWebhookFindUnique = webhookEventModel.findUnique;
const realFetch = globalThis.fetch;

const realCaseFindFirst = caseModel.findFirst;

/**
 * KNOWN GAP — `withChainLock` (src/lib/audit-chain.ts:104-110).
 *
 * It stores `run.finally(…)` in CHAIN_LOCKS and returns `run`. When an append
 * rejects, the caller handles `run` — but `tracked` is a SIBLING promise
 * derived from it that nothing ever handles, so every failed audit append
 * leaves an unhandled rejection behind. Node ≥15, Bun and Next.js all treat an
 * unhandled rejection as fatal, so a transient audit-chain outage escalates
 * from this route's clean 503 `audit_unavailable` into taking the whole
 * instance down. Reproduced with a single `append()` call against a rejecting
 * `dbAudit.auditLog.create`: the caller catches, and the rejection is still
 * reported. The fix is one `.catch(() => {})` on `tracked`.
 *
 * Until then, exercising the fail-closed path needs this shim. A follow-up
 * append on the SAME callRef chains onto the orphaned promise — that is
 * precisely what `withChainLock` does for the next writer — and marks it
 * handled, so the test observes the route's contract instead of killing the
 * runner. This is a workaround for the bug, not a fix for it.
 */
async function absorbOrphanedAuditRejection(callRef: string): Promise<void> {
  seams.auditDown = false;
  seams.audit.length = 0;
  await auditAppend({ callRef, action: "agent", intent: "chain_recovered" });
}

beforeEach(() => {
  // Start every test from "the deployment is unconfigured" and configure
  // explicitly, so no test inherits another's allow-list and no test depends on
  // the order the runner happened to pick.
  for (const key of ENV_KEYS) delete process.env[key];
  // None of these six handlers reads the dry-run flag; it is set because the
  // modules they import (notifications, realtime) branch on it, and an
  // accidentally-live provider call is the worst possible way to find that out.
  process.env.ELEVENLABS_DRY_RUN = "true";
  process.env.ELEVENLABS_API_KEY = "test-elevenlabs-api-key";
  // Spans recorded by these requests are refusal telemetry, not evidence. Left
  // alone they would land in evidence/latency/spans.jsonl and contaminate the
  // latency gates that read that file.
  process.env.TELEMETRY_SPAN_LOG = join(tmpdir(), "sv-elevenlabs-tool-journey-spans.jsonl");
  resetSeams();

  caseModel.findFirst = async (args: { where: { conversationId?: string } }) => {
    seams.touched.push("case.findFirst");
    // A lookup for a conversation the test did not seed is still "no live case".
    return args?.where?.conversationId === undefined ? null : seams.caseRow;
  };

  caseModel.findUnique = async () => {
    seams.touched.push("case.findUnique");
    if (seams.caseByRef === null) throw unstubbed("case.findUnique");
    return seams.caseByRef;
  };

  caseModel.update = async (args: { data: Record<string, unknown> }) => {
    seams.touched.push("case.update");
    seams.caseUpdates.push(args.data);
    if (seams.caseUpdated === null) throw unstubbed("case.update");
    return seams.caseUpdated;
  };

  notificationModel.findUnique = async () => {
    seams.touched.push("notification.findUnique");
    return null;
  };
  notificationModel.create = async () => {
    seams.touched.push("notification.create");
    return { id: "notification-stub", count: 1 };
  };
  notificationModel.update = async () => {
    seams.touched.push("notification.update");
    return { id: "notification-stub", count: 1 };
  };

  db.$queryRaw = (async () => {
    seams.touched.push("$queryRaw");
    return seams.rawResults.shift() ?? [];
  }) as unknown as typeof db.$queryRaw;

  auditLogModel.findFirst = async () => {
    seams.touched.push("auditLog.findFirst");
    return null;
  };
  auditLogModel.create = async (args: { data: Record<string, unknown> }) => {
    seams.touched.push("auditLog.create");
    return recordAudit(args.data);
  };
  // The non-fast append runs both chain statements in one transaction so the
  // head can never be read outside the write that extends it. Same seam, a
  // different door — a test that stubs only one of them would pass for free.
  dbAudit.$transaction = (async (fn: (tx: typeof auditTx) => Promise<unknown>) => {
    seams.touched.push("audit.$transaction");
    return fn(auditTx);
  }) as unknown as typeof dbAudit.$transaction;

  webhookEventModel.create = async (args: { data: Record<string, unknown> }) => {
    seams.touched.push("webhookEvent.create");
    if (seams.webhookCreate instanceof Error) throw seams.webhookCreate;
    seams.webhookRow = args.data;
    return seams.webhookCreate ?? { id: "webhook-event-stub" };
  };
  webhookEventModel.findFirst = async () => {
    seams.touched.push("webhookEvent.findFirst");
    return seams.webhookFound;
  };
  webhookEventModel.findUnique = async () => {
    seams.touched.push("webhookEvent.findUnique");
    return seams.webhookLookup;
  };

  globalThis.fetch = (async () => {
    throw new Error("unstubbed network call from an e2e journey test");
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = originalEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  Object.assign(seams, pristine);

  caseModel.findFirst = realCaseFindFirst;
  caseModel.findUnique = realCaseFindUnique;
  caseModel.update = realCaseUpdate;
  notificationModel.findUnique = realNotificationFindUnique;
  notificationModel.create = realNotificationCreate;
  notificationModel.update = realNotificationUpdate;
  db.$queryRaw = realQueryRaw;
  auditLogModel.findFirst = realAuditFindFirst;
  auditLogModel.create = realAuditCreate;
  dbAudit.$transaction = realAuditTransaction;
  webhookEventModel.create = realWebhookCreate;
  webhookEventModel.findUnique = realWebhookFindUnique;
  webhookEventModel.findFirst = realWebhookFindFirst;
  globalThis.fetch = realFetch;
});

/* ───────────────────────────────── helpers ──────────────────────────────── */

type ToolPost = (req: NextRequest) => Promise<Response>;

type ToolCase = {
  readonly tool: string;
  readonly path: string;
  readonly post: ToolPost;
  readonly body: Record<string, unknown>;
};

/** Every agent-tool endpoint, with a body each one would accept. */
const FREEZE: ToolCase = {
  tool: "card_freeze",
  path: "/api/elevenlabs/tools/card-freeze",
  post: cardFreeze,
  body: {
    conversation_id: CONVERSATION_ID,
    account_id: "****4417",
    reason_code: "FRAUD_CONFIRMED",
  },
};
const VERIFY: ToolCase = {
  tool: "verify_transaction",
  path: "/api/elevenlabs/tools/verify-transaction",
  post: verifyTransaction,
  body: { conversation_id: CONVERSATION_ID, outcome: "confirmed_fraud" },
};
const HANDOFF: ToolCase = {
  tool: "human_handoff",
  path: "/api/elevenlabs/tools/human-handoff",
  post: humanHandoff,
  body: { conversation_id: CONVERSATION_ID, summary: "Customer denied the charge." },
};
const LANGUAGE: ToolCase = {
  tool: "switch_language",
  path: "/api/elevenlabs/tools/switch-language",
  post: switchLanguage,
  body: { conversation_id: CONVERSATION_ID, language: "ar" },
};
const SIGNED: ToolCase = {
  tool: "signed_url",
  path: "/api/elevenlabs/signed-url",
  post: signedUrl,
  body: {},
};

const TOOLS: readonly ToolCase[] = [FREEZE, VERIFY, HANDOFF, LANGUAGE, SIGNED];
const TOOL_NAMES = TOOLS.map((t) => t.tool);

function call(tool: ToolCase, body: unknown, secret?: string): Promise<Response> {
  return tool.post(
    new NextRequest(`http://localhost${tool.path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret === undefined ? {} : { "x-agent-tool-secret": secret }),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    } as ConstructorParameters<typeof NextRequest>[1]),
  );
}

/**
 * The routes fire audit appends they do not await (`void …catch(…)`), so an
 * assertion about an audit entry has to let those microtasks run. This drains
 * the queue rather than sleeping: the append chain is a fixed, short run of
 * already-resolved promises, so a fixed number of ticks is exact where a wall
 * clock wait would only be long enough on an unloaded machine.
 */
async function drainFireAndForget(): Promise<void> {
  for (let tick = 0; tick < 64; tick += 1) await Promise.resolve();
}

/** A refusal body: `ok:false` plus a machine-readable reason. */
const RefusalBody = z.object({ ok: z.literal(false), error: z.string() });

/**
 * Fields a refusal must never contain. Each one reports an ACTION: if any of
 * them appears on a non-2xx response, the endpoint claimed it did something it
 * did not do — which is worse than the refusal itself.
 */
const ACTION_FIELDS = [
  "staged",
  "committed",
  "reference",
  "case_ref",
  "state",
  "next_prompt_key",
  "specialist",
  "language",
  "credential",
  "agent_id",
  "expires_in_secs",
] as const;

/** Assert the response is a refusal that reports no action, then return it. */
async function readRefusal(res: Response): Promise<{ error: string; raw: string }> {
  const raw = await res.clone().text();
  const parsed = RefusalBody.parse(JSON.parse(raw));
  for (const field of ACTION_FIELDS) {
    expect(Object.keys(parsed)).not.toContain(field);
  }
  return { error: parsed.error, raw };
}

/* ───────────────────── the authorisation contract ───────────────────────── */

describe("authorisation — no secret configured", () => {
  test("every tool route refuses", async () => {
    process.env.AGENT_TOOL_ALLOWED = TOOL_NAMES.join(",");
    const observed = await Promise.all(
      TOOLS.map(async (tool) => ({
        tool: tool.tool,
        status: (await call(tool, tool.body)).status,
      })),
    );
    // A missing secret must be indistinguishable from a wrong one. If any of
    // these answered 200, the deployment would have "no authentication
    // configured" behaving as "authentication passed".
    expect(observed).toEqual(TOOL_NAMES.map((tool) => ({ tool, status: 401 })));
  });

  test("every refusal is `unauthorized` and arms nothing", async () => {
    process.env.AGENT_TOOL_ALLOWED = TOOL_NAMES.join(",");
    // The case exists and is in a state each tool would happily act on. If any
    // refusal were decided after case resolution, these would all succeed.
    seams.caseRow = caseRow("CONFIRMED_FRAUD");
    seams.caseByRef = caseRow("CONFIRMED_FRAUD", "SV-JOURNEY-A");
    seams.caseUpdated = { id: "case-stub", state: "FREEZE_STAGED" };
    seams.rawResults = [[{ caseRef: "SV-JOURNEY-A", state: "CONFIRMED_FRAUD" }]];

    for (const tool of TOOLS) {
      const { raw, error } = await readRefusal(await call(tool, tool.body, SECRET));
      expect({ tool: tool.tool, error }).toEqual({ tool: tool.tool, error: "unauthorized" });
      expect(raw).not.toContain(SECRET);
    }

    expect(seams.touched).toEqual([]);
    expect(seams.audit).toEqual([]);
    expect(seams.caseUpdates).toEqual([]);
  });

  test("an empty-string secret header is refused, not treated as a match", async () => {
    process.env.AGENT_TOOL_SECRET = SECRET;
    process.env.AGENT_TOOL_ALLOWED = TOOL_NAMES.join(",");
    const statuses = await Promise.all(
      TOOLS.map(async (tool) => (await call(tool, tool.body, "")).status),
    );
    expect(statuses).toEqual(TOOLS.map(() => 401));
  });

  test("no route accepts a caller that sends no secret header at all", async () => {
    process.env.AGENT_TOOL_SECRET = SECRET;
    process.env.AGENT_TOOL_ALLOWED = TOOL_NAMES.join(",");
    const statuses = await Promise.all(
      TOOLS.map(async (tool) => (await call(tool, tool.body)).status),
    );
    expect(statuses).toEqual(TOOLS.map(() => 401));
  });
});

describe("authorisation — the tool is not in the allow-list", () => {
  test("a correct secret on an out-of-scope tool is 403 on every route", async () => {
    process.env.AGENT_TOOL_SECRET = SECRET;
    const observed: { tool: string; status: number }[] = [];
    for (const tool of TOOLS) {
      // Scope every OTHER tool, so the refusal can only come from the scope
      // check and never from a 401 that would mask it.
      process.env.AGENT_TOOL_ALLOWED = TOOL_NAMES.filter((n) => n !== tool.tool).join(",");
      const res = await call(tool, tool.body, SECRET);
      observed.push({ tool: tool.tool, status: res.status });
      const { raw, error } = await readRefusal(res);
      expect({ tool: tool.tool, error }).toEqual({ tool: tool.tool, error: "tool_not_in_scope" });
      expect(raw).not.toContain(SECRET);
    }
    expect(observed).toEqual(TOOL_NAMES.map((tool) => ({ tool, status: 403 })));
  });

  test("an out-of-scope refusal performs no action and names no allowed tool", async () => {
    process.env.AGENT_TOOL_SECRET = SECRET;
    seams.caseRow = caseRow("CONFIRMED_FRAUD");
    seams.caseByRef = caseRow("CONFIRMED_FRAUD", "SV-JOURNEY-A");
    seams.caseUpdated = { id: "case-stub", state: "FREEZE_STAGED" };
    seams.rawResults = [[{ caseRef: "SV-JOURNEY-A", state: "CONFIRMED_FRAUD" }]];

    for (const tool of TOOLS) {
      const inScope = TOOL_NAMES.filter((n) => n !== tool.tool);
      process.env.AGENT_TOOL_ALLOWED = inScope.join(",");
      const res = await call(tool, tool.body, SECRET);
      expect({ tool: tool.tool, status: res.status }).toEqual({ tool: tool.tool, status: 403 });
      const raw = await res.text();
      // A refusal must not hand the caller the rest of its own scope.
      for (const name of inScope) expect(raw).not.toContain(name);
    }

    expect(seams.touched).toEqual([]);
    expect(seams.audit).toEqual([]);
  });

  test("an unset or empty allow-list refuses rather than trusting everything", async () => {
    process.env.AGENT_TOOL_SECRET = SECRET;
    for (const allowed of [undefined, "", " , , "]) {
      if (allowed === undefined) delete process.env.AGENT_TOOL_ALLOWED;
      else process.env.AGENT_TOOL_ALLOWED = allowed;
      const res = await call(FREEZE, FREEZE.body, SECRET);
      expect({ allowed, status: res.status }).toEqual({ allowed, status: 403 });
      const { error } = await readRefusal(res);
      expect(error).toBe("tool_scope_unconfigured");
    }
  });

  test("a valid secret does not carry across tools", async () => {
    // The property the allow-list exists for: a call captured for one tool,
    // rewritten to another, must fail on the rewrite.
    process.env.AGENT_TOOL_SECRET = SECRET;
    process.env.AGENT_TOOL_ALLOWED = "human_handoff";
    const rewritten = await call(FREEZE, FREEZE.body, SECRET);
    expect(rewritten.status).toBe(403);
    // And the narrowing is real: the tool that stays on the list gets past
    // authorisation, so the 403 cannot be passing for some unrelated reason.
    // 409 is the first response an authorised caller can get here.
    expect((await call(HANDOFF, HANDOFF.body, SECRET)).status).toBe(409);
  });

  test("scope is matched exactly — no substring, no case folding", async () => {
    process.env.AGENT_TOOL_SECRET = SECRET;
    for (const [allowed, expected] of [
      ["card", 403],
      ["CARD_FREEZE", 403],
      ["card_freeze_v2", 403],
      [" card_freeze ", 409],
    ] as const) {
      process.env.AGENT_TOOL_ALLOWED = allowed;
      const res = await call(FREEZE, FREEZE.body, SECRET);
      // 409 stands in for "in scope and authorised": with no seeded case that
      // is the only response a card_freeze caller can get past the guard.
      expect({ allowed, status: res.status }).toEqual({ allowed, status: expected });
    }
  });
});

describe("authorisation — the secret is checked first, and never leaks length", () => {
  test("a bad secret is 401 even when the tool is also out of scope", async () => {
    process.env.AGENT_TOOL_SECRET = SECRET;
    process.env.AGENT_TOOL_ALLOWED = "human_handoff";
    const res = await call(FREEZE, FREEZE.body, "wrong-secret");
    const { error } = await readRefusal(res);
    expect({ status: res.status, error }).toEqual({ status: 401, error: "unauthorized" });
  });

  test("a bad secret is 401 even when the allow-list is unset", async () => {
    process.env.AGENT_TOOL_SECRET = SECRET;
    const res = await call(FREEZE, FREEZE.body, "wrong-secret");
    expect(res.status).toBe(401);
  });

  test("a wrong-length secret is a clean 401 on every route, never a 500", async () => {
    process.env.AGENT_TOOL_SECRET = SECRET;
    process.env.AGENT_TOOL_ALLOWED = TOOL_NAMES.join(",");
    for (const guess of [
      "x",
      SECRET.slice(0, SECRET.length - 1),
      `${SECRET}extra`,
      " ",
      " ",
      // A header value cannot carry astral-plane bytes, so the byte-level
      // width cases live in tests/unit/agent-tool-auth.test.ts; what matters
      // here is that the ROUTE survives every length it can be handed.
      "S3cret!".repeat(20),
      "A".repeat(4096),
    ]) {
      const statuses = await Promise.all(
        TOOLS.map(async (tool) => (await call(tool, tool.body, guess)).status),
      );
      // `timingSafeEqual` throws on a length mismatch; unguarded that surfaces
      // as a 500 and hands the attacker the secret's length.
      expect({ guess: `${guess.slice(0, 8)}…(${guess.length})`, statuses }).toEqual({
        guess: `${guess.slice(0, 8)}…(${guess.length})`,
        statuses: TOOLS.map(() => 401),
      });
    }
  });

  test("an unset secret and a wrong secret are indistinguishable", async () => {
    process.env.AGENT_TOOL_ALLOWED = "card_freeze";
    const unset = await call(FREEZE, FREEZE.body, "some-guess");
    process.env.AGENT_TOOL_SECRET = SECRET;
    const wrong = await call(FREEZE, FREEZE.body, "some-guess");
    expect({ status: unset.status, body: await unset.text() }).toEqual({
      status: wrong.status,
      body: await wrong.text(),
    });
  });

  test("no refusal names a case belonging to another tenant", async () => {
    process.env.AGENT_TOOL_SECRET = SECRET;
    // The conversation maps to a case in another tenant's namespace. Every
    // caller here is refused on scope, before any resolution, so the reference
    // is never observable.
    seams.caseRow = caseRow("CONFIRMED_FRAUD", OTHER_TENANT_CASE_REF, "org-someone-else");
    for (const tool of TOOLS) {
      process.env.AGENT_TOOL_ALLOWED = TOOL_NAMES.filter((n) => n !== tool.tool).join(",");
      const raw = await (await call(tool, tool.body, SECRET)).text();
      expect({ tool: tool.tool, leaked: raw.includes(OTHER_TENANT_CASE_REF) }).toEqual({
        tool: tool.tool,
        leaked: false,
      });
    }
  });
});

/* ───────────────────────────── card_freeze ──────────────────────────────── */

describe("POST /api/elevenlabs/tools/card-freeze", () => {
  beforeEach(() => {
    process.env.AGENT_TOOL_SECRET = SECRET;
    process.env.AGENT_TOOL_ALLOWED = "card_freeze";
  });

  /** Seed a CONFIRMED_FRAUD case whose transition will succeed. */
  const seedFreezableCase = (): void => {
    seams.caseRow = caseRow("CONFIRMED_FRAUD", "SV-JOURNEY-FRZ");
    seams.caseByRef = caseRow("CONFIRMED_FRAUD", "SV-JOURNEY-FRZ");
    seams.caseUpdated = { id: "case-stub", state: "FREEZE_STAGED" };
  };

  test("stages a freeze and never commits one", async () => {
    seedFreezableCase();
    const res = await call(FREEZE, FREEZE.body, SECRET);
    expect(res.status).toBe(200);
    expect(StagedBody.parse(await res.json())).toEqual({
      ok: true,
      staged: true,
      committed: false,
      reversal_window_secs: 300,
      reference: "SV-FRZ-SV-JOURNEY-FRZ",
      case_ref: "SV-JOURNEY-FRZ",
      state: "FREEZE_STAGED",
    });
  });

  test("the write is exactly one transition to FREEZE_STAGED", async () => {
    seedFreezableCase();
    await call(FREEZE, FREEZE.body, SECRET);
    expect(seams.caseUpdates).toEqual([
      { state: "FREEZE_STAGED", freezeStaged: true, freezeReference: "SV-FRZ-SV-JOURNEY-FRZ" },
    ]);
  });

  test("the audit entry records the freeze as staged, not committed", async () => {
    seedFreezableCase();
    await call(FREEZE, FREEZE.body, SECRET);
    await drainFireAndForget();
    expect(seams.audit[0]).toMatchObject({
      callRef: "SV-JOURNEY-FRZ",
      action: "freeze",
      intent: "freeze_staged",
      callerId: "agent-tool",
      redactedText: "****4417",
    });
    expect(auditMeta()).toMatchObject({
      tool: "card_freeze",
      stage: "pending_specialist",
      committed: false,
      reversal_window_secs: 300,
      from: "CONFIRMED_FRAUD",
      to: "FREEZE_STAGED",
      source: "elevenlabs_agent_tool",
    });
  });

  test("refuses a freeze it cannot audit", async () => {
    seedFreezableCase();
    seams.auditDown = true;
    const res = await call(FREEZE, FREEZE.body, SECRET);
    expect(res.status).toBe(503);
    expect(UnavailableBody.parse(await res.json())).toEqual({
      ok: false,
      staged: false,
      committed: false,
      error: "audit_unavailable",
    });
    // Nothing was written: the audit is the record of the freeze, and a freeze
    // that happened without one is a freeze nobody can explain afterwards.
    expect(seams.touched).not.toContain("case.update");
    expect(seams.caseUpdates).toEqual([]);
    await absorbOrphanedAuditRejection("SV-JOURNEY-FRZ");
  });

  test("refuses from any state except CONFIRMED_FRAUD (invariant I-2)", async () => {
    for (const state of ["RECEIVED", "VERIFYING", "UNCERTAIN", "FREEZE_STAGED", "CLOSED"]) {
      seams.caseRow = caseRow(state, "SV-JOURNEY-FRZ");
      const res = await call(FREEZE, FREEZE.body, SECRET);
      const { error } = await readRefusal(res);
      expect({ state, status: res.status, error }).toEqual({
        state,
        status: 409,
        error: `tool card_freeze cannot act on a case in state ${state}`,
      });
      expect(seams.caseUpdates).toEqual([]);
    }
  });

  test("a refusal to stage is written to the audit chain, naming the tool", async () => {
    seams.caseRow = caseRow("VERIFYING", "SV-JOURNEY-FRZ");
    await call(FREEZE, FREEZE.body, SECRET);
    await drainFireAndForget();
    expect(seams.audit[0]).toMatchObject({ intent: "tool_refused_card_freeze" });
    expect(auditMeta()).toMatchObject({
      tool: "card_freeze",
      state: "VERIFYING",
      reason: "state_precondition_failed",
    });
  });

  test("a case that moves under the guard yields a 409, never a silent freeze", async () => {
    // The guard read CONFIRMED_FRAUD; by the time the single writer re-reads
    // the row it is CLOSED. Losing that race must surface as a refusal that
    // says nothing was staged.
    seams.caseRow = caseRow("CONFIRMED_FRAUD", "SV-JOURNEY-FRZ");
    seams.caseByRef = caseRow("CLOSED", "SV-JOURNEY-FRZ");
    const res = await call(FREEZE, FREEZE.body, SECRET);
    expect(res.status).toBe(409);
    expect(IllegalTransitionBody.parse(await res.json())).toEqual({
      ok: false,
      staged: false,
      committed: false,
      error: "case cannot move from CONFIRMED_FRAUD to FREEZE_STAGED",
      code: "illegal_transition",
    });
    expect(seams.caseUpdates).toEqual([]);
  });

  test("a failed case write is a 503 that still says nothing was staged", async () => {
    // `caseUpdated` is left null, so the guarded UPDATE is reached and throws.
    seams.caseRow = caseRow("CONFIRMED_FRAUD", "SV-JOURNEY-FRZ");
    seams.caseByRef = caseRow("CONFIRMED_FRAUD", "SV-JOURNEY-FRZ");
    const res = await call(FREEZE, FREEZE.body, SECRET);
    expect(res.status).toBe(503);
    expect(UnavailableBody.parse(await res.json())).toEqual({
      ok: false,
      staged: false,
      committed: false,
      error: "case_transition_failed",
    });
    expect(seams.touched).toContain("case.update");
  });

  test("an unknown conversation_id is refused before any write", async () => {
    const res = await call(FREEZE, FREEZE.body, SECRET);
    expect(res.status).toBe(409);
    const { error } = await readRefusal(res);
    expect(error).toBe("no live case for this conversation_id");
    expect(seams.caseUpdates).toEqual([]);
  });

  test("an unknown field is rejected as `unknown_field`, not passed through", async () => {
    const res = await call(FREEZE, { ...FREEZE.body, freeze: true }, SECRET);
    expect(res.status).toBe(422);
    expect(SchemaError.parse(await res.json())).toEqual({
      error: "conversation_id, account_id and reason_code are required",
      code: "unknown_field",
    });
  });

  test("a malformed body is a 400 — and this route validates before authorising", async () => {
    // KNOWN GAP (asserted as-is, not fixed here): the four `guardToolCall`
    // routes validate the body BEFORE authorising, so an anonymous caller can
    // tell this endpoint exists and learn its field list from a 422. Nothing
    // case-specific is disclosed — the message is a constant string and the
    // conversation id is not echoed — but the ordering differs from
    // `signed_url`, which authorises first. A caller who must not know the
    // tool's schema at all would want the guard moved above `parseJson`.
    const res = await call(FREEZE, "{ not json", SECRET);
    expect(res.status).toBe(400);
    expect(SchemaError.parse(await res.json())).toEqual({
      error: "Invalid JSON body",
      code: undefined,
    });
    expect(seams.touched).toEqual([]);
  });

  test("the account number is accepted but never reflected into the response", async () => {
    seedFreezableCase();
    const raw = await (await call(FREEZE, FREEZE.body, SECRET)).text();
    expect(raw).not.toContain("4417");
    expect(raw).not.toContain(SECRET);
  });
});

/* ────────────────────────── verify_transaction ──────────────────────────── */

describe("POST /api/elevenlabs/tools/verify-transaction", () => {
  beforeEach(() => {
    process.env.AGENT_TOOL_SECRET = SECRET;
    process.env.AGENT_TOOL_ALLOWED = "verify_transaction";
  });

  const DISPOSITIONS = [
    { outcome: "confirmed_fraud", state: "CONFIRMED_FRAUD", next: "stage_freeze" },
    { outcome: "confirmed_legitimate", state: "CONFIRMED_LEGITIMATE", next: "close_case" },
    { outcome: "uncertain", state: "UNCERTAIN", next: "human_handoff" },
  ] as const;

  test("each outcome moves the case to its own state and prompts the agent onward", async () => {
    for (const { outcome, state, next } of DISPOSITIONS) {
      resetSeams();
      seams.caseRow = caseRow("VERIFYING", "SV-JOURNEY-VER");
      seams.caseByRef = caseRow("VERIFYING", "SV-JOURNEY-VER");
      seams.caseUpdated = { id: "case-stub", state };

      const res = await call(VERIFY, { conversation_id: CONVERSATION_ID, outcome }, SECRET);
      expect(res.status).toBe(200);
      expect(DispositionBody.parse(await res.json())).toEqual({
        ok: true,
        outcome,
        next_prompt_key: next,
        case_ref: "SV-JOURNEY-VER",
        state,
      });
      // The three outcomes must not collapse into one another: a fraud report
      // that landed on CONFIRMED_LEGITIMATE would close the case instead of
      // staging a freeze.
      expect(seams.caseUpdates).toEqual([{ state }]);
    }
  });

  test("the disposition is refused when it cannot be audited", async () => {
    seams.auditDown = true;
    seams.caseRow = caseRow("VERIFYING", "SV-JOURNEY-VER");
    seams.caseByRef = caseRow("VERIFYING", "SV-JOURNEY-VER");
    const res = await call(VERIFY, VERIFY.body, SECRET);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "audit_unavailable" });
    expect(seams.caseUpdates).toEqual([]);

    await absorbOrphanedAuditRejection("SV-JOURNEY-VER");
  });

  // NOTE ON A BRANCH THIS SUITE CANNOT REACH. The route re-checks
  // `canTransition(state, target)` and answers 409 `illegal_transition` if it
  // is false. With the tables as they stand that branch is defensive: every
  // disposition is reachable from every state the guard admits
  // (DISCLOSED and VERIFYING both allow CONFIRMED_FRAUD, CONFIRMED_LEGITIMATE
  // and UNCERTAIN). The check earns its keep against a future fourth outcome or
  // a tightened transition table, not against today's inputs — so what is
  // asserted here is the branch that IS reachable, and the fact that no input
  // reaches the other one.
  test("every disposition from an admitted state is legal, so the in-route check never fires", async () => {
    for (const from of ["DISCLOSED", "VERIFYING"]) {
      for (const { outcome, state } of DISPOSITIONS) {
        resetSeams();
        seams.caseRow = caseRow(from, "SV-JOURNEY-VER");
        seams.caseByRef = caseRow(from, "SV-JOURNEY-VER");
        seams.caseUpdated = { id: "case-stub", state };
        const res = await call(VERIFY, { conversation_id: CONVERSATION_ID, outcome }, SECRET);
        expect({ from, outcome, status: res.status }).toEqual({ from, outcome, status: 200 });
      }
    }
  });

  test("a state the tool may not act on is refused and audited before any disposition", async () => {
    // CONFIRMED_FRAUD is not one of this tool's admitted states: fraud has
    // already been decided, and re-asking for a disposition must not overwrite
    // it with CONFIRMED_LEGITIMATE.
    seams.caseRow = caseRow("CONFIRMED_FRAUD", "SV-JOURNEY-VER");
    const res = await call(VERIFY, VERIFY.body, SECRET);
    expect(res.status).toBe(409);
    const { error } = await readRefusal(res);
    expect(error).toBe("tool verify_transaction cannot act on a case in state CONFIRMED_FRAUD");
    expect(seams.caseUpdates).toEqual([]);
    await drainFireAndForget();
    expect(seams.audit[0]).toMatchObject({ intent: "tool_refused_verify_transaction" });
    expect(auditMeta()).toMatchObject({
      tool: "verify_transaction",
      state: "CONFIRMED_FRAUD",
      reason: "state_precondition_failed",
    });
  });

  test("an outcome outside the enum is refused, not coerced", async () => {
    const res = await call(
      VERIFY,
      { conversation_id: CONVERSATION_ID, outcome: "confirmed_fraud_lol" },
      SECRET,
    );
    expect(res.status).toBe(422);
    expect(SchemaError.parse(await res.json())).toEqual({
      error:
        "conversation_id and outcome (confirmed_fraud | confirmed_legitimate | uncertain) are required",
      code: "invalid_payload",
    });
    expect(seams.touched).toEqual([]);
  });
});

/* ───────────────────────────── human_handoff ────────────────────────────── */

describe("POST /api/elevenlabs/tools/human-handoff", () => {
  beforeEach(() => {
    process.env.AGENT_TOOL_SECRET = SECRET;
    process.env.AGENT_TOOL_ALLOWED = "human_handoff";
  });

  test("escalates an escalatable case and queues the fraud specialist", async () => {
    seams.caseRow = caseRow("FREEZE_STAGED", "SV-JOURNEY-HND");
    seams.caseByRef = caseRow("FREEZE_STAGED", "SV-JOURNEY-HND");
    seams.caseUpdated = { id: "case-stub", state: "ESCALATED" };

    const res = await call(HANDOFF, HANDOFF.body, SECRET);
    expect(res.status).toBe(200);
    expect(HandoffBody.parse(await res.json())).toEqual({
      ok: true,
      specialist: "fraud_specialist",
      eta_secs: 120,
      queue_position: 1,
      case_ref: "SV-JOURNEY-HND",
      state: "ESCALATED",
    });
    expect(seams.caseUpdates).toEqual([
      { state: "ESCALATED", handoffQueued: true, handoffSpecialist: "fraud_specialist" },
    ]);
  });

  test("queues the specialist without moving a case that must not escalate", async () => {
    // DISCLOSED is a state the tool may act on, but the state machine does not
    // allow DISCLOSED → ESCALATED. The caller still gets a specialist; the case
    // must not be dragged into a state it cannot legally reach.
    seams.caseRow = caseRow("DISCLOSED", "SV-JOURNEY-HND");
    seams.caseUpdated = { id: "case-stub", state: "DISCLOSED" };

    const res = await call(HANDOFF, HANDOFF.body, SECRET);
    expect(res.status).toBe(200);
    expect(HandoffBody.parse(await res.json())).toMatchObject({
      ok: true,
      state: "DISCLOSED",
      specialist: "fraud_specialist",
    });
    expect(seams.caseUpdates).toEqual([
      { handoffQueued: true, handoffSpecialist: "fraud_specialist" },
    ]);
    await drainFireAndForget();
    expect(auditMeta()).toMatchObject({
      tool: "human_handoff",
      escalated: false,
      to: null,
      from: "DISCLOSED",
    });
  });

  test("the specialist's summary is redacted before it is queued", async () => {
    seams.caseRow = caseRow("FREEZE_STAGED", "SV-JOURNEY-HND");
    seams.caseByRef = caseRow("FREEZE_STAGED", "SV-JOURNEY-HND");
    seams.caseUpdated = { id: "case-stub", state: "ESCALATED" };

    const summary =
      "Caller read out card 4242 4242 4242 4242 and said the OTP is 88213, email aisha@example.com.";
    await call(HANDOFF, { conversation_id: CONVERSATION_ID, summary }, SECRET);
    await drainFireAndForget();

    const redacted = String(seams.audit[0]?.redactedText ?? "");
    expect(redacted).toContain("[REDACTED]");
    for (const spoken of ["4242424242424242", "88213", "aisha@example.com"]) {
      expect(redacted).not.toContain(spoken);
    }
  });

  test("a handoff that cannot be audited is refused", async () => {
    seams.auditDown = true;
    seams.caseRow = caseRow("FREEZE_STAGED", "SV-JOURNEY-HND");
    const res = await call(HANDOFF, HANDOFF.body, SECRET);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "audit_unavailable" });
    expect(seams.caseUpdates).toEqual([]);
    await absorbOrphanedAuditRejection("SV-JOURNEY-HND");
  });

  test("a failed queue write is a 503", async () => {
    seams.caseRow = caseRow("DISCLOSED", "SV-JOURNEY-HND");
    // `caseUpdated` left null, so the queue write is reached and throws.
    const res = await call(HANDOFF, HANDOFF.body, SECRET);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "handoff_queue_failed" });
  });

  test("an escalation lost to a concurrent transition still queues the specialist", async () => {
    // UNCERTAIN → ESCALATED is legal, so the guard's optimistic read commits
    // to the transition; by the time the single writer runs, the case is
    // CLOSED. The escalation is dropped — the case keeps the state the guard
    // read, so the response never claims a state the case did not reach — but
    // the caller still gets a specialist, which is the point of the tool.
    seams.caseRow = caseRow("UNCERTAIN", "SV-JOURNEY-HND");
    seams.caseByRef = caseRow("CLOSED", "SV-JOURNEY-HND");
    seams.caseUpdated = { id: "case-stub", state: "UNCERTAIN" };
    const res = await call(HANDOFF, HANDOFF.body, SECRET);
    expect(res.status).toBe(200);
    expect(HandoffBody.parse(await res.json())).toEqual({
      ok: true,
      specialist: "fraud_specialist",
      eta_secs: 120,
      queue_position: 1,
      case_ref: "SV-JOURNEY-HND",
      state: "UNCERTAIN",
    });
    expect(seams.caseUpdates).toEqual([
      { handoffQueued: true, handoffSpecialist: "fraud_specialist" },
    ]);
  });

  test("an empty summary is refused — a specialist with nothing to read is no handoff", async () => {
    const res = await call(HANDOFF, { conversation_id: CONVERSATION_ID, summary: "" }, SECRET);
    expect(res.status).toBe(422);
    expect(seams.touched).toEqual([]);
  });
});

/* ──────────────────────────── switch_language ───────────────────────────── */

describe("POST /api/elevenlabs/tools/switch-language", () => {
  beforeEach(() => {
    process.env.AGENT_TOOL_SECRET = SECRET;
    process.env.AGENT_TOOL_ALLOWED = "switch_language";
  });

  test("switches the language in one round trip and normalises the tag", async () => {
    seams.rawResults = [[{ caseRef: "SV-JOURNEY-LANG", state: "ANSWERED" }]];
    const res = await call(
      LANGUAGE,
      { conversation_id: CONVERSATION_ID, language: "AR-ae" },
      SECRET,
    );
    expect(res.status).toBe(200);
    expect(LanguageBody.parse(await res.json())).toEqual({
      ok: true,
      // Stored lowercased: "AR-ae" and "ar-AE" are the same language, and two
      // spellings of one tag in one column splits the preference analytics.
      language: "ar-ae",
      case_ref: "SV-JOURNEY-LANG",
      state: "ANSWERED",
    });
    // This tool sits on the conversational critical path: the happy path is
    // ONE round trip, folded into the guarded UPDATE.
    expect(seams.touched.filter((s) => s === "$queryRaw")).toHaveLength(1);
  });

  test("an unknown conversation costs a second query and is refused", async () => {
    seams.rawResults = [[], []];
    const res = await call(LANGUAGE, LANGUAGE.body, SECRET);
    expect(res.status).toBe(409);
    const { error } = await readRefusal(res);
    expect(error).toBe("no live case for this conversation_id");
    // One for the guarded UPDATE, one to tell "no case" from "wrong state".
    expect(seams.touched.filter((s) => s === "$queryRaw")).toHaveLength(2);
  });

  test("a case the tool may not act on is refused by state, and audited", async () => {
    seams.rawResults = [[], [{ caseRef: "SV-JOURNEY-LANG", state: "CLOSED" }]];
    const res = await call(LANGUAGE, LANGUAGE.body, SECRET);
    expect(res.status).toBe(409);
    const { error } = await readRefusal(res);
    expect(error).toBe("tool switch_language cannot act on a case in state CLOSED");
    await drainFireAndForget();
    expect(seams.audit[0]).toMatchObject({ intent: "tool_refused_switch_language" });
    expect(auditMeta()).toMatchObject({
      tool: "switch_language",
      state: "CLOSED",
      reason: "state_precondition_failed",
    });
  });

  test("a failed update is a 503, and no language is claimed to have changed", async () => {
    db.$queryRaw = (async () => {
      throw new Error("database unreachable");
    }) as unknown as typeof db.$queryRaw;
    const res = await call(LANGUAGE, LANGUAGE.body, SECRET);
    expect(res.status).toBe(503);
    const { error } = await readRefusal(res);
    expect(error).toBe("case_update_failed");
  });

  test("a language that is not a BCP-47 tag is refused before the database", async () => {
    for (const language of ["e", "english!", "ar_AE", "ar-ae-", "12", "a".repeat(17)]) {
      const res = await call(LANGUAGE, { conversation_id: CONVERSATION_ID, language }, SECRET);
      expect({ language, status: res.status }).toEqual({ language, status: 422 });
    }
    expect(seams.touched).toEqual([]);
  });

  test("well-formed tags are normalised rather than rejected", async () => {
    for (const [input, stored] of [
      ["en", "en"],
      ["ar", "ar"],
      ["ur-AE", "ur-ae"],
      ["pt-BR", "pt-br"],
      ["zh-Hans-CN", "zh-hans-cn"],
    ] as const) {
      seams.rawResults = [[{ caseRef: "SV-JOURNEY-LANG", state: "ANSWERED" }]];
      const res = await call(
        LANGUAGE,
        { conversation_id: CONVERSATION_ID, language: input },
        SECRET,
      );
      expect(LanguageBody.parse(await res.json()).language).toBe(stored);
    }
  });
});

/* ─────────────────────────────── signed_url ─────────────────────────────── */

describe("POST /api/elevenlabs/signed-url", () => {
  /** What the handler asked ElevenLabs for; a property so TS cannot narrow it. */
  const upstream: { call: { url: string; method: string; headers: Headers } | null } = {
    call: null,
  };

  const respondWith = (body: string, status = 200): void => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      upstream.call = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers ?? {}),
      };
      return new Response(body, { status });
    }) as typeof globalThis.fetch;
  };

  beforeEach(() => {
    process.env.AGENT_TOOL_SECRET = SECRET;
    process.env.AGENT_TOOL_ALLOWED = "signed_url";
    process.env.ELEVENLABS_AGENT_ID = PINNED_AGENT;
    upstream.call = null;
    respondWith(JSON.stringify({ signed_url: "wss://elevenlabs.example/signed" }));
  });

  test("mints a credential for the pinned agent, from a query parameter", async () => {
    const res = await call(SIGNED, {}, SECRET);
    expect(res.status).toBe(200);
    expect(SignedUrlBody.parse(await res.json())).toEqual({
      ok: true,
      agent_id: PINNED_AGENT,
      connection_type: "websocket",
      credential: "wss://elevenlabs.example/signed",
      expires_in_secs: 900,
    });
    // Both endpoints are GET with `agent_id` as a QUERY parameter — the docs'
    // curl samples read as if a body were accepted, and a body is a 405.
    expect(upstream.call?.method).toBe("GET");
    expect(upstream.call?.url).toBe(
      `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${PINNED_AGENT}`,
    );
  });

  test("the API key goes upstream in a header and never into the response", async () => {
    const raw = await (await call(SIGNED, {}, SECRET)).text();
    expect(upstream.call?.headers.get("xi-api-key")).toBe("test-elevenlabs-api-key");
    expect(raw).not.toContain("test-elevenlabs-api-key");
    expect(raw).not.toContain(SECRET);
  });

  test("a webrtc request mints a conversation token instead", async () => {
    const res = await call(SIGNED, { connection_type: "webrtc" }, SECRET);
    expect(SignedUrlBody.parse(await res.json()).connection_type).toBe("webrtc");
    expect(upstream.call?.url).toBe(
      `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${PINNED_AGENT}`,
    );
  });

  test("a client-supplied agent_id that disagrees with the pin is refused", async () => {
    const res = await call(SIGNED, { agent_id: "agent_someone_elses_9999" }, SECRET);
    expect(res.status).toBe(403);
    const { error } = await readRefusal(res);
    expect(error).toBe("agent_not_allowed");
    // Nothing was minted: a refused call must not have spent a credential.
    expect(upstream.call).toBeNull();
  });

  test("a client-supplied agent_id that matches the pin is honoured", async () => {
    const res = await call(SIGNED, { agent_id: PINNED_AGENT }, SECRET);
    expect(res.status).toBe(200);
    expect(SignedUrlBody.parse(await res.json()).agent_id).toBe(PINNED_AGENT);
  });

  test("an unpinned deployment refuses rather than minting for whatever id is asked", async () => {
    delete process.env.ELEVENLABS_AGENT_ID;
    const res = await call(SIGNED, {}, SECRET);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No agent configured: set ELEVENLABS_AGENT_ID" });
    expect(upstream.call).toBeNull();
  });

  test("an upstream failure is a 503 with a bounded detail", async () => {
    respondWith("x".repeat(5_000), 500);
    const res = await call(SIGNED, {}, SECRET);
    expect(res.status).toBe(503);
    const detail = ((await res.json()) as { error: string }).error;
    expect(detail.startsWith("ElevenLabs 500: ")).toBe(true);
    expect(detail).toHaveLength("ElevenLabs 500: ".length + 200);
    expect(detail).not.toContain("test-elevenlabs-api-key");
  });

  test("an upstream 200 with no credential is a 503, not a 200 with a null url", async () => {
    respondWith(JSON.stringify({ signed_url: null, token: null }));
    const res = await call(SIGNED, {}, SECRET);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "ElevenLabs returned no connection credential" });
  });

  test("the webrtc token field is accepted as the credential", async () => {
    respondWith(JSON.stringify({ token: "tok_live_abc123" }));
    const res = await call(SIGNED, { connection_type: "webrtc" }, SECRET);
    expect(SignedUrlBody.parse(await res.json()).credential).toBe("tok_live_abc123");
  });

  test("authorisation runs before the body is even parsed", async () => {
    // The one route in this file that guards FIRST. A malformed body from an
    // out-of-scope caller is a 403, not a 400 — such a caller learns nothing
    // about this endpoint's schema.
    process.env.AGENT_TOOL_ALLOWED = "card_freeze";
    const res = await call(SIGNED, "{ not json", SECRET);
    expect(res.status).toBe(403);
    const { error } = await readRefusal(res);
    expect(error).toBe("tool_not_in_scope");
    expect(upstream.call).toBeNull();
  });

  test("an authorised caller with a malformed body is a 400", async () => {
    const res = await call(SIGNED, "{ not json", SECRET);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
    expect(upstream.call).toBeNull();
  });

  test("an unknown connection_type is refused", async () => {
    const res = await call(SIGNED, { connection_type: "carrier-pigeon" }, SECRET);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid body" });
    expect(upstream.call).toBeNull();
  });
});

/* ──────────────────────── POST /api/webhooks/elevenlabs ──────────────────── */

describe("POST /api/webhooks/elevenlabs", () => {
  const nowSeconds = () => String(Math.floor(Date.now() / 1000));

  const payload = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      type: "post_call_transcription",
      event_timestamp: Math.floor(Date.now() / 1000),
      data: { agent_id: "agent_live", conversation_id: CONVERSATION_ID, status: "done" },
      ...overrides,
    });

  const sign = (body: string, t: string, secret = WEBHOOK_SECRET): string =>
    `t=${t},v0=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

  const deliver = (body: string, signature: string | null): Promise<Response> =>
    elevenLabsWebhook(
      new Request("http://localhost/api/webhooks/elevenlabs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(signature === null ? {} : { "elevenlabs-signature": signature }),
        },
        body,
      }) as Parameters<typeof elevenLabsWebhook>[0],
    );

  const duplicate = (): void => {
    seams.webhookCreate = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
    });
  };

  beforeEach(() => {
    process.env.ELEVENLABS_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });

  test("an unconfigured webhook refuses to ingest, even with a valid signature", async () => {
    delete process.env.ELEVENLABS_WEBHOOK_SECRET;
    const body = payload();
    const res = await deliver(body, sign(body, nowSeconds()));
    expect(res.status).toBe(503);
    expect(ErrorBody.parse(await res.json())).toEqual({ error: "ingest_unconfigured" });
    expect(seams.touched).toEqual([]);
  });

  test("every verification failure is a 401 that writes nothing", async () => {
    const body = payload();
    const t = nowSeconds();
    const cases: { name: string; signature: string | null }[] = [
      { name: "no signature header", signature: null },
      { name: "empty header", signature: "" },
      { name: "no digest", signature: `t=${t}` },
      { name: "no timestamp", signature: `v0=${"ab".repeat(32)}` },
      { name: "forged digest", signature: `t=${t},v0=${"ab".repeat(32)}` },
      { name: "wrong secret", signature: sign(body, t, "a-different-secret") },
      {
        name: "stale timestamp",
        signature: sign(body, String(Math.floor(Date.now() / 1000) - 3600)),
      },
    ];
    for (const { name, signature } of cases) {
      const res = await deliver(body, signature);
      // A 5xx here would make ElevenLabs retry a forgery forever.
      expect({ name, status: res.status }).toEqual({ name, status: 401 });
      expect(ErrorBody.parse(await res.json())).toEqual({ error: "invalid_signature" });
    }
    expect(seams.touched).toEqual([]);
  });

  test("a body edited after signing is refused", async () => {
    const signature = sign(payload(), nowSeconds());
    const tampered = payload().replace(CONVERSATION_ID, "conv-someone-elses");
    const res = await deliver(tampered, signature);
    expect(res.status).toBe(401);
    expect(seams.touched).toEqual([]);
  });

  test("a valid signature over a non-JSON body is refused as a signature failure", async () => {
    // KNOWN GAP (asserted as-is, not fixed here): `constructEvent` verifies the
    // HMAC and then JSON-parses inside the same try block, so a delivery whose
    // signature is valid but whose body is not JSON is reported as
    // `invalid_signature`. The message is wrong — nothing was invalid about the
    // signature — but the refusal itself is right, and telling a sender its
    // signature checked out would be the worse bug.
    const res = await deliver("this is not json", sign("this is not json", nowSeconds()));
    expect(res.status).toBe(401);
    expect(ErrorBody.parse(await res.json())).toEqual({ error: "invalid_signature" });
    expect(seams.touched).toEqual([]);
  });

  test("a verified delivery is enqueued exactly once, with its fields extracted", async () => {
    const body = payload();
    const res = await deliver(body, sign(body, nowSeconds()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, received: true });
    expect(seams.touched.filter((s) => s === "webhookEvent.create")).toHaveLength(1);
    expect(WebhookRow.parse(seams.webhookRow)).toEqual({
      provider: "elevenlabs",
      eventType: "post_call_transcription",
      conversationId: CONVERSATION_ID,
      agentId: "agent_live",
      // A number, not the string it may have arrived as: the replay index is
      // built on this value.
      eventTimestamp: Math.floor(Date.now() / 1000),
    });
    // The route answers 2xx before ingest runs — handing off without await is
    // what keeps provider retries from queueing behind database writes — and
    // the hand-off is visible at the ingest seam.
    await drainFireAndForget();
    expect(seams.touched).toContain("webhookEvent.findUnique");
  });

  test("a string event_timestamp is coerced to a number so replays dedupe", async () => {
    const seconds = Math.floor(Date.now() / 1000);
    const body = payload({ event_timestamp: String(seconds) });
    await deliver(body, sign(body, nowSeconds()));
    expect(WebhookRow.parse(seams.webhookRow).eventTimestamp).toBe(seconds);
  });

  test("a missing event_timestamp is stored as null rather than NaN", async () => {
    const body = JSON.stringify({
      type: "post_call_transcription",
      data: { agent_id: "agent_live", conversation_id: CONVERSATION_ID },
    });
    await deliver(body, sign(body, nowSeconds()));
    expect(WebhookRow.parse(seams.webhookRow).eventTimestamp).toBeNull();
  });

  test("an already-processed replay is acknowledged without a second write", async () => {
    const body = payload();
    duplicate();
    seams.webhookFound = { id: "evt-1", processed: true };
    const res = await deliver(body, sign(body, nowSeconds()));
    // The provider must see 2xx: a replay is success, and a 4xx would make it
    // redeliver a delivery that is already stored.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
  });

  test("a replay of an unprocessed delivery is reprocessed", async () => {
    const body = payload();
    duplicate();
    seams.webhookFound = { id: "evt-1", processed: false };
    const res = await deliver(body, sign(body, nowSeconds()));
    // The route answers 2xx before ingest runs — that is the whole point of
    // handing off without await — and this suite proves the hand-off reached
    // the ingest seam and stopped there, rather than writing anywhere.
    await drainFireAndForget();
    expect(seams.touched).toContain("webhookEvent.findUnique");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, reprocessing: true });
  });

  test("a replay whose row vanished between writes is treated as a duplicate", async () => {
    const body = payload();
    duplicate();
    seams.webhookFound = null;
    const res = await deliver(body, sign(body, nowSeconds()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
  });

  test("a persist failure is a 503 so the provider retries", async () => {
    const body = payload();
    seams.webhookCreate = new Error("database unreachable");
    const res = await deliver(body, sign(body, nowSeconds()));
    expect(res.status).toBe(503);
    expect(ErrorBody.parse(await res.json())).toEqual({ error: "ingest_persist_failed" });
  });

  test("no webhook response echoes the webhook secret", async () => {
    const body = payload();
    const forged = await deliver(body, sign(body, nowSeconds(), "not-the-secret"));
    expect(await forged.text()).not.toContain(WEBHOOK_SECRET);
    delete process.env.ELEVENLABS_WEBHOOK_SECRET;
    const unconfigured = await deliver(body, sign(body, nowSeconds()));
    expect(await unconfigured.text()).not.toContain(WEBHOOK_SECRET);
  });
});

/* ─────────────────────────── response contracts ─────────────────────────── */

const StagedBody = z.object({
  ok: z.literal(true),
  staged: z.literal(true),
  committed: z.literal(false),
  reversal_window_secs: z.number(),
  reference: z.string(),
  case_ref: z.string(),
  state: z.string(),
});

const UnavailableBody = z.object({
  ok: z.literal(false),
  staged: z.literal(false),
  committed: z.literal(false),
  error: z.string(),
});

const IllegalTransitionBody = UnavailableBody.extend({ code: z.literal("illegal_transition") });

const DispositionBody = z.object({
  ok: z.literal(true),
  outcome: z.enum(["confirmed_fraud", "confirmed_legitimate", "uncertain"]),
  next_prompt_key: z.string(),
  case_ref: z.string(),
  state: z.string(),
});

const HandoffBody = z.object({
  ok: z.literal(true),
  specialist: z.string(),
  eta_secs: z.number(),
  queue_position: z.number(),
  case_ref: z.string(),
  state: z.string(),
});

const LanguageBody = z.object({
  ok: z.literal(true),
  language: z.string(),
  case_ref: z.string(),
  state: z.string(),
});

const SignedUrlBody = z.object({
  ok: z.literal(true),
  agent_id: z.string(),
  connection_type: z.enum(["websocket", "webrtc"]),
  credential: z.string().min(1),
  expires_in_secs: z.number(),
});

const SchemaError = z.object({ error: z.string(), code: z.string().optional() });

const ErrorBody = z.object({ error: z.string() });

const AuditMeta = z.record(z.string(), z.unknown());

const WebhookRow = z.object({
  provider: z.string(),
  eventType: z.string(),
  conversationId: z.string().nullable(),
  agentId: z.string().nullable(),
  eventTimestamp: z.number().nullable(),
});
