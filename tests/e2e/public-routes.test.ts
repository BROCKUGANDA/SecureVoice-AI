/**
 * E2E — the PUBLIC contract surface: metrics, machine-readable contracts,
 * crawler policy, the self-serve conformance checker, and the two intake forms
 * that need no session.
 *
 * These are the endpoints a bank, a Prometheus scrape, a crawler or a prospect's
 * browser touches WITHOUT a session. They are read far more widely than anything
 * else in the app and are the easiest place for a real defect to hide, because
 * "it obviously works" is the working assumption. Every handler below is invoked
 * through its real exported function against a real `Request`, so this is a
 * journey rather than a unit test of a helper.
 *
 * The properties defended here:
 *
 *   · `/api/metrics` is scrapeable by monitoring infrastructure far more widely
 *     than by the app, so its label VALUES must come from a closed vocabulary —
 *     never a customer, an org or a case reference — and the whole body must be
 *     parseable by a Prometheus scraper. A metrics line a scraper silently drops
 *     is invisible: the dashboard still loads, the series is simply gone.
 *   · `/openapi` and `/asyncapi` are GENERATED so they cannot go stale, but
 *     generation only guarantees the envelope is current — not that the document
 *     is well-formed. A dangling `$ref` yields a client that does not compile,
 *     and a timestamp inside the document makes every build a different artefact,
 *     which defeats diffing and any gate built on "did the contract change?".
 *   · robots.txt is a claim. `tests/surface/surface.test.ts` asserts the declared
 *     prefixes are PRESENT; this asserts the stronger property — that resolving
 *     real URLs against the declared rules, under the longest-match-wins
 *     semantics a compliant crawler applies, actually denies them. A rule that is
 *     present but shadowed by a longer `allow` reads perfectly in review.
 *   · `/v1/conformance/run` grades CUSTOMER code. A failing grade must arrive as
 *     200 with `score.verdict`, never as a transport error, and the report must
 *     name what was observed — a bank cannot fix what the report will not name.
 *     The refusals reuse the ingest's error vocabulary, because a producer's
 *     retry logic must not branch on which endpoint it is talking to.
 *   · `/api/enroll` and `/api/pilot` write into a live dial-out system. The
 *     refusal ladder is ordered cheapest-check-first, and that order is the
 *     security property: an anonymous caller is refused before any row is read.
 *
 * Response bodies are parsed through Zod rather than cast. A cast would silence
 * a shape change; a parse turns it into a failing assertion naming the field,
 * which is the entire point of gating a published contract.
 *
 * NOT COVERED HERE, ON PURPOSE:
 *   · health and readyz — `tests/e2e/ops-surface.test.ts` already drives both
 *     with the database deliberately unreachable, which is the only way to prove
 *     liveness does not touch a dependency.
 *   · `POST /api/tts`'s synthesis and its 401 anonymous refusal: the refusal
 *     needs `ELEVENLABS_API_KEY` AND a matching `ELEVENLABS_VOICE_*` id to be
 *     reachable, because voice resolution runs first and a prod-mode build with
 *     no configured voices rejects every voice before the key is resolved. Both
 *     env values are read at module load, so a test cannot install them after
 *     import. Everything ahead of that boundary IS exercised here.
 *   · `POST /api/pilot`'s happy path and `POST /api/enroll`'s upsert: both write
 *     rows into the shared database. Every refusal ahead of that write is
 *     exercised, and the pilot honeypot proves the no-write branch.
 *
 *   bun test tests/e2e/public-routes.test.ts
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { GET as asyncapiGet } from "@/app/asyncapi/route";
import { GET as enrollGet, POST as enrollPost } from "@/app/api/enroll/route";
import { GET as metricsGet, HEAD as metricsHead } from "@/app/api/metrics/route";
import { POST as pilotPost } from "@/app/api/pilot/route";
import { POST as ttsPost } from "@/app/api/tts/route";
import { GET as openapiGet } from "@/app/openapi/route";
import robots, { NO_INDEX, siteOrigin } from "@/app/robots";
import { GET as conformanceGet, POST as conformancePost } from "@/app/v1/conformance/run/route";

import { CASE_STATES } from "@/lib/case-state-machine";
import { CONFORMANCE_CHECK_IDS, MAX_BUDGET_MS, MIN_BUDGET_MS } from "@/lib/contracts/conformance";
import { verifySignature } from "@/lib/outbox";

/* ──────────────────────────────────────────────────────────────────────────
 * Identity + policy seams
 *
 * `mock.module` mutates a PROCESS-WIDE registry, and `tests/validation/
 * callback-ssrf.test.ts` drives the real redirect guard — so this file both
 * snapshots the real modules and puts them back in `afterAll`. Two details make
 * that actually work, and both were found the hard way:
 *
 *   1. The snapshot is a top-level `await import()`, because Bun hoists a STATIC
 *      import above `mock.module` — a static capture would take the stub.
 *   2. It is spread into a plain object immediately. `mock.module` rewrites the
 *      namespace's live bindings, so a teardown that re-reads
 *      `REAL_SSRF.safeFetch` re-installs the stub and silently poisons every
 *      suite that imports the real module afterwards. A snapshot cannot drift.
 * ────────────────────────────────────────────────────────────────────────── */
const REAL_SSRF: Record<string, unknown> = { ...(await import("@/lib/validation/ssrf")) };
const REAL_PRODUCER_KEYS: Record<string, unknown> = {
  ...(await import("@/lib/producer-keys")),
};

/** Loopback origin the in-process conformance receiver listens on. */
const LOCAL_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{1,5}\/.*/;

/**
 * The outbound policy, minus the one thing a test cannot satisfy: a routable
 * public address. The scheme and credential checks are reproduced VERBATIM,
 * because the 422 assertions below depend on their exact verdict codes, and a
 * production guard could never return `ok` for 127.0.0.1 — delegating to it would
 * make the conforming run unreachable.
 */
