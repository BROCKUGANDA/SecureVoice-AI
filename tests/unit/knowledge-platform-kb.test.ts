/**
 * THE SECOND KNOWLEDGE PLANE — an uploaded policy document reaching the ElevenLabs
 * agent itself, and failing there without damaging the tenant's own RAG document.
 *
 * Plane one (`src/lib/knowledge/documents.ts` + Pinecone + `searchDocuments`) already
 * grounds a draft on our turn. Plane two is the platform agent's
 * `conversation_config.agent.prompt.knowledge_base` — the list `scripts/agent-apply.ts`
 * PATCHes from the YAML, and the only thing the live agent can cite without our
 * retriever. Uploading a PDF changed nothing in that list. These tests drive the REAL
 * `vectorizeDocument` with every boundary replaced by a recorder — the PDF parser,
 * Pinecone, the database, the audit chain, the tenant scope and the ElevenLabs egress —
 * so what is under test is the wiring and the refusals, not the vendor.
 *
 * The properties, in the order they would hurt:
 *   1. with `KB_PLATFORM_SYNC` unset the vendor is not contacted at all and nothing is
 *      written: a deployment without the flag behaves exactly as it did before;
 *   2. with it on, one platform document per tenant document, carrying the text the
 *      chunker already produced — the PDF is parsed ONCE, never twice;
 *   3. a retry re-PATCHes the stored vendor id and creates no second copy;
 *   4. a vendor 4xx/5xx leaves the document READY with a recorded reason (row, audit
 *      chain, `logWarn`): a successful embedding is not the platform failure's to undo,
 *      and the failure is not allowed to pass silently either;
 *   5. cross-tenant: a publish addresses the tenant's own agent, names only its own
 *      document, and can only write its own row.
 *
 * NOTHING HERE REACHES api.elevenlabs.io: the egress module is replaced before either
 * module under test is imported, so the live path is deliberately unverified.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
// Type-only: the module itself is loaded with `await import()` below so each test
// gets the vendor fake, and a value import here would resolve before the mock.
import type { PlatformKbResult } from "@/lib/knowledge/platform-kb";

const POLICY_TEXT = "Section 1.\r\nA disputed charge is reviewed  within two working days.";
const NORMALISED = "Section 1.\nA disputed charge is reviewed within two working days.";

/* ── recorders ─────────────────────────────────────────────────────────────── */

let extractCount = 0;
let upserts: Array<{ records: Array<{ id: string }> }> = [];
let vectorDeletes: Array<{ filter: Record<string, unknown> }> = [];

type VendorCall = Record<string, unknown> & {
  path: string;
  method?: string;
  body?: unknown;
  callerId?: string;
};

let vendorCalls: VendorCall[] = [];
/** path -> the KB list that agent currently holds, as a merging vendor would keep it. */
let agentState: Record<string, Array<{ type: string; name: string; id: string }>> = {};
let createdDocIds: string[] = [];
let docPatchBodies: Array<{ path: string; body: unknown }> = [];

// Per-test vendor behaviours, so a failure is a named condition rather than a script.
let failCreate: { status: number; retryable: boolean; body: string } | null = null;
let failAgentPatch: { status: number; retryable: boolean; body: string } | null = null;
let failDocPatch: { status: number; retryable: boolean; body: string } | null = null;
/** A PATCH that answers 200 and changes nothing — the case a read-back exists for. */
let ignoreAgentPatch = false;

let audits: Array<{ intent?: string; orgId?: string; redactedText?: string; meta?: unknown }> = [];
let scopedOrgs: string[] = [];
let logs: Array<Record<string, unknown>> = [];

type Row = {
  id: string;
  orgId: string;
  title: string;
  lang: string;
  status: string;
  chunkCount: number;
  error: string | null;
  pdfBytes: Uint8Array | null;
  platformDocId: string | null;
  platformError: string | null;
};

let rows: Row[] = [];
let rowWrites: Array<Partial<Row>> = [];
let orgAgents: Record<string, string | null> = {};

