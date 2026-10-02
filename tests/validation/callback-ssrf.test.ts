/**
 * AUDIT FIX — DNS-rebinding hole on the live `callback_url` path.
 *
 * `src/lib/validation/ssrf.ts` is the real guard: it resolves the hostname and
 * refuses when ANY answer is private, loopback, link-local or a cloud metadata
 * endpoint, and `safeFetch` re-runs it on every redirect hop.
 *
 * The routes did not call it. Both `/api/interventions` (which POSTs the signed
 * outcome to this URL) and `/api/v1/interventions` validated `callback_url` with
 * a ~15-line STRING check that only recognised IP literals and a few hostname
 * suffixes. Every DNS-based bypass sailed straight through it:
 *
 *   · a hostname resolving to 169.254.169.254 (cloud metadata → the node's IAM
 *     credentials) is an ordinary "public hostname" to a regex,
 *   · so is one resolving to 10.x / 127.x / 192.168.x,
 *   · and a 302 into the private network was never validated at all, because
 *     delivery used a bare `fetch` that follows redirects itself.
 *
 * DNS is injected by mocking `node:dns/promises`, so the guard's own
 * `defaultResolver` is exercised — the same code path production takes, with no
 * network. Hostnames are deliberately realistic (`.com`), because ssrf.ts blocks
 * `.test`/`.example`/`.invalid` by SUFFIX; a reserved TLD would pass without any
 * DNS lookup and would not prove anything about resolution.
 *
 * No network, no database:
 *   bun test tests/validation/callback-ssrf.test.ts
 */