mock.module("@/lib/validation/ssrf", () => ({
  ...REAL_SSRF,
  validateOutboundUrl: async (raw: string | URL) => {
    let url: URL;
    try {
      url = raw instanceof URL ? new URL(raw.toString()) : new URL(String(raw).trim());
    } catch {
      return { ok: false, code: "malformed_url", reason: "not a valid absolute URL" };
    }
    if (url.protocol !== "https:" && !LOCAL_ORIGIN.test(url.toString())) {
      return {
        ok: false,
        code: "not_https",
        reason: `scheme "${url.protocol}" is not https`,
        host: url.hostname,
      };
    }
    if (url.username || url.password) {
      return {
        ok: false,
        code: "credentials_in_url",
        reason: "URL must not embed credentials",
        host: url.hostname,
      };
    }
    if (!LOCAL_ORIGIN.test(url.toString())) {
      return {
        ok: false,
        code: "private_address",
        reason: "resolved to a non-public address",
        host: url.hostname,
      };
    }
    return { ok: true, url, addresses: ["127.0.0.1"] };
  },
  safeFetch: async (url: string | URL, init: RequestInit = {}) => {
    // Redirects are followed manually and never followed onward, which is what
    // the production `safeFetch` does; a local receiver never redirects, so the
    // observable difference is nil and the stub stays honest about not
    // silently following one.
    const response = await fetch(String(url), { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) throw new Error("redirect_blocked");
    return response;
  },
}));

/**
 * The producer key is the ONLY thing between an anonymous caller and an outbound
 * POST to a URL of their choosing, so the stub grants a key only for a
 * well-formed `svb_` bearer and derives the rate-limit identity from it.
 */
mock.module("@/lib/producer-keys", () => ({
  ...REAL_PRODUCER_KEYS,
  verifyProducerKey: async (bearer: string | null) => {
    if (!bearer || !bearer.startsWith("svb_")) return { ok: false as const };
    return {
      ok: true as const,
      callerId: `producer:${bearer}`,
      orgId: null,
      keyId: `key-for-${bearer}`,
    };
  },
}));

// The identity seam. `getProfile()` reads the session through `next/headers`,
// which throws outside a Next request scope rather than returning null, so it is
// stubbed exactly the way tests/e2e/ops-surface.test.ts stubs it. The subject of
// every assertion below is the ANONYMOUS caller, which is precisely the null
// case. Deliberately NOT restored: this stub is the shared anonymous identity,
// and leaving it in place is what the rest of the group already expects.
mock.module("@/lib/credits", () => ({
  // Spread the real module so `requireOperator` / `requireSignedIn` survive;
  // replacing it wholesale breaks every console route that imports them.
  ...realCredits,
  getProfile: async () => null,
}));

import * as realCredits from "@/lib/credits";

// Restore the snapshots: `tests/validation/callback-ssrf.test.ts` drives the real
// redirect guard, and a leaked stub turns its "a 302 into the private network is
// refused" assertion into a DNS failure.
afterAll(() => {
  mock.module("@/lib/validation/ssrf", () => REAL_SSRF);
  mock.module("@/lib/producer-keys", () => REAL_PRODUCER_KEYS);
});

// `/api/enroll`'s HMAC mode signs exact bytes, so a secret must exist. Set only
// when absent, so a value another suite already chose wins.
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "public-routes-test-secret";

/* ──────────────────────────────────────────────────────────────────────────
 * Request helpers
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Build the `Request` a POST route handler is invoked with. A string body is
 * sent VERBATIM, because /api/enroll's HMAC mode signs exact bytes — signing a
 * re-serialised copy produces a signature that never validates, and the handler
 * refuses for a reason that has nothing to do with what is being tested.
 */
function jsonRequest(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  // A plain `Request` serves as a `NextRequest` for every property these
  // handlers read; this is the repo's established route-test seam, not a claim
  // about a shape.
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as NextRequest;
}

/** Sign `raw` the way `/api/enroll`'s HMAC mode expects: `t={unix},v1=…` over `{t}.{raw}`. */
function hmacHeaders(raw: string): Record<string, string> {
  const t = Math.floor(Date.now() / 1000).toString();
  const v1 = createHmac("sha256", process.env.WEBHOOK_SECRET ?? "")
    .update(`${t}.${raw}`)
    .digest("hex");
  return { "sv-signature": `t=${t},v1=${v1}` };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Prometheus exposition parsing
 * ────────────────────────────────────────────────────────────────────────── */

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const HELP_LINE = /^# HELP ([a-zA-Z_:][a-zA-Z0-9_:]*) (.+)$/;
const TYPE_LINE = /^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) (counter|gauge|histogram|summary|untyped)$/;
const SAMPLE_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*\})? (\S+)$/;
const LABEL_PAIR = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
const NUMBER = /^-?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/;

type Exposition = {
  samples: { name: string; labels: Map<string, string>; value: number }[];
  help: Map<string, string>;
  types: Map<string, string>;
  /** Lines that are neither a comment nor a parseable sample. */
  unparseable: string[];
  /** Sample names with no `# TYPE`, which a scraper drops without complaining. */
  undocumented: string[];
};

/**
 * Parse a Prometheus text exposition body into samples plus the metadata a
 * scraper needs. Deliberately strict: anything this cannot classify is REPORTED
 * rather than skipped, because the failure mode being defended is precisely a
 * series a real scraper would ignore in silence.
 */