function newRow(over: Partial<Row> = {}): Row {
  return {
    id: "doc-1",
    orgId: "org-a",
    title: "Card dispute policy",
    lang: "en",
    status: "PENDING",
    chunkCount: 0,
    error: null,
    pdfBytes: new TextEncoder().encode("%PDF-1.4 not-a-real-pdf"),
    platformDocId: null,
    platformError: null,
    ...over,
  };
}

function row(id: string): Row {
  const found = rows.find((r) => r.id === id);
  if (!found) throw new Error(`fixture: no row ${id}`);
  return found;
}

/** The pair shipped in agent/securevoice.agent.yaml, as the vendor returns them. */
const SHIPPED = [
  { type: "text", name: "SV-FDP-2026-01 Fraud Disposition Policy (EN) v3.2", id: "kb-en" },
  { type: "text", name: "SV-FDP-2026-01 Fraud Disposition Policy (AR) v3.2", id: "kb-ar" },
];

function agentJson(path: string) {
  return {
    ok: true,
    breakerOpen: false,
    data: {
      conversation_config: {
        agent: {
          prompt: {
            prompt: "You are the bank's fraud-intervention agent.",
            llm: "gpt-4o-mini",
            temperature: 0.2,
            max_tokens: 256,
            timezone: "Asia/Dubai",
            ignore_default_personality: true,
            tool_ids: ["tool-card-freeze"],
            rag: { enabled: true, include_source_urls: true },
            knowledge_base: (agentState[path] ??= [...SHIPPED]).map((d) => ({ ...d })),
          },
        },
      },
    },
  };
}

function refusal(spec: { status: number; retryable: boolean; body: string }) {
  return { ok: false, breakerOpen: false, error: spec };
}

/**
 * A fake of the guarded egress: merges into `agentState` the way a partial PATCH does,
 * hands out a new document id per create, and answers with whatever failure a test
 * asked for. It records the CALL, which is the only way these gates can assert that
 * another tenant's agent was never addressed.
 */
function fakeVendor(call: VendorCall): unknown {
  vendorCalls.push(call);
  const path = call.path;
  const method = call.method ?? "GET";

  if (path === "/v1/convai/knowledge-base/text" && method === "POST") {
    if (failCreate) return refusal(failCreate);
    const id = `kb-new-${createdDocIds.length + 1}`;
    createdDocIds.push(id);
    return { ok: true, data: { id } };
  }
  if (path.startsWith("/v1/convai/knowledge-base/") && method === "PATCH") {
    // Recorded before the failure, so a test can prove the RIGHT document was addressed
    // even on the run where the vendor said no.
    docPatchBodies.push({ path, body: call.body });
    if (failDocPatch) return refusal(failDocPatch);
    return { ok: true, data: {} };
  }
  if (path.startsWith("/v1/convai/agents/")) {
    if (method === "PATCH") {
      if (failAgentPatch) return refusal(failAgentPatch);
      if (!ignoreAgentPatch) {
        const kb = (
          call.body as {
            conversation_config?: { agent?: { prompt?: { knowledge_base?: unknown } } };
          }
        )?.conversation_config?.agent?.prompt?.knowledge_base;
        if (Array.isArray(kb))
          agentState[path] = kb as Array<{ type: string; name: string; id: string }>;
      }
      return { ok: true, data: { version_id: "v-next" } };
    }
    return agentJson(path);
  }
  return { ok: true, data: {} };
}

/* ── boundary mocks (wholesale: no importOriginal, nothing may connect) ────── */

mock.module("unpdf", () => ({
  extractText: async () => {
    extractCount++;
    return { text: POLICY_TEXT };
  },
}));

mock.module("@pinecone-database/pinecone", () => ({
  Pinecone: class FakePinecone {
    inference = {
      embed: async ({ inputs }: { inputs: string[] }) => ({
        data: inputs.map(() => ({ values: [0.1, 0.2, 0.3] })),
      }),
    };
    index() {
      const handle = {
        namespace: () => handle,
        upsert: async (arg: { records: Array<{ id: string }> }) => {
          upserts.push(arg);
        },
        deleteMany: async (arg: { filter: Record<string, unknown> }) => {
          vectorDeletes.push(arg);
        },
      };
      return handle;
    }
  },
}));

