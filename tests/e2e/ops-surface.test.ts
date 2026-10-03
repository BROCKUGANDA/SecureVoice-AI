/**
 * E2E — the operational surface a deployment is judged on.
 *
 * These handlers are the first thing an orchestrator, a load balancer and a
 * human on call all touch, and they are also the easiest place for a real defect
 * to hide precisely because they "obviously work". Each is invoked through its
 * real exported handler against the live database, so this is a genuine journey
 * rather than a unit test of a helper.
 *
 * The properties defended here:
 *
 *   · LIVENESS AND READINESS ARE NOT THE SAME QUESTION. `/api/health` must never
 *     touch a dependency, because an orchestrator that restarts the process
 *     when the database blips turns a degraded dependency into an outage. The
 *     suite proves it answers with the database unreachable.
 *   · `/api/readyz` gates traffic, so a FATAL check failing must produce a 503
 *     and a non-fatal check failing must NOT — that asymmetry is the whole
 *     design, and an inverted fatality silently takes a healthy instance out of
 *     service during a partial outage.
 *   · `/api/status` is operator-only. It exposes heap, latency and provider
 *     detail, which is fingerprinting data, so an anonymous caller must be
 *     refused.
 *   · Nothing on these endpoints leaks a secret, a DSN or a customer identifier.
 *     They are the most widely scraped endpoints in the app.
 *
 * Response bodies are parsed through Zod rather than cast. A cast would silence
 * a shape change; a parse turns it into a failing assertion naming the field,
 * which is the entire point of gating an operational contract.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { leakScan } from "@/lib/failures/envelope";
import { db } from "@/lib/db";
import * as realCredits from "@/lib/credits";
import { GET as healthGet } from "@/app/api/health/route";
import { GET as readyzGet } from "@/app/api/readyz/route";
import { GET as statusGet } from "@/app/api/status/route";

// `/api/status` guards on `requireOperator()`, which reads the session through
// `getProfile()`. Outside a Next request scope that call throws rather than
// returning null, so the identity seam is stubbed exactly the way the repo's
// other route suites stub it (tests/tenancy/console-routes.test.ts). The point
// of these tests is that an ANONYMOUS caller is refused — which is precisely
// the null case.
mock.module("@/lib/credits", () => ({
  // Spread the real module: console routes import `requireOperator` /
  // `requireSignedIn` from it too, so a wholesale replacement makes them fail
  // to link instead of failing the assertion.
  ...realCredits,
  getProfile: async () => null,
}));

afterAll(async () => {
  await db.$disconnect();
});

const HealthBody = z.object({ ok: z.boolean(), uptimeSec: z.number() });

const Check = z.object({
  name: z.string(),
  ok: z.boolean(),
  fatal: z.boolean(),
  detail: z.union([z.string(), z.number()]).optional(),
  ms: z.number().optional(),
});

const ReadyzBody = z.object({
  ok: z.boolean(),
  status: z.enum(["ok", "degraded", "unready"]),
  checks: z.array(Check),
  durationMs: z.number(),
  ts: z.string(),
});

describe("GET /api/health — liveness", () => {
  test("answers 200 while the process is up", async () => {
    expect((await healthGet()).status).toBe(200);
  });

  test("reports ok and a plausible uptime", async () => {
    const body = HealthBody.parse(await (await healthGet()).json());
    expect(body.ok).toBe(true);
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  test("is not cached — a cached liveness probe lies", async () => {
    expect((await healthGet()).headers.get("Cache-Control")).toBe("no-store");
  });

  test("touches no dependency, so it answers with the database down", async () => {
    // The point of the split: a liveness probe that fails when Postgres is down
    // makes the orchestrator restart a process that is serving fine.
    const real = db.$queryRaw;
    db.$queryRaw = (() => {
      throw new Error("database unreachable");
    }) as typeof db.$queryRaw;
    try {
      const res = await healthGet();
      expect(res.status).toBe(200);
      expect(HealthBody.parse(await res.json()).ok).toBe(true);
    } finally {
      db.$queryRaw = real;
    }
  });

  test("exposes nothing sensitive", async () => {
    const raw = JSON.stringify(await (await healthGet()).json());
    for (const forbidden of ["DATABASE_URL", "postgres://", "password", "secret", "token"]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});

describe("GET /api/readyz — readiness", () => {
  test("answers 200 whenever the fatal dependency is reachable", async () => {
    expect((await readyzGet()).status).toBe(200);
  });

  test("reports ready with a populated checks array", async () => {
    const body = ReadyzBody.parse(await (await readyzGet()).json());
    // `ok` is the readiness verdict. `status` is allowed to be "degraded"
    // because a shared test database legitimately carries a stale audit row or
    // a pending outbox event, and reporting that as "unready" is exactly the
    // behaviour these tests are defending against.
    expect(body.ok).toBe(true);
    expect(["ok", "degraded"]).toContain(body.status);
    expect(body.checks.length).toBeGreaterThan(0);
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("the fatal database check passes", async () => {
    const body = ReadyzBody.parse(await (await readyzGet()).json());
    expect(body.checks.find((c) => c.name === "database")?.ok).toBe(true);
  });

  test("declares a fatality flag on every check", async () => {
    // Fatality is declared, never inferred from the outcome. A check missing
    // the flag is a check whose fatality is decided by accident.
    const body = ReadyzBody.parse(await (await readyzGet()).json());
    for (const check of body.checks) {
      expect({ name: check.name, hasFlag: typeof check.fatal === "boolean" }).toEqual({
        name: check.name,
        hasFlag: true,
      });
    }
  });

  test("the database is the one fatal check", async () => {
    const body = ReadyzBody.parse(await (await readyzGet()).json());
    expect(body.checks.filter((c) => c.fatal).map((c) => c.name)).toEqual(["database"]);
  });

  test("reports a duration per check", async () => {
    const body = ReadyzBody.parse(await (await readyzGet()).json());
    for (const check of body.checks) {
      expect(typeof check.ms).toBe("number");
    }
  });

  test("is not cached", async () => {
    expect((await readyzGet()).headers.get("Cache-Control")).toBe("no-store");
  });

  test("check names are unique", async () => {
    const body = ReadyzBody.parse(await (await readyzGet()).json());
    const names = body.checks.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("a voice-provider outage never marks the instance unready", async () => {
    // Reported, never asserted: refusing traffic while the provider recovers
    // makes the backlog worse.
    const body = ReadyzBody.parse(await (await readyzGet()).json());
    expect(body.checks.find((c) => c.name === "voice_provider")?.fatal).toBe(false);
  });

  // The asymmetry that matters: a non-fatal failure must NOT take the instance
  // out of service. Reporting 503 for a degraded outbox would refuse the very
  // traffic that is queueing.
  test("a non-fatal check failing still reports ready", async () => {
    const real = db.outboxEvent;
    // `db` is a Prisma client whose model accessors are readonly, so the stub
    // is installed by descriptor rather than assignment.
    Object.defineProperty(db, "outboxEvent", {
      configurable: true,
      value: Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
        findFirst: () => {
          throw new Error("outbox table missing");
        },
      }),
    });
    try {
      const res = await readyzGet();
      const body = ReadyzBody.parse(await res.json());
      expect(body.status).toBe("degraded");
      expect(body.ok).toBe(true);
      expect(res.status).toBe(200);
    } finally {
      Object.defineProperty(db, "outboxEvent", { configurable: true, value: real });
    }
  });

  test("a fatal check failing reports 503 and takes the instance out of service", async () => {
    const real = db.$queryRaw;
    db.$queryRaw = (() => {
      throw new Error("database unreachable");
    }) as typeof db.$queryRaw;
    try {
      const res = await readyzGet();
      const body = ReadyzBody.parse(await res.json());
      expect(res.status).toBe(503);
      expect(body.ok).toBe(false);
      expect(body.status).toBe("unready");
    } finally {
      db.$queryRaw = real;
    }
  });

  test("a failing check publishes a detail the project's own leak gate accepts", async () => {
    // The driver string this used to emit verbatim is classified `stack_trace`
    // by `leakScan`, so it is now redacted before it reaches an
    // unauthenticated client. Asserting through the project's own gate rather
    // than a hand-listed set of banned words means a new leak class added to
    // the envelope is enforced here too.
    const real = db.$queryRaw;
    db.$queryRaw = (() => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:5432\n    at handler (src/lib/db.ts:1:1)");
    }) as typeof db.$queryRaw;
    try {
      const body = ReadyzBody.parse(await (await readyzGet()).json());
      const detail = String(body.checks.find((c) => c.name === "database")?.detail ?? "");
      expect(leakScan(detail)).toEqual([]);
    } finally {
      db.$queryRaw = real;
    }
  });

  test("a failing check bounds its detail and collapses its newlines", async () => {
    const real = db.$queryRaw;
    db.$queryRaw = (() => {
      throw new Error("line one\nline two\nline three");
    }) as typeof db.$queryRaw;
    try {
      const body = ReadyzBody.parse(await (await readyzGet()).json());
      const detail = String(body.checks.find((c) => c.name === "database")?.detail ?? "");
      expect(detail).not.toContain("\n");
      expect(detail.length).toBeLessThanOrEqual(120);
    } finally {
      db.$queryRaw = real;
    }
  });

  test("a connection string is stripped from the detail", async () => {
    const real = db.$queryRaw;
    db.$queryRaw = (() => {
      throw new Error("cannot reach postgres://user:hunter2@db.internal:5432/securevoice");
    }) as typeof db.$queryRaw;
    try {
      const body = ReadyzBody.parse(await (await readyzGet()).json());
      const detail = String(body.checks.find((c) => c.name === "database")?.detail ?? "");
      expect(detail).not.toContain("hunter2");
      expect(detail).not.toContain("postgres://");
    } finally {
      db.$queryRaw = real;
    }
  });

  test("a thrown non-Error still yields a detail rather than crashing", async () => {
    const real = db.$queryRaw;
    db.$queryRaw = (() => {
      // eslint-disable-next-line no-throw-literal -- deliberately throwing a bare string to prove the failure envelope handles a non-Error rejection
      throw "a bare string";
    }) as typeof db.$queryRaw;
    try {
      const body = ReadyzBody.parse(await (await readyzGet()).json());
      expect(body.checks.find((c) => c.name === "database")?.detail).toBe("error");
      expect(body.ok).toBe(false);
    } finally {
      db.$queryRaw = real;
    }
  });

  test("the response body carries no connection string", async () => {
    const raw = JSON.stringify(await (await readyzGet()).json());
    expect(raw).not.toContain("postgres://");
    expect(raw.toLowerCase()).not.toContain("password");
  });
});

describe("GET /api/status — operator-only diagnostics", () => {
  test("refuses an anonymous caller", async () => {
    // It exposes heap, latency and provider detail — fingerprinting data.
    expect([401, 403]).toContain((await statusGet()).status);
  });

  test("a refusal carries no diagnostic detail", async () => {
    const raw = JSON.stringify(await (await statusGet()).json());
    for (const forbidden of ["heapUsedMb", "rssMb", "dbLatencyMs", "voiceProvider"]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  test("a refusal carries no connection string", async () => {
    const raw = JSON.stringify(await (await statusGet()).json());
    expect(raw).not.toContain("postgres://");
  });
});