import { afterAll, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { SsrfBlockedError, safeFetch, validateOutboundUrl } from "@/lib/validation/ssrf";
import type { ResolvedHost } from "@/lib/validation/ssrf";

/** What each hostname in this file REALLY points at. */
const DNS_TABLE: Record<string, readonly string[]> = {
  // Looks like a bank. Is the cloud metadata endpoint.
  "metadata.bank-domain.com": ["169.254.169.254"],
  // Looks like a bank. Is RFC-1918.
  "internal.bank-domain.com": ["10.0.0.5"],
  // Looks like a bank. Is loopback.
  "loopback.bank-domain.com": ["127.0.0.1"],
  // One public answer and one private answer: the connection race IS the attack.
  "split.bank-domain.com": ["93.184.216.34", "10.0.0.5"],
  // A genuinely public endpoint — the control.
  "bank.example.com": ["93.184.216.34"],
};

mock.module("node:dns/promises", () => ({
  lookup: async (hostname: string): Promise<ResolvedHost[]> => {
    const addresses = DNS_TABLE[hostname.toLowerCase()];
    if (!addresses) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  },
}));

// ── The guard ────────────────────────────────────────────────────────────────

test("SSRF: a hostname resolving to a private address is refused", async () => {
  const verdict = await validateOutboundUrl("https://internal.bank-domain.com/hook");
  expect(verdict.ok).toBe(false);
  if (verdict.ok) throw new Error("unreachable");
  expect(verdict.code).toBe("private_address");
  expect(verdict.host).toBe("internal.bank-domain.com");
  expect(verdict.reason).toContain("private");

  const loopback = await validateOutboundUrl("https://loopback.bank-domain.com/hook");
  expect(loopback.ok).toBe(false);
});

test("SSRF: a metadata-endpoint host is refused, by resolved address and by name", async () => {
  // By resolved address, behind an innocuous hostname — the DNS-rebinding case.
  const rebound = await validateOutboundUrl("https://metadata.bank-domain.com/latest/meta-data/");
  expect(rebound.ok).toBe(false);
  if (!rebound.ok) {
    expect(rebound.code).toBe("private_address");
    expect(rebound.reason).toContain("metadata");
  }

  // By well-known metadata hostname (no DNS needed).
  const byName = await validateOutboundUrl("https://metadata.google.internal/computeMetadata/v1/");
  expect(byName.ok).toBe(false);
  if (!byName.ok) expect(byName.code).toBe("blocked_hostname");

  // By IP literal.
  const byLiteral = await validateOutboundUrl("https://169.254.169.254/latest/meta-data/");
  expect(byLiteral.ok).toBe(false);
  if (!byLiteral.ok) expect(byLiteral.code).toBe("private_address");
});

test("SSRF: a genuinely public callback is allowed (the control)", async () => {
  const verdict = await validateOutboundUrl("https://bank.example.com/webhooks/securevoice");
  expect(verdict.ok).toBe(true);
  if (verdict.ok) expect(verdict.addresses).toEqual(["93.184.216.34"]);
});

test("SSRF: one public answer among private ones is still refused", async () => {
  const mixed = await validateOutboundUrl("https://split.bank-domain.com/");
  expect(mixed.ok).toBe(false);
  if (!mixed.ok) expect(mixed.code).toBe("private_address");
});

test("SSRF: a redirect into the private network is refused before that hop is dialled", async () => {
  const requested: string[] = [];
  const fetchImpl = (async (url: string) => {
    requested.push(url);
    return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/" } });
  }) as unknown as typeof fetch;

  let threw: unknown = null;
  try {
    await safeFetch("https://bank.example.com/hook", {}, { fetchImpl });
  } catch (err) {
    threw = err;
  }
  expect(threw).toBeInstanceOf(SsrfBlockedError);
  // The first hop was requested; the redirect TARGET never was.
  expect(requested).toEqual(["https://bank.example.com/hook"]);
});

// ── The live routes ──────────────────────────────────────────────────────────

const SECRET = "ssrf-test-secret";
const RUN = Date.now().toString(36);

/** The v1 signal shape: flat snake_case, `consent_record_id` REQUIRED. */
function v1Signal(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    transaction_ref: `TXN-SSRF-${RUN}-${Math.random().toString(36).slice(2, 8)}`,
    risk_score: 0.95,
    language: "en",
    phone: "+971509876543",
    currency: "AED",
    amount: 250000,
    consent_record_id: `CONSENT-SSRF-${RUN}-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  };
}

function signed(path: string, body: unknown): Request {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000).toString();
  const v1 = createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex");
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sv-signature": `t=${t},v1=${v1}`,
      "idempotency-key": `ssrf-${RUN}-${Math.random().toString(36).slice(2)}`,
    },
    body: raw,
  });
}

afterAll(() => {
  delete process.env.WEBHOOK_SECRET;
});

test("LIVE ROUTE /v1/interventions: a callback_url resolving to a metadata endpoint is refused", async () => {
  process.env.WEBHOOK_SECRET = SECRET;
  const { POST } = await import("@/app/api/v1/interventions/route");

  const res = await POST(
    signed("/api/v1/interventions", v1Signal({ callback_url: "https://metadata.bank-domain.com/latest/meta-data/" })) as never
  );

  // 422, not 202: the signal is refused before any case is persisted or dialled.
  expect(res.status).toBe(422);
  // WP-21: this route now answers in the failure envelope, which has no
  // `error` field. The refusal is unchanged — 422, before any case is persisted
  // or dialled — only the shape is the documented one.
  const body = (await res.json()) as { code?: string; message?: string; retryable?: boolean };
  expect(body.code).toBe("semantically_invalid");
  expect(body.message ?? "").toContain("callback_url");
  expect(body.retryable).toBe(false);
});

test("LIVE ROUTE /v1/interventions: a callback_url resolving to a private address is refused", async () => {
  process.env.WEBHOOK_SECRET = SECRET;
  const { POST } = await import("@/app/api/v1/interventions/route");

  const res = await POST(
    signed("/api/v1/interventions", v1Signal({ callback_url: "https://internal.bank-domain.com/hook" })) as never
  );

  expect(res.status).toBe(422);
  // WP-21: this route now answers in the failure envelope, which has no
  // `error` field. The refusal is unchanged — 422, before any case is persisted
  // or dialled — only the shape is the documented one.
  const body = (await res.json()) as { code?: string; message?: string; retryable?: boolean };
  expect(body.code).toBe("semantically_invalid");
  expect(body.message ?? "").toContain("callback_url");
  expect(body.retryable).toBe(false);
});

test("LIVE ROUTE /interventions: a callbackUrl resolving to a metadata endpoint is refused", async () => {
  process.env.WEBHOOK_SECRET = SECRET;
  const { POST } = await import("@/app/api/interventions/route");

  const res = await POST(
    signed("/api/interventions", {
      signal: {
        caseId: `SSRF-CASE-${RUN}-${Math.random().toString(36).slice(2, 8)}`,
        riskScore: 0.95,
        channel: "card",
        customer: { ref: `CUST-${RUN}`, lang: "en" },
        transaction: { amountAed: 2500, merchant: "Electronics World" },
        callbackUrl: "https://metadata.bank-domain.com/latest/meta-data/",
      },
    }) as never
  );

  expect(res.status).toBe(422);
  const body = (await res.json()) as { error?: string };
  expect(body.error ?? "").toContain("callbackUrl");
});