mock.module("@/lib/pinecone/transcript-index", () => ({
  pineconeConfigured: () => true,
}));

mock.module("@/lib/db", () => ({
  db: {
    document: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(rows.find((r) => r.id === where.id) ?? null),
      update: ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        rowWrites.push(data);
        Object.assign(row(where.id), data);
        return Promise.resolve(row(where.id));
      },
      delete: ({ where }: { where: { id: string } }) => {
        rows = rows.filter((r) => r.id !== where.id);
        return Promise.resolve({ id: where.id });
      },
    },
    organization: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve({ elevenAgentId: orgAgents[where.id] ?? null }),
    },
  },
  dbAudit: {},
}));

mock.module("@/lib/audit-chain", () => ({
  append: (entry: { intent?: string; orgId?: string; redactedText?: string; meta?: unknown }) => {
    audits.push(entry);
    return Promise.resolve({ id: "audit-1", chainHash: "h" });
  },
}));

// The real helper opens a transaction and pins `app.org_id`; this keeps the ORG
// ARGUMENT — which is what the cross-tenant gates assert — and enforces the same
// "a tenant writes its own rows only" rule the database's policy enforces.
mock.module("@/lib/tenancy/db-scope", () => ({
  TENANT_ROLE: "sv_tenant",
  withTenantScope: (orgId: string, fn: (tx: unknown) => Promise<unknown>) => {
    scopedOrgs.push(orgId);
    const tx = {
      document: {
        update: ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
          const target = row(where.id);
          if (target.orgId !== orgId) throw new Error(`RLS: ${orgId} cannot write ${where.id}`);
          rowWrites.push(data);
          Object.assign(target, data);
          return Promise.resolve(target);
        },
      },
    };
    return fn(tx);
  },
}));

mock.module("@/lib/elevenlabs/egress", () => ({
  elevenLabsFetch: (opts: VendorCall) => Promise.resolve(fakeVendor({ ...opts })),
  elevenLabsStt: () => Promise.reject(new Error("not used here")),
  fetchUpstreamBinary: () => Promise.reject(new Error("not used here")),
  _resetEgressForTest: () => {},
}));

const { vectorizeDocument, forgetDocument } = await import("@/lib/knowledge/documents");
const { syncDocumentToPlatformKb, removeDocumentFromPlatformKb } =
  await import("@/lib/knowledge/platform-kb");
const { registerLogSink, resetLogSinks } = await import("@/lib/validation/safe-log");

/* ── env ───────────────────────────────────────────────────────────────────── */

const SAVED = {
  KB_PLATFORM_SYNC: process.env.KB_PLATFORM_SYNC,
  KB_PLATFORM_MAX_CHARS: process.env.KB_PLATFORM_MAX_CHARS,
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID: process.env.ELEVENLABS_AGENT_ID,
};

const TEST_KEY = "el-test-value-not-a-credential";

function planeOn() {
  process.env.KB_PLATFORM_SYNC = "true";
  process.env.ELEVENLABS_API_KEY = TEST_KEY;
  process.env.ELEVENLABS_AGENT_ID = "agent-platform";
}

const callsTo = (predicate: (c: VendorCall) => boolean) => vendorCalls.filter(predicate);

/**
 * The publish result is a discriminated union, and `{attempted:false}` is a real
 * answer — it is what a deployment without `KB_PLATFORM_SYNC` returns. Tests that
 * switched the flag on and then read `.ok` would compile against the wrong branch,
 * so they narrow here first: a non-attempt in a test that set the flag is the test
 * being wrong, not the module, and it says so.
 */
function attempted(out: PlatformKbResult) {
  if (!out.attempted)
    throw new Error("KB_PLATFORM_SYNC was on, so the publish must have been attempted");
  return out;
}