function parseExposition(body: string): Exposition {
  const samples: Exposition["samples"] = [];
  const help = new Map<string, string>();
  const types = new Map<string, string>();
  const unparseable: string[] = [];

  for (const line of body.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("# HELP ")) {
      const m = HELP_LINE.exec(line);
      if (m) help.set(m[1] ?? "", m[2] ?? "");
      else unparseable.push(line);
      continue;
    }
    if (line.startsWith("# TYPE ")) {
      const m = TYPE_LINE.exec(line);
      if (m) types.set(m[1] ?? "", m[2] ?? "");
      else unparseable.push(line);
      continue;
    }
    if (line.startsWith("#")) continue;

    const m = SAMPLE_LINE.exec(line);
    const name = m?.[1] ?? "";
    const rawLabels = m?.[2] ?? "";
    const rawValue = m?.[3] ?? "";
    if (!m || !NUMBER.test(rawValue)) {
      unparseable.push(line);
      continue;
    }
    const labels = new Map<string, string>();
    if (rawLabels !== "") {
      const pairs = [...rawLabels.matchAll(LABEL_PAIR)];
      // Re-joining the matched pairs must reproduce the label block exactly;
      // otherwise there is text in there a scraper would not read as a label.
      if (pairs.map((p) => `${p[1] ?? ""}="${p[2] ?? ""}"`).join(",") !== rawLabels.slice(1, -1)) {
        unparseable.push(line);
        continue;
      }
      for (const p of pairs) labels.set(p[1] ?? "", p[2] ?? "");
    }
    samples.push({ name, labels, value: Number(rawValue) });
  }

  return {
    samples,
    help,
    types,
    unparseable,
    undocumented: [...new Set(samples.map((s) => s.name))].filter((n) => !types.has(n)),
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * GET /api/metrics
 * ────────────────────────────────────────────────────────────────────────── */

/** The only label vocabulary the scrape may draw from — the case state machine. */
const ALLOWED_LABEL_VALUES = new Set<string>([
  ...CASE_STATES.map((s) => s.toLowerCase()),
  "unknown",
]);

/** Secrets that must never be reachable from a scrape, by construction. */
function configuredSecrets(): string[] {
  return [
    process.env.DATABASE_URL,
    process.env.WEBHOOK_SECRET,
    process.env.ELEVENLABS_API_KEY,
    process.env.TWILIO_AUTH_TOKEN,
    process.env.BETTER_AUTH_SECRET,
  ].filter((v): v is string => typeof v === "string" && v.length >= 8);
}

describe("GET /api/metrics — scrapeable by anything that can reach it", () => {
  test("serves a well-formed Prometheus exposition body", async () => {
    const res = await metricsGet(new Request("http://localhost/api/metrics"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    // A cached metrics body is a dashboard that lies for up to `max-age`.
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = await res.text();
    expect(body.endsWith("\n")).toBe(true);
    // CRLF, or a blank line in the middle, is enough for a scraper to reject the
    // WHOLE payload — not just the one series.
    expect(body).not.toContain("\r");
    expect(body.split("\n").filter((line) => line === "")).toHaveLength(1);

    const parsed = parseExposition(body);
    expect(parsed.unparseable).toEqual([]);
    // Every sample needs HELP and TYPE or the series is dropped without an error.
    expect(parsed.undocumented).toEqual([]);
    expect(parsed.samples.length).toBeGreaterThan(10);
  });

  test("every metric name follows the exposition naming convention", async () => {
    const parsed = parseExposition(
      await (await metricsGet(new Request("http://localhost/api/metrics"))).text(),
    );
    const names = new Set<string>([
      ...parsed.help.keys(),
      ...parsed.types.keys(),
      ...parsed.samples.map((s) => s.name),
    ]);
    expect(names.size).toBeGreaterThan(0);
    for (const name of names) {
      expect(METRIC_NAME.test(name)).toBe(true);
      // Namespacing: an unprefixed name can collide with a Node exporter's, and
      // the scrape then shows two unrelated series under one name.
      expect(name.startsWith("sv_")).toBe(true);
    }
    // HELP and TYPE must describe the same set of names.
    expect([...parsed.help.keys()].sort()).toEqual([...parsed.types.keys()].sort());
  });

  test("no label value carries customer data, a secret, or unbounded cardinality", async () => {
    const res = await metricsGet(new Request("http://localhost/api/metrics"));
    const body = await res.text();
    const parsed = parseExposition(body);

    const labelled = parsed.samples.filter((s) => s.labels.size > 0);
    // Negative precondition: with nothing labelled, the loop below would pass
    // vacuously, which is the whole risk.
    expect(labelled.length).toBeGreaterThan(0);
    // …and the unlabelled majority, so labelling everything cannot satisfy it.
    expect(labelled.length).toBeLessThan(parsed.samples.length);

    for (const sample of labelled) {
      for (const [key, value] of sample.labels) {
        // `callRef`, `orgId` and `customerRef` are never labels by design. A
        // label drawn from a request is unbounded cardinality, which is how a
        // metrics endpoint takes down the monitoring system it exists to feed.
        expect(key).toBe("state");
        expect(ALLOWED_LABEL_VALUES.has(value)).toBe(true);
      }
    }

    for (const secret of configuredSecrets()) expect(body).not.toContain(secret);
    // Shapes that only appear when a value is copied out of a record.
    expect(body).not.toMatch(/\+971\d{6,}/);
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
    expect(body).not.toMatch(/postgres(ql)?:\/\//);
    expect(body).not.toContain("@");
  });

  test("values are numbers with the documented sentinel and range semantics", async () => {
    const parsed = parseExposition(
      await (await metricsGet(new Request("http://localhost/api/metrics"))).text(),
    );
    const valueOf = (name: string): number | undefined =>
      parsed.samples.find((s) => s.name === name)?.value;

    // A scrape that could not reach the database still reports the failure as
    // DATA rather than as an error, so an alert on the metric works at 3am.
    expect([0, 1] as number[]).toContain(valueOf("sv_db_up") ?? -1);

    // `-1` is the documented "this collector threw" sentinel; any other negative
    // would mean a real measurement went backwards.
    for (const name of ["sv_conversations_active", "sv_dial_queue_pending", "sv_outbox_pending"]) {
      expect(valueOf(name)).toBeGreaterThanOrEqual(-1);
    }
    for (const name of [
      "sv_process_resident_memory_bytes",
      "sv_process_heap_used_bytes",
      "sv_process_uptime_seconds",
      "sv_db_probe_latency_ms",
      "sv_scrape_duration_ms",
      "sv_audit_rows_24h",
      "sv_audit_last_write_age_seconds",
      "sv_outbox_oldest_pending_age_seconds",
    ]) {
      expect(valueOf(name)).toBeGreaterThanOrEqual(0);
    }

    // The published HELP text calls this "a fraction of the burst ceiling", so
    // it must at least be CONSISTENT with the two series it is derived from.
    // (KNOWN GAP — src/app/api/metrics/route.ts:125-139 divides a GLOBAL
    // `activeConversations` count by the PER-INSTANCE
    // `ELEVENLABS_BURST_CEILING`, so the ratio routinely exceeds 1 — it read
    // 3.75 against a ceiling of 12 while this suite ran. The label is wrong, not
    // the arithmetic; a ratio of two differently-scoped quantities cannot be
    // used as a utilisation percentage. The identity below is the part that IS a
    // real invariant and is asserted exactly.)
    const active = valueOf("sv_conversations_active");
    const ceiling = valueOf("sv_vendor_ceiling_concurrent");
    const utilisation = valueOf("sv_vendor_ceiling_utilisation");
    expect(active).toBeGreaterThanOrEqual(0);
    expect(ceiling).toBeGreaterThan(0);
    expect(utilisation).toBeGreaterThanOrEqual(0);
    // The route rounds the quotient to 4dp, so the tolerance is one unit in the
    // last place of that rounding, times the divisor.
    expect(Math.abs((utilisation ?? 0) * (ceiling ?? 1) - (active ?? 0))).toBeLessThanOrEqual(
      (ceiling ?? 1) * 5e-5,
    );

    // A counter that can decrease is a gauge wearing the wrong name, and a
    // scraper computing a rate from it reports nonsense.
    const counters = [...parsed.types].filter(([, type]) => type === "counter");
    expect(counters.length).toBeGreaterThan(0);
    for (const [name] of counters) {
      const values = parsed.samples.filter((s) => s.name === name).map((s) => s.value);
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  test("HEAD is a status-only probe carrying no body", async () => {
    const res = await metricsHead();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(null);
    expect(await res.text()).toBe("");
  });

  describe("METRICS_TOKEN lock-down", () => {
    const TOKEN = "metrics-lockdown-token";
    let previous: string | undefined;

    beforeAll(() => {
      previous = process.env.METRICS_TOKEN;
      process.env.METRICS_TOKEN = TOKEN;
    });

    afterAll(() => {
      if (previous === undefined) delete process.env.METRICS_TOKEN;
      else process.env.METRICS_TOKEN = previous;
    });

    test("an unauthenticated scrape is refused with no payload", async () => {
      const res = await metricsGet(new Request("http://localhost/api/metrics"));
      expect(res.status).toBe(401);
      const body = await res.text();
      expect(body.trim()).toBe("unauthorized");
      // A 401 that still carries the exposition is a locked-down endpoint that
      // is in fact wide open.
      expect(body).not.toContain("sv_");
      expect(body).not.toContain(TOKEN);
    });

    test("a wrong or truncated bearer is refused; the right one is served", async () => {
      const refused = [
        `Bearer ${TOKEN}-not`,
        // A prefix of the real token must not authenticate.
        `Bearer ${TOKEN.slice(0, 5)}`,
        // …and neither must an absent `Bearer ` scheme.
        TOKEN,
      ];
      for (const authorization of refused) {
        const res = await metricsGet(
          new Request("http://localhost/api/metrics", { headers: { authorization } }),
        );
        expect(`${authorization.slice(0, 20)} → ${res.status}`).toBe(
          `${authorization.slice(0, 20)} → 401`,
        );
      }

      const allowed = await metricsGet(
        new Request("http://localhost/api/metrics", {
          headers: { authorization: `Bearer ${TOKEN}` },
        }),
      );
      expect(allowed.status).toBe(200);
      expect(await allowed.text()).toContain("sv_db_up");
    });
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * GET /openapi and GET /asyncapi
 * ────────────────────────────────────────────────────────────────────────── */

const OpenApiBody = z.object({
  openapi: z.string().startsWith("3."),
  info: z.object({ title: z.string().min(1), version: z.string().min(1) }),
  servers: z.array(z.object({ url: z.string().min(1) })).min(1),
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  components: z.object({
    schemas: z.record(z.string(), z.unknown()),
    securitySchemes: z.record(z.string(), z.unknown()),
    // Declared because the document `$ref`s into it, and Zod strips whatever a
    // schema does not name — a stripped `parameters` would make every one of
    // those refs look dangling.
    parameters: z.record(z.string(), z.unknown()),
  }),
});

const AsyncApiBody = z.object({
  asyncapi: z.string().startsWith("3."),
  info: z.object({ title: z.string().min(1), version: z.string().min(1) }),
  channels: z.record(z.string(), z.unknown()),
  operations: z.record(z.string(), z.unknown()),
  components: z.object({
    schemas: z.record(z.string(), z.unknown()),
    messages: z.record(z.string(), z.unknown()),
  }),
  // The delivery ladder lives in a vendor extension rather than a core key; it
  // is declared here because it is the part a receiver most needs.
  "x-delivery": z.record(z.string(), z.unknown()),
});

/**
 * Collect every `$ref` in a document. Walks the whole tree rather than a known
 * set of locations, because a `$ref` in an extension block is just as broken as
 * one under `paths`.
 */
function collectRefs(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, found);
    return found;
  }
  if (node === null || typeof node !== "object") return found;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") found.push(value);
    else collectRefs(value, found);
  }
  return found;
}
/**
 * Resolve a local JSON pointer (`#/components/schemas/X`) against a document,
 * returning `undefined` when any segment is missing. `getOwnPropertyDescriptor`
 * is used rather than an index cast so a missing segment is an ordinary `null`
 * check instead of an assertion that could lie.
 */
function resolvePointer(document: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let cursor: unknown = document;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cursor === null || typeof cursor !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(cursor, segment);
    if (!descriptor) return undefined;
    cursor = descriptor.value;
  }
  return cursor;
}

/** One served document, the spec version it claims, and where `$ref`s may point. */
const DOCUMENTS = [
  {
    name: "GET /openapi",
    versionKey: "openapi",
    version: "3.1.0",
    fetch: openapiGet,
    schema: OpenApiBody,
    refPrefixes: ["#/components/"],
  },
  {
    name: "GET /asyncapi",
    versionKey: "asyncapi",
    version: "3.0.0",
    fetch: asyncapiGet,
    schema: AsyncApiBody,
    // AsyncAPI 3 additionally addresses operations through the channel tree, so
    // a ref into `#/channels/…` is legal there — and a typo in it still breaks
    // every generated client exactly as a bad `#/components/` ref does.
    refPrefixes: ["#/components/", "#/channels/"],
  },
];

for (const document of DOCUMENTS) {
  describe(`${document.name} — the published machine-readable contract`, () => {
    const load = async () => {
      const res = await document.fetch();
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      // The document is a pure function of the source, so it MAY be cached — and
      // must be revalidated, because a contract change is a deploy.
      expect(res.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
      const raw = await res.text();
      const result = document.schema.safeParse(JSON.parse(raw) as unknown);
      // Spelled out so a shape change fails naming the field rather than
      // asserting a bare boolean.
      if (!result.success) throw new Error(result.error.message);
      return result.data;
    };

    test("serves a parseable document with the published envelope shape", async () => {
      const parsed = await load();
      expect(Object.keys(parsed).length).toBeGreaterThan(3);
      // The declared spec version is what a generator dispatches on; a document
      // claiming a version nobody implements is worse than no document at all.
      expect(z.record(z.string(), z.unknown()).parse(parsed)[document.versionKey]).toBe(
        document.version,
      );
    });

    test("is byte-identical across two fetches", async () => {
      // A generated timestamp or a random id in the document itself would make
      // every build a different artefact, defeating diffing and any gate built on
      // "did the contract change?". Byte-identity is the whole proof.
      const [first, second] = await Promise.all([
        document.fetch().then((r) => r.text()),
        document.fetch().then((r) => r.text()),
      ]);
      expect(first).toBe(second);
      expect(first.length).toBeGreaterThan(1_000);
    });

    test("every $ref resolves to a node that exists", async () => {
      const parsed = await load();
      const refs = [...new Set(collectRefs(parsed))];
      // Non-vacuity: a document with no refs proves nothing about ref resolution.
      expect(refs.length).toBeGreaterThan(0);

      const dangling: string[] = [];
      for (const ref of refs) {
        expect(document.refPrefixes.some((prefix) => ref.startsWith(prefix))).toBe(true);
        if (resolvePointer(parsed, ref) === undefined) dangling.push(ref);
      }
      // A dangling `$ref` produces a client that does not compile, and nothing
      // in the served response says so.
      expect(dangling).toEqual([]);
    });
  });
}

describe("GET /openapi — inbound contract specifics", () => {
  test("every declared path is absolute and every verb is a real one", async () => {
    const doc = OpenApiBody.parse(await openapiGet().then((r) => r.json()));
    const paths = Object.keys(doc.paths);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.startsWith("/")).toBe(true);
      expect(path).not.toContain(" ");
      expect(path).not.toContain("//");

      const verbs = Object.keys(doc.paths[path] ?? {});
      expect(`${path} → ${verbs.length}`).not.toBe(`${path} → 0`);
      for (const verb of verbs) {
        expect(["get", "post", "put", "patch", "delete", "head"]).toContain(verb);
        const operation = z.record(z.string(), z.unknown()).parse(doc.paths[path]?.[verb]);
        // `operationId` is what a generated client names its method after;
        // `responses` is what it types the return value from.
        expect(typeof operation["operationId"]).toBe("string");
        expect(Object.keys(operation)).toContain("responses");
      }
    }
  });

  test("documents the canonical ingest path behind every declared auth scheme", async () => {
    const doc = OpenApiBody.parse(await openapiGet().then((r) => r.json()));
    expect(Object.keys(doc.paths)).toContain("/v1/interventions");

    const ingest = z.record(z.string(), z.unknown()).parse(doc.paths["/v1/interventions"]);
    const post = z.record(z.string(), z.unknown()).parse(ingest["post"]);
    const security = z.array(z.record(z.string(), z.array(z.unknown()))).parse(post["security"]);
    const offered = security.map((entry) => Object.keys(entry)[0]);
    // HMAC is what a bank posts with today; the producer key is the headless
    // path it migrates to. Dropping ProducerKey produces a generated client that
    // cannot use the integration at all.
    expect(offered).toEqual(["SvSignature", "ProducerKey"]);
    // And a scheme declared in `components` but offered on no operation is a
    // definition nothing can use — the drift this pair of assertions closes.
    expect([...offered].sort()).toEqual(Object.keys(doc.components.securitySchemes).sort());
  });

  test("servers are absolute so a generated client has a base URL", async () => {
    const doc = OpenApiBody.parse(await openapiGet().then((r) => r.json()));
    for (const server of doc.servers) expect(server.url).toMatch(/^https?:\/\//);
  });
});

describe("GET /asyncapi — outbound webhook contract specifics", () => {
  test("every channel is addressed and every operation names one", async () => {
    const doc = AsyncApiBody.parse(await asyncapiGet().then((r) => r.json()));
    const channels = Object.keys(doc.channels);
    expect(channels.length).toBeGreaterThan(0);

    for (const channel of channels) {
      const node = z.record(z.string(), z.unknown()).parse(doc.channels[channel]);
      // A channel with no address is a promise of a delivery never made.
      const address = z.string().min(1).parse(node["address"]);
      // Every `{placeholder}` in the address must be a declared parameter, or
      // the bank cannot tell what to substitute into it.
      const parameters = z.record(z.string(), z.unknown()).parse(node["parameters"]);
      for (const [, name] of address.matchAll(/\{([^}]+)\}/g)) {
        expect(Object.keys(parameters)).toContain(name ?? "");
      }
      // The messages a channel carries must be component refs, not inline
      // copies — an inline envelope is a second copy that starts drifting.
      const messages = z.record(z.string(), z.unknown()).parse(node["messages"]);
      for (const message of Object.values(messages)) {
        expect(z.record(z.string(), z.unknown()).parse(message)["$ref"]).toMatch(
          /^#\/components\/messages\//,
        );
      }
    }

    const operations = doc.operations;
    const names = Object.keys(operations);
    expect(names.length).toBeGreaterThanOrEqual(channels.length);
    for (const name of names) {
      const operation = z.record(z.string(), z.unknown()).parse(operations[name]);
      // `action` is how a publisher knows which way the message travels.
      expect(["send", "receive"] as unknown[]).toContain(operation["action"]);
      expect(typeof operation["summary"]).toBe("string");
      expect(
        String(z.record(z.string(), z.unknown()).parse(operation["channel"])["$ref"] ?? ""),
      ).toMatch(/^#\/channels\//);
      // Every delivery is signed; a document that omits the scheme teaches a
      // bank the signature is optional.
      expect(z.array(z.unknown()).parse(operation["security"]).length).toBeGreaterThan(0);
    }
  });

  test("publishes a non-decreasing retry ladder a receiver has to tolerate", async () => {
    const doc = AsyncApiBody.parse(await asyncapiGet().then((r) => r.json()));
    const delivery = doc["x-delivery"];
    const maxAttempts = z.number().int().positive().parse(delivery["maxAttempts"]);
    const ladderMs = z.array(z.number().int().positive()).parse(delivery["ladderMs"]);
    const human = z.array(z.string().min(1)).parse(delivery["ladderHuman"]);
    // A receiver that does not know the ladder cannot be idempotent under it,
    // and a ladder with a different length than the attempt budget advertises a
    // schedule that will never run to completion.
    expect(ladderMs).toHaveLength(maxAttempts);
    expect(human).toHaveLength(ladderMs.length);
    // Non-decreasing, or the final attempt fires before the second one and the
    // ordering a receiver relies on is gone.
    for (let i = 1; i < ladderMs.length; i++) {
      expect(ladderMs[i]).toBeGreaterThanOrEqual(ladderMs[i - 1] ?? 0);
    }
    // The dedupe key has to be named: it is what the receiver implements, and an
    // unnamed dedupe key means a receiver that dedupes on the signature — which
    // changes on every retry — applies each event twice.
    expect(delivery["dedupeKey"]).toBe("event_id");
    // Retryable statuses are a mix of exact codes and ranges; a receiver that
    // retries a 408 or a 429 is behaving correctly, and one that retries a 400
    // is amplifying a permanent failure.
    const retryable = z
      .array(z.union([z.number().int(), z.string().min(1)]))
      .parse(delivery["retryableStatuses"]);
    expect(retryable).toEqual(expect.arrayContaining([408, 429, "5xx"]));
    expect(retryable).not.toContain(400);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * robots.txt — resolve real URLs against the declared rules
 * ────────────────────────────────────────────────────────────────────────── */

type RobotsRule = {
  userAgent: string | string[];
  allow?: string | string[];
  disallow?: string | string[];
};

const ROBOT_RULES = robots().rules as RobotsRule[];

/** Normalise the one-or-many union Next's type allows into a plain list. */
function list(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Resolve a path for a named crawler the way a compliant crawler does: the group
 * whose user-agent matches exactly, else the `*` group; within it the LONGEST
 * matching rule wins, and an `allow` tie beats a `disallow`. Unmatched is allowed.
 */
function crawlDecision(path: string, agent: string): "allow" | "disallow" {
  const group =
    ROBOT_RULES.find((rule) => list(rule.userAgent).includes(agent)) ??
    ROBOT_RULES.find((rule) => list(rule.userAgent).includes("*"));
  if (!group) return "allow";

  let best: { rule: string; kind: "allow" | "disallow" } | undefined;
  for (const kind of ["allow", "disallow"] as const) {
    for (const rule of list(group[kind])) {
      if (!path.startsWith(rule)) continue;
      if (
        !best ||
        rule.length > best.rule.length ||
        (rule.length === best.rule.length && kind === "allow")
      ) {
        best = { rule, kind };
      }
    }
  }
  return best?.kind ?? "allow";
}

describe("robots.txt — the declared rules actually deny what they claim", () => {
  test("every declared no-index prefix denies a concrete URL beneath it", () => {
    // tests/surface/surface.test.ts asserts the prefixes are PRESENT. This
    // asserts they are REACHED: a longer `allow` introduced anywhere would shadow
    // a disallow while still reading perfectly in review.
    for (const prefix of NO_INDEX) {
      expect(crawlDecision(prefix, "*")).toBe("disallow");
      expect(crawlDecision(`${prefix}probe-segment`, "*")).toBe("disallow");
    }
  });

  test.each([
    ["/api/console/audit", "the operator audit feed"],
    ["/api/enroll", "the enrollment write surface"],
    ["/api/webhooks/receiver", "the signed webhook receiver"],
    ["/v1/interventions", "the headless ingest alias"],
    ["/inspector", "the signature debug tool"],
    ["/_next/static/chunk.js", "build output"],
  ])("denies %s — %s", (path) => {
    expect(crawlDecision(path, "*")).toBe("disallow");
  });

  test.each(["/", "/security", "/docs", "/legal/privacy", "/robots.txt", "/sitemap.xml"])(
    "allows %s — marketing and docs stay indexable",
    (path) => {
      expect(crawlDecision(path, "*")).toBe("allow");
    },
  );

  test("every named AI crawler is denied at the root, including /", () => {
    const aiGroups = ROBOT_RULES.filter((rule) => !list(rule.userAgent).includes("*"));
    expect(aiGroups.length).toBeGreaterThan(0);
    for (const group of aiGroups) {
      const agents = list(group.userAgent);
      expect(agents.length).toBeGreaterThan(1);
      for (const agent of agents) {
        // The root is where the deny has to hold: an AI crawler handed "/" must
        // not be told it may take the marketing page.
        expect(`${agent} / → ${crawlDecision("/", agent)}`).toBe(`${agent} / → disallow`);
        expect(crawlDecision("/api/console/audit", agent)).toBe("disallow");
      }
    }
  });

  test("advertises exactly one absolute sitemap on a path crawlers may fetch", () => {
    // Next types `sitemap` as string | URL | array; this route emits one string,
    // and the parse both narrows it and proves there is no second sitemap.
    const sitemap = z.string().min(1).parse(robots().sitemap);
    expect(sitemap).toBe(`${siteOrigin()}/sitemap.xml`);
    expect(sitemap).toMatch(/^https?:\/\//);
    expect(sitemap.endsWith("//")).toBe(false);
    // A sitemap the crawler is forbidden to fetch is a sitemap never read,
    // however correct its contents are.
    expect(crawlDecision("/sitemap.xml", "*")).toBe("allow");
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * /v1/conformance/run
 * ────────────────────────────────────────────────────────────────────────── */

const FailureBody = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  requestId: z.string().min(1),
  docsUrl: z.string().startsWith("http"),
});

const ProbeKind = z.enum([
  "valid_delivery",
  "replay",
  "tampered_signature",
  "unsigned",
  "malformed",
]);

const ConformanceReport = z.object({
  report_version: z.string().min(1),
  run_id: z.string().min(1),
  generated_at: z.string().min(1),
  target: z.object({ url: z.string().min(1), host: z.string().min(1) }),
  budget_ms: z.number().int().positive(),
  checks: z
    .array(
      z.object({
        id: z.enum(CONFORMANCE_CHECK_IDS),
        title: z.string().min(1),
        status: z.enum(["pass", "fail"]),
        observed: z.string().min(1),
        requirement: z.string().min(1),
      }),
    )
    .length(CONFORMANCE_CHECK_IDS.length),
  score: z.object({
    passed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    percent: z.number().int().min(0).max(100),
    verdict: z.enum(["conforming", "non_conforming"]),
  }),
  probes: z
    .array(
      z.object({
        seq: z.number().int().positive(),
        kind: ProbeKind,
        status: z.number().int().nonnegative(),
        latencyMs: z.number().nonnegative(),
        signed: z.boolean(),
        event_id: z.string().min(1),
      }),
    )
    .length(CONFORMANCE_CHECK_IDS.length),
  notes: z.array(z.string().min(1)).min(1),
});

const RECEIVER_SECRET = "conformance-receiver-secret-value";

/** Event ids a correct receiver has already applied, for its dedupe answer. */
const appliedEventIds = new Set<string>();
let goodReceiverHits = 0;

/** A real receiver that satisfies every obligation, for the conforming run. */
async function handleGoodReceiver(req: Request): Promise<Response> {
  goodReceiverHits += 1;
  const raw = await req.text();
  const verdict = verifySignature(req.headers.get("sv-signature"), raw, RECEIVER_SECRET);
  if (!verdict.ok) return new Response(`signature rejected: ${verdict.reason}`, { status: 401 });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Response("body was not JSON", { status: 400 });
  }
  if (parsed === null || typeof parsed !== "object") {
    return new Response("body was not an object", { status: 400 });
  }
  const envelope = z.record(z.string(), z.unknown()).parse(parsed);
  const data: unknown = envelope["data"];
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return new Response("data must be an object", { status: 400 });
  }

  const eventId = String(envelope["event_id"]);
  const json = { "content-type": "application/json" };
  if (appliedEventIds.has(eventId)) {
    return new Response(JSON.stringify({ duplicate: true }), {
      status: 200,
      headers: { ...json, "x-securevoice-duplicate": "true" },
    });
  }
  appliedEventIds.add(eventId);
  return new Response(JSON.stringify({ ok: true, event_id: eventId }), {
    status: 200,
    headers: json,
  });
}

let badReceiverHits = 0;

/** A receiver that acknowledges everything — the failure mode being named. */
async function handleBadReceiver(): Promise<Response> {
  badReceiverHits += 1;
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("/v1/conformance/run — the self-serve checker", () => {
  let goodUrl: string;
  let badUrl: string;

  beforeAll(() => {
    const good = Bun.serve({ port: 0, fetch: handleGoodReceiver });
    const bad = Bun.serve({ port: 0, fetch: () => handleBadReceiver() });
    goodUrl = `http://127.0.0.1:${good.port}/webhook`;
    badUrl = `http://127.0.0.1:${bad.port}/webhook`;
  });

  describe("GET — discovery, without firing a probe", () => {
    test("describes the same five checks the checker actually runs", async () => {
      const res = await conformanceGet();
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");

      const body = z
        .object({
          endpoint: z.literal("POST /v1/conformance/run"),
          auth: z.array(z.string().min(1)).min(1),
          body: z.record(z.string(), z.string().min(1)),
          checks: z.array(z.enum(CONFORMANCE_CHECK_IDS)),
          semantics: z.string().min(1),
          rateLimit: z.object({
            perHour: z.number().int().positive(),
            retryAfter: z.literal(true),
          }),
          contract: z.string().min(1),
        })
        .parse(await res.json());

      // The discovery document must carry the checker's REAL vocabulary, or a
      // bank integrating against it is held to a contract it was never shown.
      expect(body.checks).toEqual([...CONFORMANCE_CHECK_IDS]);
      expect(body.rateLimit.perHour).toBe(12);
      expect(body.body.receiver_url).toContain("SSRF");
      expect(body.body.secret).toContain("never stored");
      expect(body.semantics).toContain("score.verdict");
      // The shared HMAC secret authenticates the ingest, not this endpoint.
      expect(body.auth.join(" ")).toContain("Bearer svb_");
      expect(body.auth.join(" ")).toContain("is NOT accepted");
    });
  });

  describe("POST — refusals, in the documented order", () => {
    const MALFORMED: [string, string][] = [
      ["a body that is not JSON at all", "{not json"],
      ["a body that is a JSON array", '["receiver_url","secret"]'],
      ["no receiver_url", `{"secret":"${RECEIVER_SECRET}"}`],
      [
        "a secret below the minimum length",
        '{"receiver_url":"https://bank.example/hook","secret":"short"}',
      ],
    ];

    test.each(MALFORMED)("refuses %s before authenticating", async (_label, raw) => {
      const hitsBefore = goodReceiverHits;
      const res = await conformancePost(jsonRequest("/v1/conformance/run", raw));

      expect(res.status).toBe(400);
      const failure = FailureBody.parse(await res.json());
      // The ingest's error vocabulary, not a parallel conformance_* namespace:
      // a producer's retry logic must not branch on the endpoint's URL.
      expect(failure.code).toBe("malformed_request");
      expect(failure.retryable).toBe(false);
      expect(res.headers.get("x-request-id")).toBe(failure.requestId);
      expect(res.headers.get("retry-after")).toBe(null);
      // Refused before any socket: an anonymous caller must not be able to make
      // this deployment dial a URL of their choosing.
      expect(goodReceiverHits).toBe(hitsBefore);
    });

    test("refuses an unauthenticated caller, naming the producer-key requirement", async () => {
      const hitsBefore = goodReceiverHits;
      const req = jsonRequest("/v1/conformance/run", {
        receiver_url: goodUrl,
        secret: RECEIVER_SECRET,
      });
      const res = await conformancePost(req);

      expect(res.status).toBe(401);
      const failure = FailureBody.parse(await res.json());
      expect(failure.code).toBe("unauthenticated");
      expect(failure.message).toContain("producer key");
      expect(goodReceiverHits).toBe(hitsBefore);
    });

    test.each([
      ["http://169.254.169.254/latest/meta-data", "not_https"],
      ["https://user:pass@example.com/hook", "credentials_in_url"],
      ["https://example.com/hook", "private_address"],
    ])("refuses %s with 422 and zero probes", async (receiverUrl, verdictCode) => {
      const hitsBefore = goodReceiverHits;
      const req = jsonRequest(
        "/v1/conformance/run",
        { receiver_url: receiverUrl, secret: RECEIVER_SECRET },
        { authorization: "Bearer svb_refusals" },
      );
      const res = await conformancePost(req);

      expect(`${receiverUrl} → ${res.status}`).toBe(`${receiverUrl} → 422`);
      const failure = FailureBody.parse(await res.json());
      expect(failure.code).toBe("semantically_invalid");
      expect(failure.retryable).toBe(false);
      // The verdict's own code is named, so a bank can tell a policy refusal
      // from a DNS failure from a typo.
      expect(failure.message).toContain(verdictCode);
      expect(goodReceiverHits).toBe(hitsBefore);
    });

    test("rate limits per authenticated caller, and says when to retry", async () => {
      const blocked = {
        // A blocked URL is deliberate: the budget is charged BEFORE the SSRF
        // verdict, so this proves the ordering without issuing 65 local probes.
        receiver_url: "http://example.com/hook",
        secret: RECEIVER_SECRET,
      };
      const statuses: number[] = [];
      for (let n = 0; n < 13; n++) {
        const req = jsonRequest("/v1/conformance/run", blocked, {
          authorization: "Bearer svb_rate-limited-runner",
        });
        statuses.push((await conformancePost(req)).status);
      }
      // Twelve runs fit the hourly budget; the thirteenth is refused. Each of
      // the first twelve still got as far as the SSRF verdict.
      expect(statuses.slice(0, 12)).toEqual(Array.from({ length: 12 }, () => 422));
      expect(statuses[12]).toBe(429);

      const req = jsonRequest("/v1/conformance/run", blocked, {
        authorization: "Bearer svb_rate-limited-runner",
      });
      const res = await conformancePost(req);
      const failure = FailureBody.parse(await res.json());
      expect(failure.code).toBe("rate_limited");
      expect(failure.retryable).toBe(true);
      // A 429 without Retry-After is read by clients as "not now, maybe later".
      const retryAfter = Number(res.headers.get("retry-after"));
      expect(Number.isFinite(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(3600);

      // A different caller has its own budget: the limit is keyed on the
      // authenticated identity, never on a request IP a caller can rotate.
      const other = jsonRequest("/v1/conformance/run", blocked, {
        authorization: "Bearer svb_a-different-runner",
      });
      expect((await conformancePost(other)).status).toBe(422);
    });
  });

  describe("POST — grading a real receiver", () => {
    test("a conforming receiver scores 5/5 and the report never leaks the secret", async () => {
      appliedEventIds.clear();
      const hitsBefore = goodReceiverHits;
      const req = jsonRequest(
        "/v1/conformance/run",
        {
          receiver_url: goodUrl,
          secret: RECEIVER_SECRET,
          budget_ms: 900,
          org_id: "org-conformance-demo",
        },
        { authorization: "Bearer svb_conforming-runner" },
      );
      const res = await conformancePost(req);

      expect(res.status).toBe(200);
      const report = ConformanceReport.parse(await res.json());

      expect(report.score).toEqual({
        passed: CONFORMANCE_CHECK_IDS.length,
        total: CONFORMANCE_CHECK_IDS.length,
        percent: 100,
        verdict: "conforming",
      });
      expect(report.checks.map((check) => check.id)).toEqual([...CONFORMANCE_CHECK_IDS]);
      expect(report.checks.map((check) => check.status)).toEqual(
        CONFORMANCE_CHECK_IDS.map(() => "pass"),
      );
      expect(report.budget_ms).toBe(900);
      expect(report.target.host).toBe(new URL(goodUrl).host);
      // Five probes, one per obligation, in order, and none lost.
      expect(report.probes.map((probe) => probe.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(report.probes.map((probe) => probe.kind)).toEqual([
        "valid_delivery",
        "replay",
        "tampered_signature",
        "unsigned",
        "malformed",
      ]);
      expect(goodReceiverHits - hitsBefore).toBe(CONFORMANCE_CHECK_IDS.length);

      // The secret is the BANK's own receiver secret: used to sign, and present
      // in no report field, no note and no target.
      expect(JSON.stringify(report)).not.toContain(RECEIVER_SECRET);
      // The route appends two notes of its own on top of the checker's, so a
      // bank knows a failing latency may be the network and not a SecureVoice SLA.
      expect(report.notes.join(" ")).toContain("conformance_probe");
      expect(report.notes.join(" ")).toContain("Probe timeout");
      expect(report.notes.join(" ")).toContain("not a SecureVoice SLA");
    });

    test("a receiver that acknowledges everything is named, check by check", async () => {
      const hitsBefore = badReceiverHits;
      const req = jsonRequest(
        "/v1/conformance/run",
        { receiver_url: badUrl, secret: RECEIVER_SECRET },
        { authorization: "Bearer svb_broken-runner" },
      );
      const res = await conformancePost(req);

      // 200, not 5xx: a failing grade is a SUCCESSFUL run, and that is what
      // makes the report safe to attach to a change record.
      expect(res.status).toBe(200);
      const report = ConformanceReport.parse(await res.json());

      expect(report.score.verdict).toBe("non_conforming");
      expect(report.score.percent).toBe(20);
      const byId = new Map(report.checks.map((check) => [check.id, check]));
      // It answered in time, so that is the only obligation it kept.
      expect(report.checks.filter((check) => check.status === "pass").map((c) => c.id)).toEqual([
        "fast_2xx",
      ]);
      expect(report.checks.filter((check) => check.status === "fail").map((c) => c.id)).toEqual([
        "signature_verified",
        "idempotency_honoured",
        "replay_handled",
        "rejects_malformed",
      ]);

      // "Names the offending path": the report must say what was OBSERVED, not
      // merely that a check failed — a bank cannot fix an unnamed defect.
      expect(byId.get("signature_verified")?.observed).toContain("unsigned → HTTP 200");
      expect(byId.get("idempotency_honoured")?.observed).toContain(
        "never identified the event_id it applied",
      );
      expect(byId.get("replay_handled")?.observed).toContain("no idempotency marker");
      expect(byId.get("rejects_malformed")?.observed).toContain("ACKNOWLEDGED");
      // Every check carries the requirement it grades, so the report is a fix
      // list rather than a verdict.
      for (const check of report.checks) expect(check.requirement.length).toBeGreaterThan(20);
      expect(report.probes).toHaveLength(CONFORMANCE_CHECK_IDS.length);
      expect(badReceiverHits - hitsBefore).toBe(CONFORMANCE_CHECK_IDS.length);
    });

    test("clamps the latency budget rather than trusting the caller", async () => {
      for (const [asked, expected] of [
        [MIN_BUDGET_MS - 5_000, MIN_BUDGET_MS],
        [MAX_BUDGET_MS + 5_000, MAX_BUDGET_MS],
      ] as const) {
        const req = jsonRequest(
          "/v1/conformance/run",
          { receiver_url: goodUrl, secret: RECEIVER_SECRET, budget_ms: asked },
          { authorization: `Bearer svb_clamp-${asked}` },
        );
        const res = await conformancePost(req);
        const report = ConformanceReport.parse(await res.json());
        expect(`${asked} → ${report.budget_ms}`).toBe(`${asked} → ${expected}`);
      }
    });
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * /api/enroll
 * ────────────────────────────────────────────────────────────────────────── */

const EnrollDiscovery = z.object({
  endpoint: z.literal("POST /api/enroll"),
  actions: z.object({
    enroll: z.object({
      customerRef: z.string(),
      phone: z.string(),
      lang: z.string(),
      channel: z.string(),
      consentRecordId: z.string(),
    }),
    optout: z.object({ customerRef: z.string() }),
  }),
  auth: z.string().min(1),
  notes: z.array(z.string().min(1)),
});

const ErrorBody = z.object({ error: z.string().min(1) });

describe("/api/enroll — the PII write surface", () => {
  test("GET publishes the integration contract with no-store", async () => {
    const res = await enrollGet();
    expect(res.status).toBe(200);
    // Enrollment state is per-customer consent; a cached discovery document
    // would be served from a shared cache.
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = EnrollDiscovery.parse(await res.json());
    expect(body.actions.enroll.lang).toBe("en|ar|hi|ur|fr|sw");
    expect(body.actions.enroll.channel).toBe("call|sms");
    expect(Object.keys(body.actions.optout)).toEqual(["customerRef"]);
    expect(body.auth).toContain("Bearer svb_");
    expect(body.auth).toContain("SV-Signature");
    expect(body.notes.join(" ")).toContain("never logged raw");
  });

  test("an unauthenticated enrollment is refused before any record is read", async () => {
    const req = jsonRequest("/api/enroll", {
      action: "enroll",
      customerRef: "CUST-NOAUTH",
      phone: "+971501234567",
      consentRecordId: "CN-NOAUTH-0001",
    });
    const res = await enrollPost(req);

    expect(res.status).toBe(401);
    const body = ErrorBody.parse(await res.json());
    // A demo-role session is not enough; the message names all three modes so an
    // integrator is not left guessing which one they failed to send.
    expect(body.error).toContain("Operator session");
    expect(body.error).toContain("Bearer svb_");
    expect(body.error).toContain("SV-Signature");
  });

  test("refuses malformed JSON once the caller is authenticated", async () => {
    const raw = "{ this is not json";
    const req = jsonRequest("/api/enroll", raw, hmacHeaders(raw));
    const res = await enrollPost(req);

    expect(res.status).toBe(400);
    expect(ErrorBody.parse(await res.json()).error).toBe("Invalid JSON body");
  });

  test.each([
    ["customerRef", { phone: "+971501234567", consentRecordId: "CN-0001" }],
    ["consentRecordId", { customerRef: "CUST-1", phone: "+971501234567" }],
    ["phone", { customerRef: "CUST-1", consentRecordId: "CN-0001" }],
    [
      "lang",
      { customerRef: "CUST-1", phone: "+971501234567", consentRecordId: "CN-0001", lang: "zz" },
    ],
    ["customerRef", { customerRef: "has spaces", phone: "+971501234567", consentRecordId: "CN-1" }],
    [
      "action",
      { customerRef: "CUST-1", phone: "+971501234567", consentRecordId: "CN-1", action: "x" },
    ],
  ])("a 422 names the offending field path: %s", async (expectedPath, payload) => {
    const raw = JSON.stringify(payload);
    const req = jsonRequest("/api/enroll", raw, hmacHeaders(raw));
    const res = await enrollPost(req);

    expect(res.status).toBe(422);
    // The path is what a bank's integration logs; without it a 422 is a shrug.
    expect(ErrorBody.parse(await res.json()).error).toContain(expectedPath);
  });

  test("a schema-valid phone that is not E.164 is refused with the format", async () => {
    const raw = JSON.stringify({
      action: "enroll",
      customerRef: "CUST-BADPHONE",
      phone: "0501234567",
      consentRecordId: "CN-BADPHONE-0001",
    });
    const req = jsonRequest("/api/enroll", raw, hmacHeaders(raw));
    const res = await enrollPost(req);

    expect(res.status).toBe(422);
    const body = ErrorBody.parse(await res.json());
    expect(body.error).toContain("E.164");
    // The example belongs in the message; without it the caller guesses.
    expect(body.error).toContain("+971501234567");
  });

  test("rate limits an unauthenticated flood before spending anything else", async () => {
    const previous = process.env.RATE_LIMIT_PER_HOUR;
    process.env.RATE_LIMIT_PER_HOUR = "1";
    try {
      const payload = { action: "optout", customerRef: "CUST-RATELIMIT" };
      const first = await enrollPost(
        jsonRequest("/api/enroll", payload, {
          "x-securevoice-client-ip": "203.0.113.7",
        }),
      );
      // Anonymous, so it is refused — but the budget was still spent, which is
      // the point: the limiter is the first thing an unauthenticated caller hits.
      expect(first.status).toBe(401);

      const second = await enrollPost(
        jsonRequest("/api/enroll", payload, {
          "x-securevoice-client-ip": "203.0.113.7",
        }),
      );
      expect(second.status).toBe(429);
      const retryAfter = Number(second.headers.get("retry-after"));
      expect(Number.isFinite(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(ErrorBody.parse(await second.json()).error).toContain("Rate limit");
    } finally {
      if (previous === undefined) delete process.env.RATE_LIMIT_PER_HOUR;
      else process.env.RATE_LIMIT_PER_HOUR = previous;
    }
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * /api/pilot
 * ────────────────────────────────────────────────────────────────────────── */

describe("POST /api/pilot — the public intake form", () => {
  // A distinct client IP per case: the limiter is a module-local sliding
  // window, so a shared key would let one test consume another's budget.
  let ipCounter = 0;
  const nextIp = () => `198.51.100.${(ipCounter += 1)}`;

  test("a body that is not JSON is refused with the form's error shape", async () => {
    const req = jsonRequest("/api/pilot", "<xml/>", {
      "x-securevoice-client-ip": nextIp(),
    });
    const res = await pilotPost(req);

    expect(res.status).toBe(400);
    const body = z
      .object({ ok: z.literal(false), error: z.literal("Invalid request body.") })
      .parse(await res.json());
    expect(body.ok).toBe(false);
  });

  test.each([
    ["Name is too short", { name: "A", email: "a@b.com", institution: "Bank" }],
    ["Institution is too short", { name: "Ada", email: "a@b.com", institution: "B" }],
    ["Invalid email address", { name: "Ada", email: "not-an-email", institution: "Bank" }],
  ])("a 422 carries the field's own message: %s", async (expectedMessage, payload) => {
    const req = jsonRequest("/api/pilot", payload, {
      "x-securevoice-client-ip": nextIp(),
    });
    const res = await pilotPost(req);

    expect(res.status).toBe(422);
    const body = z.object({ ok: z.literal(false), error: z.string() }).parse(await res.json());
    // Each field's own message, not a generic "invalid": the form renders this
    // string verbatim beside the input, so it has to say what is wrong.
    expect(body.error).toBe(expectedMessage);
  });

  test("a wrong-typed optional field yields no field name at all — KNOWN GAP", async () => {
    // KNOWN GAP — src/app/api/pilot/route.ts:43-54 gives `name` and
    // `institution` custom messages but leaves every other field on Zod's
    // default, and the handler renders only `issues[0].message`. A non-string
    // `role` therefore returns the bare string "Invalid input", naming neither
    // the field nor the expected type. Asserted so the gap cannot be forgotten;
    // the 422 status and the `ok:false` envelope are asserted alongside it, so
    // this is not a bare "it did not throw" check.
    const req = jsonRequest(
      "/api/pilot",
      { name: "Ada", email: "a@b.com", institution: "Bank", role: 7 },
      { "x-securevoice-client-ip": nextIp() },
    );
    const res = await pilotPost(req);

    expect(res.status).toBe(422);
    const body = z.object({ ok: z.literal(false), error: z.string() }).parse(await res.json());
    expect(body.error).toBe("Invalid input");
  });

  test("the honeypot is answered as a success and stores nothing", async () => {
    const req = jsonRequest(
      "/api/pilot",
      {
        name: "Definitely A Bot",
        email: "bot@example.com",
        institution: "Bot Bank",
        company_url: "http://spam.example",
      },
      { "x-securevoice-client-ip": nextIp() },
    );
    const res = await pilotPost(req);

    // A bot must not learn it was detected, so the shape is a real submission's
    // success: 200 and ok:true.
    expect(res.status).toBe(200);
    const body = z
      .object({
        ok: z.literal(true),
        ref: z.string().regex(/^SV-P-[0-9A-Z]{5}$/),
        createdAt: z.string().optional(),
      })
      .strict()
      .parse(await res.json());
    // The fixed sentinel ref and the ABSENT createdAt are what prove no row was
    // written: a stored submission always echoes createdAt from the insert.
    expect(body.ref).toBe("SV-P-00000");
    expect("createdAt" in body).toBe(false);
  });

  test("caps submissions from one client at six an hour", async () => {
    const ip = nextIp();
    // The honeypot is filled in on purpose, so the limiter is measured rather
    // than the database, and no rows are created either way.
    const payload = {
      name: "Ada",
      email: "ada@example.com",
      institution: "Bank",
      company_url: "http://spam.example",
    };
    const statuses: number[] = [];
    for (let n = 0; n < 7; n++) {
      const req = jsonRequest("/api/pilot", payload, { "x-securevoice-client-ip": ip });
      statuses.push((await pilotPost(req)).status);
    }
    // Six reach the handler; the seventh is turned away at the edge, which is
    // where it saves the write.
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429]);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * /api/tts
 * ────────────────────────────────────────────────────────────────────────── */

describe("POST /api/tts — validation happens before any provider spend", () => {
  test.each([
    ["a body that is not JSON", "{ nope"],
    ["an empty body", ""],
  ])("refuses %s with 400", async (_label, raw) => {
    const req = jsonRequest("/api/tts", raw);
    const res = await ttsPost(req);

    expect(res.status).toBe(400);
    expect(ErrorBody.parse(await res.json()).error).toBe("Invalid JSON body");
  });

  test.each([
    ["no text", { voice: "en" }],
    ["empty text", { text: "", voice: "en" }],
    ["an out-of-range speed", { text: "hello", voice: "en", speed: 5 }],
    ["an unsupported language", { text: "hello", voice: "en", lang: "zz" }],
  ])("refuses %s with 422 and a machine-readable code", async (_label, payload) => {
    const req = jsonRequest("/api/tts", payload);
    const res = await ttsPost(req);

    expect(res.status).toBe(422);
    // The code travels in the body, not only in prose: WP-22 clients branch on
    // "unknown field" versus "missing field".
    const body = z
      .object({ error: z.literal("Invalid TTS request"), code: z.literal("invalid_payload") })
      .parse(await res.json());
    expect(body.code).toBe("invalid_payload");
  });

  test("names the offending voice and the accepted vocabulary", async () => {
    const req = jsonRequest("/api/tts", { text: "hello", voice: "not-a-real-voice" });
    const res = await ttsPost(req);

    expect(res.status).toBe(422);
    const body = z.object({ error: z.string() }).parse(await res.json());
    expect(body.error).toContain("Unknown voice 'not-a-real-voice'");
    // Telling a caller only that the voice is unknown produces a support ticket;
    // the accepted forms belong in the message.
    expect(body.error).toContain("en|ar|hi|ur|fr|sw");
  });
});
