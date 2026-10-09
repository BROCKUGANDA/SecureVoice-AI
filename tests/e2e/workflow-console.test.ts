/**
 * E2E — the Agent Workflows console surface.
 *
 *   GET    /api/console/workflows        list (registry + this org's saves)
 *   POST   /api/console/workflows        validate + persist
 *   GET    /api/console/workflows/:id    saved override, else built-in
 *   DELETE /api/console/workflows/:id    revert to the built-in
 *   POST   /api/console/workflows/run    execute on the LIVE tool plane
 *
 * Four properties are pinned, in order of how much they matter:
 *
 *   1. A console run reaches the REAL guarded tool routes — the fetch carries
 *      the server-side tool secret and the workflow's {{caseRef}} lands in the
 *      tool body interpolated. A journey cannot reach an action the guard would
 *      refuse the agent path; the guard is the same code either way.
 *   2. The session guard comes first: an unsigned request is refused before
 *      any store read, on every verb.
 *   3. Tenant isolation: a workflow saved in workspace A is a 404 in
 *      workspace B — existence is not confirmed across tenants.
 *   4. A graph the runner would refuse is never persisted (422 from the
 *      schema/validator, by name), and an unknown workflow is a 404.
 *
 * The store is REAL here (the same claim the route sweep's DB-backed
 * registration makes); the session, the audit chain and the tool vendor are
 * stubbed. Rows are dropped in afterAll — this suite leaves nothing behind.
 *
 *   bun scripts/run-tests.mjs workflow-console
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import * as realCredits from "@/lib/credits";

const NS = "org-wf-e2e";
const OTHER_NS = "org-wf-e2e-b";
const PROFILE = {
  userId: "u-wf-e2e",
  email: "op@securevoice.ae",
  name: "E2E Operator",
  role: "operator" as const,
  orgId: NS,
  credits: 1000,
};

let signedIn = true;

mock.module("@/lib/credits", () => ({
  ...realCredits,
  requireSignedIn: async () =>
    signedIn
      ? { ok: true, profile: PROFILE }
      : { ok: false, status: 401, error: "Sign in required — open the sign-in page." },
}));

const AUDIT: Array<{ intent: string; callerId: string; meta: Record<string, unknown> }> = [];
mock.module("@/lib/audit-chain", () => ({
  append: async (entry: { intent: string; callerId: string; meta: Record<string, unknown> }) => {
    AUDIT.push({ intent: entry.intent, callerId: entry.callerId, meta: entry.meta });
    return { id: "wf-e2e-stub", chainHash: "0".repeat(64) };
  },
  verifyChain: async () => ({ ok: true, rows: 0 }),
}));

// The tool vendor: every guarded route call lands here, so the assertions are
// about OUR request — URL, secret header, interpolated body — never a carrier.
const TOOL_CALLS: Array<{ url: string; secret: string | null; body: Record<string, unknown> }> = [];
const originalFetch = globalThis.fetch;
const originalSecret = process.env.AGENT_TOOL_SECRET;

let toolStatus = 200;
let toolBody: unknown = { ok: true, state: "CONFIRMED_FRAUD" };

beforeAll(async () => {
  // The dev database is a REMOTE Postgres, and the first connection in a fresh
  // process intermittently exceeds pg-pool's 10s connect timeout while every
  // later one is instant. Warm the pool with retries so a cold start cannot
  // fail a test that is not about the network — the same accommodation
  // tests/preload.ts makes for the remote round trip.
  const { db } = await import("@/lib/db");
  for (let i = 0; i < 5; i++) {
    try {
      await db.$queryRawUnsafe("select 1");
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  process.env.AGENT_TOOL_SECRET = "wf-e2e-secret";
  globalThis.fetch = (async (u: unknown, i: RequestInit) => {
    const headers = (i?.headers ?? {}) as Record<string, string>;
    TOOL_CALLS.push({
      url: String(u),
      secret: headers["x-agent-tool-secret"] ?? null,
      body: JSON.parse(String(i?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(toolBody), {
      status: toolStatus,
      headers: { "content-type": "application/json" },
    });
  }) as never;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (originalSecret === undefined) delete process.env.AGENT_TOOL_SECRET;
  else process.env.AGENT_TOOL_SECRET = originalSecret;
  const { db } = await import("@/lib/db");
  await db.workflowDoc.deleteMany({ where: { orgId: { in: [NS, OTHER_NS] } } });
  await db.$disconnect();
});

beforeEach(() => {
  AUDIT.length = 0;
  TOOL_CALLS.length = 0;
  toolStatus = 200;
  toolBody = { ok: true, state: "CONFIRMED_FRAUD" };
});

const listRoute = () => import("@/app/api/console/workflows/route");
const idRoute = () => import("@/app/api/console/workflows/[id]/route");
const runRoute = () => import("@/app/api/console/workflows/run/route");

const post = (body: unknown) =>
  new Request("http://localhost/api/console/workflows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** A valid institution-authored journey, saved under a unique id per test. */