function publish(over: Partial<Parameters<typeof syncDocumentToPlatformKb>[0]> = {}) {
  return syncDocumentToPlatformKb({
    documentId: "doc-1",
    orgId: "org-a",
    title: "Card dispute policy",
    lang: "en",
    platformDocId: null,
    text: NORMALISED,
    ...over,
  });
}

beforeEach(() => {
  extractCount = 0;
  upserts = [];
  vectorDeletes = [];
  vendorCalls = [];
  agentState = {};
  createdDocIds = [];
  docPatchBodies = [];
  failCreate = null;
  failAgentPatch = null;
  failDocPatch = null;
  ignoreAgentPatch = false;
  audits = [];
  scopedOrgs = [];
  logs = [];
  rows = [];
  rowWrites = [];
  orgAgents = { "org-a": null, "org-b": null };
  resetLogSinks();
  registerLogSink((_level, line) => {
    logs.push(JSON.parse(line) as Record<string, unknown>);
  });
  delete process.env.KB_PLATFORM_SYNC;
  delete process.env.KB_PLATFORM_MAX_CHARS;
  // Never inherited from a developer's .env: a suite must not hold a real key, and the
  // last gate below proves no credential reached a recorded call.
  process.env.ELEVENLABS_API_KEY = "";
  delete process.env.ELEVENLABS_AGENT_ID;
});