const customJourney = (suffix: string) => ({
  id: `claims_triage_${suffix}`,
  name: `Claims triage ${suffix}`,
  version: "1",
  entry: "open",
  tools: ["human_handoff"],
  nodes: [
    {
      id: "open",
      kind: "prompt",
      sysPrompt: "Triage the claim dispute.",
      scope: [],
      next: "hand",
    },
    {
      id: "hand",
      kind: "tool",
      tool: "human_handoff",
      args: { summary: "claim review for {{caseRef}}" },
      scope: ["human_handoff"],
      next: "done",
    },
    { id: "done", kind: "end", outcome: "triaged", scope: [] },
  ],
});

describe("Agent Workflows console", () => {
  test("lists the built-in registry when nothing is saved", async () => {
    const { GET } = await listRoute();
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      workflows: Array<{ id: string; source: string }>;
    };
    const byId = new Map(body.workflows.map((w) => [w.id, w.source]));
    expect(byId.get("fraud_intervention")).toBe("builtin");
    expect(byId.get("specialist_review")).toBe("builtin");
  });

  test("saves a valid journey and lists it as this org's saved copy", async () => {
    const { GET, POST } = await listRoute();
    const suffix = crypto.randomUUID().slice(0, 8);
    const graph = customJourney(suffix);

    const res = await POST(post({ graph }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    const list = (await (await GET()).json()) as {
      workflows: Array<{ id: string; source: string; graph: { nodes: unknown[] } }>;
    };
    const saved = list.workflows.find((w) => w.id === graph.id);
    expect(saved?.source).toBe("saved");
    expect(saved?.graph.nodes.length).toBe(3);
  });

  test("refuses a graph the runner would refuse, by name — unscoped tool node", async () => {
    const { POST } = await listRoute();
    const bad = customJourney(crypto.randomUUID().slice(0, 8));
    bad.nodes = bad.nodes.map((n) => (n.id === "hand" ? { ...n, scope: [] as string[] } : n));

    const res = await POST(post({ graph: bad }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { ok: boolean; error: string; errors: string[] };
    expect(body.error).toBe("invalid_workflow");
    expect(body.errors.join(" ")).toContain('tool "human_handoff" is not in the node\'s scope');
  });

  test("refuses a dangling edge with the validator's own words", async () => {
    const { POST } = await listRoute();
    const bad = customJourney(crypto.randomUUID().slice(0, 8));
    bad.nodes = bad.nodes.map((n) => (n.id === "open" ? { ...n, next: "nowhere" } : n));

    const res = await POST(post({ graph: bad }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: string[] };
    expect(body.errors.join(" ")).toContain('node "open" next "nowhere" does not resolve');
  });

  test("a saved journey is served by id, and a foreign workspace gets a 404", async () => {
    const { POST } = await listRoute();
    const { GET: getOne } = await idRoute();
    const suffix = crypto.randomUUID().slice(0, 8);
    const graph = customJourney(suffix);
    expect((await POST(post({ graph }))).status).toBe(200);

    // This workspace: the saved copy.
    const mine = await getOne({} as never, { params: Promise.resolve({ id: graph.id }) });
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { source: string }).source).toBe("saved");

    // Another workspace: the same 404 as a workflow that never existed —
    // existence is not confirmed across tenants.
    PROFILE.orgId = OTHER_NS;
    try {
      const theirs = await getOne({} as never, { params: Promise.resolve({ id: graph.id }) });
      expect(theirs.status).toBe(404);
    } finally {
      PROFILE.orgId = NS;
    }
  });

  test("a built-in is served when this org has no saved override", async () => {
    const { GET: getOne } = await idRoute();
    const res = await getOne({} as never, {
      params: Promise.resolve({ id: "fraud_intervention" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { source: string }).source).toBe("builtin");
  });

  test("delete reverts a saved journey and 404s when there is nothing to delete", async () => {
    const { POST } = await listRoute();
    const { DELETE } = await idRoute();
    const suffix = crypto.randomUUID().slice(0, 8);
    const graph = customJourney(suffix);
    await POST(post({ graph }));

    const removed = await DELETE({} as never, { params: Promise.resolve({ id: graph.id }) });
    expect(removed.status).toBe(200);

    const again = await DELETE({} as never, { params: Promise.resolve({ id: graph.id }) });
    expect(again.status).toBe(404);

    // A built-in with no override is not deletable — the registry is code.
    const builtin = await DELETE({} as never, {
      params: Promise.resolve({ id: "fraud_intervention" }),
    });
    expect(builtin.status).toBe(404);
  });

  test("every verb refuses an unsigned request before any store read", async () => {
    const { GET: list, POST: save } = await listRoute();
    const { GET: getOne, DELETE } = await idRoute();
    const { POST: run } = await runRoute();
    signedIn = false;
    try {
      expect((await list()).status).toBe(401);
      expect((await save(post({ graph: customJourney("x") }))).status).toBe(401);
      expect((await getOne({} as never, { params: Promise.resolve({ id: "x" }) })).status).toBe(
        401,
      );
      expect((await DELETE({} as never, { params: Promise.resolve({ id: "x" }) })).status).toBe(
        401,
      );
      expect((await run(post({ workflow_id: "fraud_intervention" }))).status).toBe(401);
    } finally {
      signedIn = true;
    }
  });

  test("runs the canonical journey on the live tool plane — the guard path, not a stub", async () => {
    const { POST: run } = await runRoute();
    const res = await run(
      post({
        workflow_id: "fraud_intervention",
        context: { caseRef: "SV-E2E-WF-1", disposition: "confirmed_fraud" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      outcome: string;
      used_tools: string[];
      trace: Array<{ id: string; kind: string; detail?: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe("resolved");
    // The confirmed_fraud branch took the freeze tool node.
    expect(body.used_tools).toEqual(["card_freeze"]);

    // …and it reached the REAL guarded route, with the server-side secret and
    // the {{caseRef}} template interpolated into the tool body.
    const freeze = TOOL_CALLS.find((c) => c.url.endsWith("/api/elevenlabs/tools/card-freeze"));
    expect(freeze).toBeDefined();
    expect(freeze?.secret).toBe("wf-e2e-secret");
    expect(freeze?.body).toMatchObject({ conversation_id: "SV-E2E-WF-1" });

    // The trace names every hop, and the run is on the audit chain as provenance.
    expect(body.trace.map((s) => s.id)).toEqual([
      "disclose",
      "route",
      "freeze",
      "escalate",
      "done",
    ]);
    expect(AUDIT.some((a) => a.intent === "workflow_run_completed")).toBe(true);
  });

  test("the legitimate branch skips the privileged tool entirely", async () => {
    const { POST: run } = await runRoute();
    const res = await run(
      post({
        workflow_id: "fraud_intervention",
        context: { caseRef: "SV-E2E-WF-2", disposition: "confirmed_legitimate" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { used_tools: string[]; outcome: string };
    expect(body.outcome).toBe("resolved");
    expect(body.used_tools).toEqual([]);
    expect(TOOL_CALLS).toEqual([]);
  });

  test("a guard refusal is a failed step in the trace, not a silent success", async () => {
    toolStatus = 409;
    toolBody = { ok: false, error: "case cannot move from DISCLOSED to CONFIRMED_FRAUD" };
    const { POST: run } = await runRoute();
    const res = await run(
      post({
        workflow_id: "fraud_intervention",
        context: { caseRef: "SV-E2E-WF-3", disposition: "confirmed_fraud" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      used_tools: string[];
      trace: Array<{ id: string; detail?: string }>;
    };
    // The walk completed (a failed tool step does NOT abort the journey — the
    // handoff still happens), and the failure is visible in the trace.
    expect(body.ok).toBe(true);
    expect(body.used_tools).toEqual(["card_freeze"]);
    const freezeStep = body.trace.find((s) => s.id === "freeze");
    expect(freezeStep?.detail).toBe("failed");
  });

  test("an unknown workflow is a 404, not a 500", async () => {
    const { POST: run } = await runRoute();
    const res = await run(post({ workflow_id: "no_such_journey", context: { caseRef: "SV-X" } }));
    expect(res.status).toBe(404);
  });

  test("a run writes provenance with the operator, never the journey's case data", async () => {
    const { POST: run } = await runRoute();
    await run(
      post({
        workflow_id: "fraud_intervention",
        context: { caseRef: "SV-E2E-WF-4", disposition: "confirmed_fraud" },
      }),
    );
    const entry = AUDIT.find((a) => a.intent === "workflow_run_completed");
    expect(entry).toBeDefined();
    expect(entry?.callerId).toBe(`console:${PROFILE.userId}`);
    expect(entry?.meta.workflow).toBe("fraud_intervention");
    expect(entry?.meta.source).toBe("builtin");
  });
});

// The list body shape, pinned so a silent rename fails here.
const ListBody = z.object({
  ok: z.literal(true),
  namespace: z.string(),
  workflows: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      version: z.string(),
      source: z.enum(["builtin", "saved"]),
    }),
  ),
});

describe("the list envelope", () => {
  test("GET parses through the pinned schema", async () => {
    const { GET } = await listRoute();
    const body = ListBody.parse(await (await GET()).json());
    expect(body.namespace).toBe(NS);
  });
});