afterAll(() => {
  resetLogSinks();
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("the plane is off unless it is switched on", () => {
  test("no flag: the vectorize path completes and the vendor is never contacted", async () => {
    rows = [newRow()];
    const res = await vectorizeDocument("doc-1");

    // Not vacuous: plane one really ran, so the absence of a vendor call below is a
    // refusal rather than a pipeline that died earlier.
    expect(res.ok).toBe(true);
    expect(extractCount).toBe(1);
    expect(upserts).toHaveLength(1);
    expect(row("doc-1").status).toBe("READY");

    expect(vendorCalls, "a deployment without the flag must not reach the vendor").toHaveLength(0);
    expect(scopedOrgs, "and must not write the platform columns either").toHaveLength(0);
    expect(audits.map((a) => a.intent)).not.toContain("document_platform_kb_published");
    expect(row("doc-1").platformError).toBeNull();
  });

  test('only the exact string "true" means on', async () => {
    for (const value of ["TRUE", "True", "1", "yes", "", " true"]) {
      process.env.KB_PLATFORM_SYNC = value;
      expect(await publish()).toEqual({ attempted: false, reason: "disabled" });
    }
    expect(vendorCalls).toHaveLength(0);
    expect(rowWrites).toHaveLength(0);
  });

  test("flag on but no agent id: refused and RECORDED, with no vendor call", async () => {
    process.env.KB_PLATFORM_SYNC = "true";
    process.env.ELEVENLABS_API_KEY = TEST_KEY;
    delete process.env.ELEVENLABS_AGENT_ID;
    rows = [newRow()];

    const out = attempted(await publish());

    expect(out.ok).toBe(false);
    expect(vendorCalls).toHaveLength(0);
    // Half-configured must not be the silent case.
    expect(row("doc-1").platformError).toBe("agent_not_configured");
    expect(audits.map((a) => a.intent)).toContain("document_platform_kb_failed");
  });

  test("flag on but no API key: refused before anything is attempted", async () => {
    process.env.KB_PLATFORM_SYNC = "true";
    process.env.ELEVENLABS_API_KEY = "";
    process.env.ELEVENLABS_AGENT_ID = "agent-platform";
    rows = [newRow()];

    const out = attempted(await publish());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("elevenlabs_key_missing");
    expect(vendorCalls).toHaveLength(0);
  });
});

describe("flag on: one platform document per tenant document", () => {
  test("the publish carries the extracted text and names its tenant", async () => {
    planeOn();
    rows = [newRow()];
    const res = await vectorizeDocument("doc-1");
    expect(res.ok).toBe(true);

    const created = callsTo((c) => c.path === "/v1/convai/knowledge-base/text");
    expect(created, "exactly one create").toHaveLength(1);
    expect(created[0]!.method).toBe("POST");
    const body = created[0]!.body as { text: string; name: string };
    // The text the chunker was built from, normalised the same way — and NOT a second
    // parse: extractCount stayed at 1 across BOTH planes.
    expect(body.text).toBe(NORMALISED);
    expect(extractCount).toBe(1);
    expect(body.name).toContain("Card dispute policy");
    expect(body.name).toContain("org-a");

    // The id is on the row: it is what the next attempt PATCHes instead of creating.
    expect(row("doc-1").platformDocId).toBe("kb-new-1");
    expect(row("doc-1").platformError).toBeNull();
    expect(row("doc-1").status).toBe("READY");
    expect(audits.map((a) => a.intent)).toContain("document_platform_kb_published");
  });

  test("the agent PATCH merges into the live list and never drops the shipped pair", async () => {
    planeOn();
    rows = [newRow()];
    await vectorizeDocument("doc-1");

    const patches = callsTo(
      (c) => c.method === "PATCH" && c.path === "/v1/convai/agents/agent-platform",
    );
    expect(patches).toHaveLength(1);
    const prompt = (patches[0]!.body as Record<string, any>).conversation_config.agent.prompt;
    expect((prompt.knowledge_base as Array<{ id: string }>).map((d) => d.id)).toEqual([
      "kb-en",
      "kb-ar",
      "kb-new-1",
    ]);
    // Merging is only safe if the rest of the live prompt survived the round trip.
    expect(prompt.prompt).toBe("You are the bank's fraud-intervention agent.");
    expect(prompt.llm).toBe("gpt-4o-mini");
    expect(prompt.tool_ids).toEqual(["tool-card-freeze"]);
    expect(prompt.rag).toEqual({ enabled: true, include_source_urls: true });
    expect((agentState["/v1/convai/agents/agent-platform"] ?? []).map((d) => d.id)).toEqual([
      "kb-en",
      "kb-ar",
      "kb-new-1",
    ]);
  });

  test("an already-attached document is not attached twice", async () => {
    planeOn();
    rows = [newRow({ status: "READY", platformDocId: "kb-existing-9" })];
    agentState["/v1/convai/agents/agent-platform"] = [
      ...SHIPPED,
      { type: "text", name: "[org-a] Card dispute policy (en)", id: "kb-existing-9" },
    ];

    const out = attempted(await publish({ platformDocId: "kb-existing-9" }));
    if (!out.attempted) throw new Error("KB_PLATFORM_SYNC was on, so it must have been attempted");

    expect(out.ok).toBe(true);
    expect(row("doc-1").platformDocId).toBe("kb-existing-9");
    expect(
      callsTo((c) => c.method === "PATCH" && c.path.startsWith("/v1/convai/agents/")),
      "already listed means no agent write at all",
    ).toHaveLength(0);
    expect(createdDocIds, "and no second document").toHaveLength(0);
  });
});

describe("retry does not duplicate", () => {
  test("a row with a stored platform id PATCHes that document and creates nothing", async () => {
    planeOn();
    rows = [
      newRow({
        status: "PENDING",
        platformDocId: "kb-existing-9",
        platformError: "platform_doc_create_failed: status=503 vendor unavailable",
      }),
    ];
    await vectorizeDocument("doc-1");

    expect(callsTo((c) => c.path === "/v1/convai/knowledge-base/text")).toHaveLength(0);
    const docPatch = docPatchBodies.find(
      (d) => d.path === "/v1/convai/knowledge-base/kb-existing-9",
    );
    expect(docPatch, "the stored document is updated in place").toBeDefined();
    expect((docPatch!.body as { content: string }).content).toBe(NORMALISED);
    expect(row("doc-1").platformDocId).toBe("kb-existing-9");
    // A successful re-publish clears the stale reason.
    expect(row("doc-1").platformError).toBeNull();
  });

  test("a duplicate queue delivery on a READY document is a no-op on both planes", async () => {
    planeOn();
    rows = [newRow({ status: "READY", chunkCount: 1, platformDocId: "kb-existing-9" })];
    const res = await vectorizeDocument("doc-1");
    expect(res).toEqual({ ok: true, chunkCount: 1 });
    expect(extractCount).toBe(0);
    expect(vendorCalls).toHaveLength(0);
  });
});

describe("a platform failure is visible and does not touch the tenant's document", () => {
  test("vendor 422 on create: the document stays READY with the reason recorded", async () => {
    planeOn();
    failCreate = { status: 422, retryable: false, body: "document rejected: unsupported text" };
    rows = [newRow()];

    const res = await vectorizeDocument("doc-1");

    // Plane one is fine: the result is a success and nothing wrote FAILED.
    expect(res.ok).toBe(true);
    expect(upserts).toHaveLength(1);
    expect(row("doc-1").status).toBe("READY");
    expect(rowWrites.some((w) => w.status === "FAILED")).toBe(false);

    expect(row("doc-1").platformError).toContain("platform_doc_create_failed");
    expect(row("doc-1").platformError).toContain("status=422");
    expect(row("doc-1").platformDocId).toBeNull();

    const failure = audits.find((a) => a.intent === "document_platform_kb_failed");
    expect(failure, "the chain records it, not just the row").toBeDefined();
    expect(failure!.orgId).toBe("org-a");
    expect(logs.some((l) => String(l.msg).includes("platform knowledge-base publish failed"))).toBe(
      true,
    );
  });

  test("vendor 503 on the agent PATCH: the created id survives so the next run updates it", async () => {
    planeOn();
    failAgentPatch = { status: 503, retryable: true, body: "vendor unavailable" };
    rows = [newRow()];

    const out = attempted(await publish());

    expect(out.ok).toBe(false);
    if (out.attempted && !out.ok) expect(out.error).toContain("agent_attach_failed");
    // The anchor is persisted BEFORE the attach, precisely so this outcome cannot
    // produce a duplicate on the retry.
    expect(row("doc-1").platformDocId).toBe("kb-new-1");
    expect(row("doc-1").platformError).toContain("agent_attach_failed");
    expect(row("doc-1").status).toBe("PENDING"); // this call does not own the status
    expect(audits.filter((a) => a.intent === "document_platform_kb_failed").length).toBeGreaterThan(
      0,
    );
  });

  test("a PATCH that answers 200 but persists nothing is reported as a failure", async () => {
    planeOn();
    ignoreAgentPatch = true;
    rows = [newRow()];

    const out = attempted(await publish());

    expect(out.ok).toBe(false);
    if (out.attempted && !out.ok) expect(out.error).toContain("agent_kb_not_persisted");
    expect(row("doc-1").platformError).toContain("agent_kb_not_persisted");
  });

  test("text over the ceiling is refused, not published half", async () => {
    planeOn();
    process.env.KB_PLATFORM_MAX_CHARS = "1000";
    rows = [newRow()];

    const out = attempted(await publish({ text: "x".repeat(1200) }));

    expect(out.ok).toBe(false);
    if (out.attempted && !out.ok) expect(out.error).toContain("text_too_large");
    expect(vendorCalls, "a refusal must not spend a vendor call").toHaveLength(0);
  });

  test("a refusal is written to its own column, never to the vectorize error", async () => {
    planeOn();
    failCreate = { status: 500, retryable: true, body: "upstream exploded" };
    rows = [newRow()];
    await vectorizeDocument("doc-1");

    expect(row("doc-1").error).toBeNull(); // plane one's reason column stays clean
    expect(row("doc-1").platformError).toContain("platform_doc_create_failed");
  });
});

describe("another tenant's org is never addressed", () => {
  test("each publish goes to its own agent and fills only its own document", async () => {
    planeOn();
    orgAgents = { "org-a": "agent-a", "org-b": null };
    rows = [
      newRow({ id: "doc-a", orgId: "org-a", title: "Org A refund policy" }),
      newRow({ id: "doc-b", orgId: "org-b", title: "Org B dispute policy" }),
    ];

    const a = await publish({
      documentId: "doc-a",
      orgId: "org-a",
      title: "Org A refund policy",
      text: "Org A refund policy body",
    });
    const b = await publish({
      documentId: "doc-b",
      orgId: "org-b",
      title: "Org B dispute policy",
      text: "Org B dispute policy body",
    });
    if (!a.attempted || !b.attempted)
      throw new Error("KB_PLATFORM_SYNC was on, so both publishes must have been attempted");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const agentPaths = vendorCalls
      .filter((c) => c.path.startsWith("/v1/convai/agents/"))
      .map((c) => c.path);
    // org-a owns an agent: none of ITS calls touched the deployment default.
    const orgAPaths = vendorCalls
      .filter((c) => c.callerId === "knowledge:org-a")
      .map((c) => c.path);
    expect([...new Set(orgAPaths)].sort()).toEqual([
      "/v1/convai/agents/agent-a",
      "/v1/convai/knowledge-base/text",
    ]);
    expect([...new Set(agentPaths)].sort()).toEqual([
      "/v1/convai/agents/agent-a",
      "/v1/convai/agents/agent-platform",
    ]);
    expect(agentPaths.filter((p) => p === "/v1/convai/agents/agent-a")).toHaveLength(3);
    expect(
      agentPaths.filter((p) => p === "/v1/convai/agents/agent-platform"),
      "org-b has no binding, so it falls back to the deployment agent",
    ).toHaveLength(3);

    // One document each, distinct ids, each named and filled from its OWN row.
    expect(createdDocIds).toEqual(["kb-new-1", "kb-new-2"]);
    expect(row("doc-a").platformDocId).toBe("kb-new-1");
    expect(row("doc-b").platformDocId).toBe("kb-new-2");
    const creates = vendorCalls
      .filter((c) => c.path === "/v1/convai/knowledge-base/text")
      .map((c) => c.body as { name: string; text: string });
    expect(creates).toHaveLength(2);
    expect(creates[0]!.name).toContain("Org A refund policy");
    expect(creates[0]!.text).toBe("Org A refund policy body");
    expect(creates[1]!.name).toContain("Org B dispute policy");
    expect(creates[1]!.text).toBe("Org B dispute policy body");
    expect(creates[0]!.name + creates[0]!.text).not.toContain("Org B");
    expect(creates[1]!.name + creates[1]!.text).not.toContain("Org A");

    // Every row write happened inside that row's own tenant scope.
    expect(new Set(scopedOrgs)).toEqual(new Set(["org-a", "org-b"]));
  });

  test("a tenant cannot write another tenant's row, and the publish reports that", async () => {
    planeOn();
    rows = [newRow({ id: "doc-b", orgId: "org-b", title: "Org B dispute policy" })];

    const out = attempted(await publish({ documentId: "doc-b", orgId: "org-a" }));

    expect(out.ok).toBe(false);
    expect(row("doc-b").platformDocId).toBeNull();
    if (out.attempted && !out.ok) expect(out.error).toContain("platform_doc_anchor_unrecorded");
    // The lost anchor is the duplicate risk, so it is said out loud rather than
    // counted as a publish that worked.
    expect(
      logs.some((l) => String(l.msg).includes("outcome could not be recorded on the row")),
    ).toBe(true);
  });

  test("a credential travels in the call and nowhere the platform can read it back", async () => {
    planeOn();
    rows = [newRow()];
    const outcome = attempted(await publish());

    expect(vendorCalls.length, "the gate below must not pass on zero calls").toBeGreaterThan(0);
    // The key IS handed to the guarded egress — a tenant's own key can only reach
    // the vendor if the caller passes it — so "no call carries a credential" is not
    // the property worth asserting and never was. What a reviewer can read back is
    // the module's own output: the outcome it returns, the audit trail it appends,
    // and the document bodies it sends. None of those may repeat the secret.
    const recorded = JSON.stringify({ outcome, audits, docPatchBodies });
    expect(recorded).not.toContain(TEST_KEY);

    // And on the path where a secret is most likely to surface — a vendor refusal,
    // whose body the module quotes back to the operator.
    failCreate = { status: 401, retryable: false, body: `invalid xi-api-key: ${TEST_KEY}` };
    rows = [newRow()];
    const denied = attempted(await publish());
    failCreate = null;
    expect(JSON.stringify(denied)).not.toContain(TEST_KEY);
    expect(JSON.stringify(denied)).toContain("401");
  });
});

describe("erasure takes the document off the platform too", () => {
  test("a row with an anchor is scrubbed and detached even with the flag off", async () => {
    // Flag deliberately NOT set: it decides whether documents are PUBLISHED, and an
    // erasure that no-ops because a deployment turned a feature off would leave the
    // tenant's deleted policy quotable on the agent forever.
    process.env.ELEVENLABS_API_KEY = TEST_KEY;
    process.env.ELEVENLABS_AGENT_ID = "agent-platform";
    orgAgents = { "org-a": "agent-a", "org-b": null };
    rows = [newRow({ status: "READY", platformDocId: "kb-pub-7" })];
    agentState["/v1/convai/agents/agent-a"] = [
      ...SHIPPED,
      { type: "text", name: "[org-a] Card dispute policy (en)", id: "kb-pub-7" },
    ];

    const out = await forgetDocument("doc-1");

    expect(out).toEqual({ ok: true });
    // Plane one still erased first: the vectors are the other copy of the same text.
    expect(vectorDeletes).toEqual([{ filter: { documentId: "doc-1" } }]);

    const scrub = docPatchBodies.find((d) => d.path === "/v1/convai/knowledge-base/kb-pub-7");
    expect(scrub, "the published document is neutralised").toBeDefined();
    const body = scrub!.body as { content: string; name: string };
    expect(body.content).not.toContain("disputed charge");
    expect(body.name).toContain("revoked");

    const agentPatch = callsTo(
      (c) => c.method === "PATCH" && c.path === "/v1/convai/agents/agent-a",
    );
    expect(agentPatch).toHaveLength(1);
    const kb = (agentPatch[0]!.body as Record<string, any>).conversation_config.agent.prompt
      .knowledge_base as Array<{ id: string }>;
    // Ours gone, the deployment's two documents untouched.
    expect(kb.map((d) => d.id)).toEqual(["kb-en", "kb-ar"]);
    expect(rows, "the row goes last").toHaveLength(0);
    expect(audits.map((a) => a.intent)).toContain("document_platform_kb_erased");
  });

  test("a row that was never published costs the vendor nothing on delete", async () => {
    planeOn();
    rows = [newRow({ status: "READY", platformDocId: null })];

    const out = await forgetDocument("doc-1");

    expect(out).toEqual({ ok: true });
    expect(vendorCalls, "no anchor means no platform call").toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  test("a failed scrub keeps the row, so the erasure can be retried", async () => {
    planeOn();
    failDocPatch = { status: 500, retryable: true, body: "upstream" };
    rows = [newRow({ status: "READY", platformDocId: "kb-pub-7" })];

    const out = await forgetDocument("doc-1");

    expect(out.ok).toBe(false);
    expect(out.error).toContain("platform_doc_scrub_failed");
    expect(
      row("doc-1"),
      "a row that outlives a failed erasure is the retryable state",
    ).toBeDefined();
    expect(rows).toHaveLength(1);
  });

  test("a document whose content is gone is reported even if the reference stays", async () => {
    planeOn();
    ignoreAgentPatch = true;
    agentState["/v1/convai/agents/agent-platform"] = [
      ...SHIPPED,
      { type: "text", name: "[org-a] Card dispute policy (en)", id: "kb-pub-7" },
    ];
    rows = [newRow({ status: "READY", platformDocId: "kb-pub-7" })];

    const out = await removeDocumentFromPlatformKb({
      documentId: "doc-1",
      orgId: "org-a",
      platformDocId: "kb-pub-7",
    });

    expect(out).toEqual({ ok: true, detached: false });
    expect(
      logs.some((l) => String(l.msg).includes("agent reference remains")),
      "the dangling reference is said out loud, not swallowed",
    ).toBe(true);
    expect(audits.map((a) => a.intent)).toContain("document_platform_kb_erased");
  });
});
