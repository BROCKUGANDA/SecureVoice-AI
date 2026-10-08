/**
 * UNIT - CRM handoff: opening a ticket in the institution's own CRM.
 *
 * Everything here is injected: `fetch` is a recording stub, DNS is a stub
 * resolver, time and sleeps are fake. No database and no real network. Where
 * the SSRF guard would otherwise resolve a hostname we either inject a
 * resolver or use only literal-IP / `localhost` targets, which the guard
 * rejects before any DNS lookup.
 *
 * What these tests defend, in order of how much it would hurt to lose it:
 *   - a secret never appears in a returned error, a result, or a log line;
 *   - an operator-typed host never becomes a request to a host we did not mean
 *     (host injection, SSRF);
 *   - the ticket never carries customer data;
 *   - the pipeline never throws into the caller, and retries exactly once.
 */
import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";

import { decryptSecret, encryptSecret } from "@/lib/byok";
import { maskConfig, normalizeConfig, validateConfig } from "@/lib/crm/config";
import {
  buildTicketText,
  createHandoffTicket,
  testConnection,
  type HandoffDeps,
  type LoadedConnection,
} from "@/lib/crm";
import { sendSalesforceCase } from "@/lib/crm/salesforce";
import {
  CRM_PROVIDERS,
  type AdapterDeps,
  type AdapterResult,
  type HandoffTicket,
  type SalesforceConfig,
  type WebhookConfig,
  type ZendeskConfig,
} from "@/lib/crm/types";
import { sendWebhook } from "@/lib/crm/webhook";
import { sendZendeskTicket } from "@/lib/crm/zendesk";

beforeAll(() => {
  process.env.AUTH_SECRET ??= "unit-test-auth-secret-for-crm-sync";
});

const T0 = 1_800_000_000_000;
const PUBLIC_DNS = async () => [{ address: "93.184.216.34", family: 4 }];
const PRIVATE_DNS = async () => [{ address: "10.0.0.5", family: 4 }];

const ticket: HandoffTicket = {
  caseRef: "SV-CASE-ABCD1234",
  orgId: "org-test-1",
  institutionType: "bank",
  signalKind: "card_not_present",
  reason: "sms_reply_no",
  priority: "urgent",
  language: "ar",
  transactionRef: "TXN-7781",
  resolutionMethod: "sms",
  customerResponse: "no",
  auditRef: "AUD-0042",
  consoleUrl: "https://console.securevoice.io/cases/SV-CASE-ABCD1234",
};

const ZD: ZendeskConfig = {
  subdomain: "acme-bank",
  email: "ops@acme.example",
  apiToken: "zd_super_secret_token_value",
  groupId: 987654,
};
const SF: SalesforceConfig = {
  instanceUrl: "https://acme.my.salesforce.com",
  clientId: "sf_client_id_public_value",
  clientSecret: "sf_client_secret_value_xyz",
};
const WH: WebhookConfig = {
  url: "https://hooks.acme.io/securevoice",
  secret: "whsec_super_secret_value_1234567890",
};

const ALL_SECRETS = [ZD.apiToken, SF.clientSecret, WH.secret, "sf_access_token_abcdef"];

type Call = { url: string; init: RequestInit };

function recorder(responses: (Response | Error)[] | ((c: Call, n: number) => Response | Error)) {
  const calls: Call[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    const n = calls.push(call) - 1;
    const r =
      typeof responses === "function" ? responses(call, n) : (responses[n] ?? responses.at(-1)!);
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { calls, fetch: fetchStub };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const deps = (fetchStub: typeof fetch, extra: Partial<AdapterDeps> = {}): AdapterDeps => ({
  fetch: fetchStub,
  now: () => T0,
  resolver: PUBLIC_DNS,
  ...extra,
});

const header = (call: Call, name: string): string | undefined => {
  const h = call.init.headers as Record<string, string>;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : undefined;
};

function noSecretsIn(result: AdapterResult, secrets: string[] = ALL_SECRETS) {
  const text = JSON.stringify(result);
  for (const s of secrets) expect(text.includes(s)).toBe(false);
  expect(text.toLowerCase()).not.toContain("authorization");
  expect(text.toLowerCase()).not.toContain("basic ");
  expect(text.toLowerCase()).not.toContain("bearer ");
}

// ── Zendesk ─────────────────────────────────────────────────────────────────

describe("zendesk adapter", () => {
  test("sends the exact request shape and parses the ticket id", async () => {
    const r = recorder([json(201, { ticket: { id: 4521, url: "https://x" } })]);
    const result = await sendZendeskTicket(ZD, ticket, deps(r.fetch));

    expect(result).toEqual({ ok: true, externalId: "4521" });
    expect(r.calls).toHaveLength(1);
    const call = r.calls[0]!;
    expect(call.url).toBe("https://acme-bank.zendesk.com/api/v2/tickets.json");
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("manual");
    expect(header(call, "authorization")).toBe(
      `Basic ${Buffer.from("ops@acme.example/token:zd_super_secret_token_value").toString("base64")}`,
    );
    expect(header(call, "content-type")).toBe("application/json");

    const body = JSON.parse(String(call.init.body));
    expect(body.ticket.priority).toBe("urgent");
    expect(body.ticket.tags).toEqual(["securevoice", "sms_reply_no", "bank"]);
    expect(body.ticket.external_id).toBe("SV-CASE-ABCD1234");
    expect(body.ticket.group_id).toBe(987654);
    expect(body.ticket.subject).toStartWith("[SecureVoice]");
    expect(typeof body.ticket.comment.body).toBe("string");
  });

  test("omits group_id when not configured", async () => {
    const r = recorder([json(201, { ticket: { id: 1 } })]);
    const { groupId: _g, ...noGroup } = ZD;
    await sendZendeskTicket(noGroup, ticket, deps(r.fetch));
    expect(JSON.parse(String(r.calls[0]!.init.body)).ticket).not.toHaveProperty("group_id");
  });

  test("a 2xx with an unreadable body is still success, without an id", async () => {
    const r = recorder([new Response("<html>", { status: 201 })]);
    expect(await sendZendeskTicket(ZD, ticket, deps(r.fetch))).toEqual({ ok: true });
  });

  test("a remote id that is not a plain identifier is dropped", async () => {
    const r = recorder([json(201, { ticket: { id: "../../etc/passwd" } })]);
    expect(await sendZendeskTicket(ZD, ticket, deps(r.fetch))).toEqual({ ok: true });
  });

  test("4xx is not retryable", async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const r = recorder([json(status, { error: "nope", description: ZD.apiToken })]);
      const result = await sendZendeskTicket(ZD, ticket, deps(r.fetch));
      expect(result).toMatchObject({ ok: false, retryable: false });
      noSecretsIn(result);
    }
  });

  test("5xx, 429 and 408 are retryable", async () => {
    for (const status of [500, 502, 503, 429, 408]) {
      const r = recorder([json(status, {})]);
      expect(await sendZendeskTicket(ZD, ticket, deps(r.fetch))).toMatchObject({
        ok: false,
        retryable: true,
      });
    }
  });

  test("timeout and network errors are retryable and leak nothing", async () => {
    const timeout = Object.assign(new Error(`aborted ${ZD.apiToken}`), { name: "TimeoutError" });
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const network = new TypeError(`fetch failed for Basic ${ZD.apiToken}`);
    for (const err of [timeout, abort, network]) {
      const r = recorder([err]);
      const result = await sendZendeskTicket(ZD, ticket, deps(r.fetch));
      expect(result).toMatchObject({ ok: false, retryable: true });
      noSecretsIn(result);
    }
  });

  test("a real timeout aborts a hanging fetch", async () => {
    const hang = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;
    const started = Date.now();
    const result = await sendZendeskTicket(ZD, ticket, deps(hang, { timeoutMs: 50 }));
    expect(result).toMatchObject({ ok: false, error: "timeout", retryable: true });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test("host-injection attempts in the subdomain are rejected without calling fetch", async () => {
    const attempts = [
      "evil.com/",
      "a.b",
      "x#",
      "",
      "-lead",
      "a b",
      "evil.com@",
      "a/../b",
      "x".repeat(64),
      "UPPER",
      "a:443",
      "a\\b",
    ];
    for (const subdomain of attempts) {
      const r = recorder([json(201, { ticket: { id: 1 } })]);
      const result = await sendZendeskTicket({ ...ZD, subdomain }, ticket, deps(r.fetch));
      expect(result).toEqual({ ok: false, error: "invalid_subdomain", retryable: false });
      expect(r.calls).toHaveLength(0);
    }
  });

  test("the ticket body states the policy and carries no customer data", async () => {
    const r = recorder([json(201, { ticket: { id: 1 } })]);
    await sendZendeskTicket(ZD, ticket, deps(r.fetch));
    const sent = String(r.calls[0]!.init.body);
    expect(sent).toContain("EVIDENCE, not authorisation");
    expect(sent).not.toMatch(/merchant|amount|transcript/i);
  });
});

// ── Salesforce ──────────────────────────────────────────────────────────────

describe("salesforce adapter", () => {
  const happy = () =>
    recorder((_c, n) =>
      n === 0
        ? json(200, { access_token: "sf_access_token_abcdef" })
        : json(201, { id: "500Xx0000012abc", success: true }),
    );

  test("does client-credentials, then creates a Case with exact shapes", async () => {
    const r = happy();
    const result = await sendSalesforceCase(SF, ticket, deps(r.fetch));

    expect(result).toEqual({ ok: true, externalId: "500Xx0000012abc" });
    expect(r.calls).toHaveLength(2);

    const [tokenCall, caseCall] = r.calls as [Call, Call];
    expect(tokenCall.url).toBe("https://acme.my.salesforce.com/services/oauth2/token");
    expect(tokenCall.init.method).toBe("POST");
    expect(header(tokenCall, "content-type")).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(tokenCall.init.body));
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("client_id")).toBe(SF.clientId);
    expect(form.get("client_secret")).toBe(SF.clientSecret);

    expect(caseCall.url).toBe("https://acme.my.salesforce.com/services/data/v60.0/sobjects/Case");
    expect(caseCall.init.method).toBe("POST");
    expect(header(caseCall, "authorization")).toBe("Bearer sf_access_token_abcdef");
    const body = JSON.parse(String(caseCall.init.body));
    expect(body.Origin).toBe("SecureVoice");
    expect(body.Priority).toBe("High");
    expect(typeof body.Subject).toBe("string");
    expect(body.Description).toContain("EVIDENCE, not authorisation");
  });

  test("priority mapping", async () => {
    const seen: string[] = [];
    for (const priority of ["urgent", "high", "normal"] as const) {
      const r = happy();
      await sendSalesforceCase(SF, { ...ticket, priority }, deps(r.fetch));
      seen.push(JSON.parse(String(r.calls[1]!.init.body)).Priority);
    }
    expect(seen).toEqual(["High", "High", "Medium"]);
  });

  test("only the origin of instanceUrl is used", async () => {
    const r = happy();
    await sendSalesforceCase(
      { ...SF, instanceUrl: "https://acme.my.salesforce.com/some/path?x=1#frag" },
      ticket,
      deps(r.fetch),
    );
    expect(r.calls[0]!.url).toBe("https://acme.my.salesforce.com/services/oauth2/token");
  });

  test("auth failure: 4xx is final, 5xx is retryable, nothing leaks", async () => {
    const bad = recorder([
      json(400, { error: "invalid_client", error_description: SF.clientSecret }),
    ]);
    const r400 = await sendSalesforceCase(SF, ticket, deps(bad.fetch));
    expect(r400).toMatchObject({ ok: false, retryable: false });
    noSecretsIn(r400);
    expect(bad.calls).toHaveLength(1);

    const down = recorder([json(503, {})]);
    expect(await sendSalesforceCase(SF, ticket, deps(down.fetch))).toMatchObject({
      ok: false,
      retryable: true,
    });
  });

  test("a token response without access_token is a non-retryable failure", async () => {
    const r = recorder([json(200, { token_type: "Bearer" })]);
    expect(await sendSalesforceCase(SF, ticket, deps(r.fetch))).toMatchObject({
      ok: false,
      retryable: false,
    });
    expect(r.calls).toHaveLength(1);
  });

  test("case-creation failures classify by status and never leak the access token", async () => {
    for (const [status, retryable] of [
      [400, false],
      [401, false],
      [429, true],
      [500, true],
    ] as const) {
      const r = recorder((_c, n) =>
        n === 0
          ? json(200, { access_token: "sf_access_token_abcdef" })
          : json(status, [{ message: "sf_access_token_abcdef" }]),
      );
      const result = await sendSalesforceCase(SF, ticket, deps(r.fetch));
      expect(result).toMatchObject({ ok: false, retryable });
      noSecretsIn(result);
    }
  });

  test("timeout / network error on either leg is retryable", async () => {
    const t = recorder([Object.assign(new Error("x"), { name: "TimeoutError" })]);
    expect(await sendSalesforceCase(SF, ticket, deps(t.fetch))).toMatchObject({
      ok: false,
      error: "timeout",
      retryable: true,
    });
    const n = recorder((_c, i) =>
      i === 0
        ? json(200, { access_token: "sf_access_token_abcdef" })
        : new TypeError("fetch failed"),
    );
    const result = await sendSalesforceCase(SF, ticket, deps(n.fetch));
    expect(result).toMatchObject({ ok: false, retryable: true });
    noSecretsIn(result);
  });

  test("instanceUrl must be https and public: rejected without calling fetch", async () => {
    for (const instanceUrl of [
      "http://acme.my.salesforce.com",
      "https://127.0.0.1",
      "https://169.254.169.254",
      "https://localhost",
      "https://10.0.0.5",
      "https://user:pw@acme.my.salesforce.com",
      "not a url",
    ]) {
      const r = happy();
      const result = await sendSalesforceCase({ ...SF, instanceUrl }, ticket, deps(r.fetch));
      expect(result).toMatchObject({ ok: false, retryable: false });
      expect(r.calls).toHaveLength(0);
    }
  });

  test("a hostname that resolves to a private address is rejected (DNS rebinding shape)", async () => {
    const r = happy();
    const result = await sendSalesforceCase(SF, ticket, deps(r.fetch, { resolver: PRIVATE_DNS }));
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(r.calls).toHaveLength(0);
  });
});

// ── Webhook ─────────────────────────────────────────────────────────────────

describe("webhook adapter", () => {
  test("posts signed JSON with the case.human_review event", async () => {
    const r = recorder([json(200, { id: "evt_123" })]);
    const result = await sendWebhook(WH, ticket, deps(r.fetch));
    expect(result).toEqual({ ok: true, externalId: "evt_123" });

    const call = r.calls[0]!;
    expect(call.url).toBe("https://hooks.acme.io/securevoice");
    expect(call.init.method).toBe("POST");
    expect(header(call, "content-type")).toBe("application/json");

    const body = String(call.init.body);
    const parsed = JSON.parse(body);
    expect(parsed.event).toBe("case.human_review");
    expect(parsed).toMatchObject({
      caseRef: ticket.caseRef,
      orgId: ticket.orgId,
      reason: "sms_reply_no",
      priority: "urgent",
      transactionRef: "TXN-7781",
      auditRef: "AUD-0042",
    });
    expect(parsed).not.toHaveProperty("test");

    // SV-Signature: t={unix},v1={hmac}, over `${t}.${body}` - the outbox scheme.
    const sig = header(call, "SV-Signature")!;
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(Math.floor(T0 / 1000));
    const expected = createHmac("sha256", WH.secret).update(`${m![1]}.${body}`).digest("hex");
    expect(m![2]).toBe(expected);
    // and a different secret does not verify
    const wrong = createHmac("sha256", "another-secret-entirely")
      .update(`${m![1]}.${body}`)
      .digest("hex");
    expect(m![2]).not.toBe(wrong);
  });

  test("only allow-listed fields leave, even if a caller widens the object", async () => {
    const r = recorder([json(200, {})]);
    const widened = {
      ...ticket,
      phone: "+971500000099",
      merchant: "ACME STORE",
      amount: "1234.50",
      transcript: "hello",
      cardLast4: "4242",
    } as HandoffTicket;
    await sendWebhook(WH, widened, deps(r.fetch));
    const sent = String(r.calls[0]!.init.body);
    for (const leaked of ["+971500000099", "ACME STORE", "1234.50", "hello", "4242"]) {
      expect(sent.includes(leaked)).toBe(false);
    }
  });

  test("a test ticket is flagged test:true", async () => {
    const r = recorder([json(200, {})]);
    await sendWebhook(WH, { ...ticket, caseRef: "SV-TEST-AB12CD34" }, deps(r.fetch));
    expect(JSON.parse(String(r.calls[0]!.init.body)).test).toBe(true);
  });

  test("4xx is final; 5xx / 429 / timeout / network are retryable; no secret leaks", async () => {
    for (const [status, retryable] of [
      [400, false],
      [401, false],
      [404, false],
      [301, false],
      [429, true],
      [500, true],
      [503, true],
    ] as const) {
      const r = recorder([json(status, { echo: WH.secret })]);
      const result = await sendWebhook(WH, ticket, deps(r.fetch));
      expect(result).toMatchObject({ ok: false, retryable });
      noSecretsIn(result);
    }
    for (const err of [
      Object.assign(new Error(WH.secret), { name: "TimeoutError" }),
      new TypeError(`connect ECONNREFUSED ${WH.secret}`),
    ]) {
      const r = recorder([err]);
      const result = await sendWebhook(WH, ticket, deps(r.fetch));
      expect(result).toMatchObject({ ok: false, retryable: true });
      noSecretsIn(result);
    }
  });

  test("SSRF: private / loopback / metadata / plaintext targets never reach fetch", async () => {
    // Literal-IP and localhost targets are rejected by the guard BEFORE any DNS
    // lookup, so this part needs no resolver and no network.
    for (const url of [
      "http://127.0.0.1/hook",
      "https://127.0.0.1/hook",
      "http://169.254.169.254/latest/meta-data/",
      "https://169.254.169.254/",
      "http://localhost",
      "https://localhost/hook",
      "https://10.0.0.5/",
      "https://192.168.1.10/",
      "https://[::1]/",
      "https://user:pw@hooks.acme.io/x",
      "https://hooks.acme.io:8443/x",
      "ftp://hooks.acme.io/x",
      "not a url",
    ]) {
      const r = recorder([json(200, {})]);
      const result = await sendWebhook({ ...WH, url }, ticket, deps(r.fetch));
      expect(result).toMatchObject({ ok: false, retryable: false });
      expect(r.calls).toHaveLength(0);
      noSecretsIn(result);
    }
  });

  test("SSRF: a public-looking name resolving to a private address is rejected", async () => {
    const r = recorder([json(200, {})]);
    const result = await sendWebhook(WH, ticket, deps(r.fetch, { resolver: PRIVATE_DNS }));
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(r.calls).toHaveLength(0);
  });
});

// ── Ticket text ─────────────────────────────────────────────────────────────

describe("buildTicketText", () => {
  const reasons = [
    "sms_reply_no",
    "voice_fraud_denied",
    "unreachable_no_reply",
    "voice_failed_sms_unavailable",
    "human_review",
  ] as const;

  test("states the honesty policy for every reason", () => {
    for (const reason of reasons) {
      const { subject, body } = buildTicketText({ ...ticket, reason });
      expect(subject).toStartWith("[SecureVoice]");
      expect(body).toContain("EVIDENCE, not authorisation");
      expect(body).toContain("NOTHING was frozen, blocked or reversed automatically");
      expect(body).toContain("A human must decide");
      expect(body).toContain("full redacted audit chain");
      expect(body).toContain("AUD-0042");
      expect(body).toContain("TXN-7781");
    }
  });

  test("carries no customer data: no phone/PAN-like digit runs, no merchant/amount/transcript", () => {
    for (const reason of reasons) {
      const { subject, body } = buildTicketText({ ...ticket, reason });
      const all = `${subject}\n${body}`;
      expect(all).not.toMatch(/\d{7,}/); // phone numbers, PANs
      expect(all).not.toMatch(/\+\d/);
      expect(all).not.toMatch(/merchant|amount|transcript/i);
    }
  });

  test("widened input cannot smuggle data into the text", () => {
    const widened = {
      ...ticket,
      phone: "+971500000099",
      merchant: "ACME STORE",
      amount: "1234.50",
      transcript: "agent: hello",
    } as HandoffTicket;
    const { subject, body } = buildTicketText(widened);
    for (const leaked of ["+971500000099", "ACME STORE", "1234.50", "agent: hello"]) {
      expect(`${subject}${body}`.includes(leaked)).toBe(false);
    }
  });

  test("references are reduced to a single-line safe character set", () => {
    const { subject, body } = buildTicketText({
      ...ticket,
      transactionRef: "TX-1\n<script>alert(1)</script>",
      auditRef: "AUD\r\nInjected: header",
    });
    expect(subject).not.toContain("\n");
    expect(`${subject}${body}`).not.toContain("<script>");
    expect(body).not.toContain("Injected: header");
  });

  test("a test ticket is clearly labelled", () => {
    const { subject, body } = buildTicketText({
      ...ticket,
      caseRef: "SV-TEST-AB12CD34",
      transactionRef: null,
    });
    expect(subject).toStartWith("[SecureVoice test]");
    expect(body).toContain("THIS IS A TEST TICKET");
  });

  test("handles null optional fields", () => {
    const { body } = buildTicketText({
      ...ticket,
      signalKind: null,
      transactionRef: null,
      resolutionMethod: null,
      customerResponse: null,
      consoleUrl: null,
    });
    expect(body).toContain("Customer response: none");
    expect(body).toContain("Transaction ref: not provided");
  });
});

// ── createHandoffTicket ─────────────────────────────────────────────────────

describe("createHandoffTicket", () => {
  const conns: LoadedConnection[] = [{ provider: "webhook", config: WH }];
  const quiet = (extra: HandoffDeps = {}): HandoffDeps => ({
    log: () => {},
    sleep: async () => {},
    recordResult: async () => {},
    ...extra,
  });

  test("returns [] for a null / empty orgId without loading anything", async () => {
    let loaded = 0;
    const loadConnections = async () => {
      loaded++;
      return conns;
    };
    expect(
      await createHandoffTicket(
        { ...ticket, orgId: null as unknown as string },
        quiet({ loadConnections }),
      ),
    ).toEqual([]);
    expect(await createHandoffTicket({ ...ticket, orgId: "" }, quiet({ loadConnections }))).toEqual(
      [],
    );
    expect(loaded).toBe(0);
  });

  test("returns [] when the org has no connection, calling no adapter", async () => {
    let calls = 0;
    const out = await createHandoffTicket(
      ticket,
      quiet({
        loadConnections: async () => [],
        adapters: { webhook: async () => (calls++, { ok: true }) },
      }),
    );
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  test("never throws when the loader throws", async () => {
    const out = await createHandoffTicket(
      ticket,
      quiet({
        loadConnections: async () => {
          throw new Error(`db down ${WH.secret}`);
        },
      }),
    );
    expect(out).toEqual([]);
  });

  test("never throws when an adapter throws; the failure is reported, not retried", async () => {
    let calls = 0;
    const recorded: AdapterResult[] = [];
    const out = await createHandoffTicket(
      ticket,
      quiet({
        loadConnections: async () => conns,
        adapters: {
          webhook: async () => {
            calls++;
            throw new Error(`boom ${WH.secret}`);
          },
        },
        recordResult: async (_o, _p, r) => void recorded.push(r),
      }),
    );
    expect(out).toEqual([
      { provider: "webhook", result: { ok: false, error: "adapter_exception", retryable: false } },
    ]);
    expect(calls).toBe(1);
    noSecretsIn(out[0]!.result);
    expect(recorded).toHaveLength(1);
  });

  test("never throws when recording the result throws, or when the logger throws", async () => {
    const out = await createHandoffTicket(ticket, {
      loadConnections: async () => conns,
      adapters: { webhook: async () => ({ ok: true, externalId: "e1" }) },
      recordResult: async () => {
        throw new Error("db write failed");
      },
      log: () => {
        throw new Error("logger broke");
      },
      sleep: async () => {},
    });
    expect(out).toEqual([{ provider: "webhook", result: { ok: true, externalId: "e1" } }]);
  });

  test("retries exactly once, after 500 ms, on a retryable failure", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const out = await createHandoffTicket(
      ticket,
      quiet({
        loadConnections: async () => conns,
        adapters: {
          webhook: async () => (calls++, { ok: false, error: "webhook_http_503", retryable: true }),
        },
        sleep: async (ms) => void sleeps.push(ms),
      }),
    );
    expect(calls).toBe(2);
    expect(sleeps).toEqual([500]);
    expect(out[0]!.result).toMatchObject({ ok: false, retryable: true });
  });

  test("a retry that succeeds is reported as success", async () => {
    let calls = 0;
    const out = await createHandoffTicket(
      ticket,
      quiet({
        loadConnections: async () => conns,
        adapters: {
          webhook: async () =>
            ++calls === 1
              ? { ok: false, error: "timeout", retryable: true }
              : { ok: true, externalId: "ok2" },
        },
      }),
    );
    expect(calls).toBe(2);
    expect(out[0]!.result).toEqual({ ok: true, externalId: "ok2" });
  });

  test("does not retry a non-retryable failure or a success", async () => {
    let failing = 0;
    let succeeding = 0;
    await createHandoffTicket(
      ticket,
      quiet({
        loadConnections: async () => conns,
        adapters: {
          webhook: async () => (
            failing++,
            { ok: false, error: "webhook_http_400", retryable: false }
          ),
        },
      }),
    );
    await createHandoffTicket(
      ticket,
      quiet({
        loadConnections: async () => conns,
        adapters: { webhook: async () => (succeeding++, { ok: true }) },
      }),
    );
    expect(failing).toBe(1);
    expect(succeeding).toBe(1);
  });

  test("records lastStatus input for every provider, in parallel, independently", async () => {
    const recorded: [string, boolean][] = [];
    const out = await createHandoffTicket(
      ticket,
      quiet({
        loadConnections: async () => [
          { provider: "zendesk", config: ZD },
          { provider: "salesforce", config: SF },
          { provider: "webhook", config: WH },
        ],
        adapters: {
          zendesk: async () => ({ ok: true, externalId: "z1" }),
          salesforce: async () => ({ ok: false, error: "salesforce_http_400", retryable: false }),
          webhook: async () => {
            throw new Error("x");
          },
        },
        recordResult: async (_o, p, r) => void recorded.push([p, r.ok]),
      }),
    );
    expect(out.map((o) => o.provider).sort()).toEqual(["salesforce", "webhook", "zendesk"]);
    expect(out.find((o) => o.provider === "zendesk")!.result).toEqual({
      ok: true,
      externalId: "z1",
    });
    expect(recorded.sort()).toEqual([
      ["salesforce", false],
      ["webhook", false],
      ["zendesk", true],
    ]);
  });

  test("end to end through the real webhook adapter with a stub fetch", async () => {
    const r = recorder([json(200, { id: "abc" })]);
    const out = await createHandoffTicket(
      ticket,
      quiet({
        loadConnections: async () => conns,
        fetch: r.fetch,
        now: () => T0,
        resolver: PUBLIC_DNS,
      }),
    );
    expect(out).toEqual([{ provider: "webhook", result: { ok: true, externalId: "abc" } }]);
    expect(r.calls).toHaveLength(1);
  });

  test("a fetch that ignores its abort signal is cut off by the backstop deadline", async () => {
    const never = (() => new Promise(() => {})) as unknown as typeof fetch;
    const started = Date.now();
    const out = await createHandoffTicket(
      ticket,
      quiet({
        loadConnections: async () => conns,
        fetch: never,
        resolver: PUBLIC_DNS,
        timeoutMs: 30,
        retryDelayMs: 0,
      }),
    );
    expect(out[0]!.result).toMatchObject({ ok: false, error: "timeout", retryable: true });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

// ── testConnection ──────────────────────────────────────────────────────────

describe("testConnection", () => {
  test("sends a clearly-labelled test ticket and records the result", async () => {
    const r = recorder([json(201, { ticket: { id: 77 } })]);
    const recorded: AdapterResult[] = [];
    const result = await testConnection("org-test-1", "zendesk", {
      loadConnection: async () => ({ provider: "zendesk", config: ZD }),
      fetch: r.fetch,
      recordResult: async (_o, _p, res) => void recorded.push(res),
      sleep: async () => {},
      log: () => {},
    });
    expect(result).toEqual({ ok: true, externalId: "77" });
    const body = JSON.parse(String(r.calls[0]!.init.body));
    expect(body.ticket.subject).toStartWith("[SecureVoice test]");
    expect(body.ticket.external_id).toMatch(/^SV-TEST-[0-9A-F]{8}$/);
    expect(recorded).toEqual([result]);
  });

  test("unknown connection and loader failure do not throw", async () => {
    expect(
      await testConnection("org-test-1", "webhook", { loadConnection: async () => null }),
    ).toEqual({ ok: false, error: "not_configured", retryable: false });
    expect(
      await testConnection("org-test-1", "webhook", {
        loadConnection: async () => {
          throw new Error("db");
        },
      }),
    ).toMatchObject({ ok: false });
    expect(await testConnection("", "webhook")).toMatchObject({ ok: false });
  });
});

// ── Config: validation, masking, encryption ─────────────────────────────────

describe("config validation", () => {
  test("accepts valid configs and drops unknown keys", () => {
    const z = normalizeConfig("zendesk", { ...ZD, groupId: "123", extra: "x" });
    expect(z.ok && z.config).toEqual({ ...ZD, groupId: 123 });
    const s = normalizeConfig("salesforce", {
      ...SF,
      instanceUrl: `${SF.instanceUrl}/x?y=1`,
      extra: 1,
    });
    expect(s.ok && s.config).toEqual(SF);
    const w = normalizeConfig("webhook", { ...WH, extra: 1 });
    expect(w.ok && w.config).toEqual(WH);
  });

  test("rejects malformed input without echoing values", () => {
    const bad: [Parameters<typeof normalizeConfig>[0], unknown][] = [
      ["zendesk", { ...ZD, subdomain: "evil.com/" }],
      ["zendesk", { ...ZD, subdomain: "" }],
      ["zendesk", { ...ZD, email: "not-an-email" }],
      ["zendesk", { ...ZD, apiToken: "" }],
      ["zendesk", { ...ZD, groupId: "abc" }],
      ["salesforce", { ...SF, instanceUrl: "http://acme.my.salesforce.com" }],
      ["salesforce", { ...SF, clientSecret: "" }],
      ["webhook", { ...WH, url: "http://hooks.acme.io" }],
      ["webhook", { ...WH, secret: "short" }],
      ["webhook", null],
      ["webhook", []],
      ["webhook", "string"],
    ];
    for (const [provider, raw] of bad) {
      const r = normalizeConfig(provider, raw);
      expect(r.ok).toBe(false);
      if (!r.ok) for (const s of ALL_SECRETS) expect(r.error.includes(s)).toBe(false);
    }
  });

  test("validateConfig applies the SSRF guard to operator-typed URLs", async () => {
    expect((await validateConfig("webhook", WH, { resolver: PUBLIC_DNS })).ok).toBe(true);
    expect((await validateConfig("salesforce", SF, { resolver: PUBLIC_DNS })).ok).toBe(true);
    expect((await validateConfig("zendesk", ZD)).ok).toBe(true);
    for (const url of [
      "https://127.0.0.1/x",
      "https://169.254.169.254/",
      "https://localhost/x",
      "https://10.0.0.5/",
    ]) {
      expect((await validateConfig("webhook", { ...WH, url })).ok).toBe(false);
    }
    expect((await validateConfig("webhook", WH, { resolver: PRIVATE_DNS })).ok).toBe(false);
  });

  test("the masked summary never contains a usable secret", () => {
    for (const [provider, cfg] of [
      ["zendesk", ZD],
      ["salesforce", SF],
      ["webhook", WH],
    ] as const) {
      const masked = JSON.stringify(maskConfig(provider, cfg));
      for (const s of [ZD.apiToken, SF.clientSecret, WH.secret])
        expect(masked.includes(s)).toBe(false);
    }
    expect(maskConfig("webhook", WH).host).toBe("hooks.acme.io");
    expect(maskConfig("zendesk", ZD).subdomain).toBe("acme-bank");
    // a short secret reveals nothing at all
    expect(maskConfig("zendesk", { ...ZD, apiToken: "tiny" }).apiToken).toBe("••••••••");
  });

  test("the provider list is exactly zendesk, salesforce, webhook", () => {
    expect([...CRM_PROVIDERS]).toEqual(["zendesk", "salesforce", "webhook"]);
  });
});

describe("config encryption at rest", () => {
  test("round-trips and the ciphertext does not contain the secrets", () => {
    for (const cfg of [ZD, SF, WH]) {
      const plain = JSON.stringify(cfg);
      const enc = encryptSecret(plain);
      expect(decryptSecret(enc)).toBe(plain);
      expect(JSON.parse(decryptSecret(enc)!)).toEqual(cfg);
      for (const s of [ZD.apiToken, SF.clientSecret, WH.secret, "acme-bank", "hooks.acme.io"]) {
        expect(enc.includes(s)).toBe(false);
        // base64 of the plaintext fragment must not appear either
        expect(enc.includes(Buffer.from(s).toString("base64"))).toBe(false);
      }
    }
  });

  test("tampered ciphertext does not decrypt", () => {
    const enc = encryptSecret(JSON.stringify(WH));
    const [iv, tag, data] = enc.split(".");
    const flipped = Buffer.from(data!, "base64");
    flipped[0] = flipped[0]! ^ 0xff;
    expect(decryptSecret(`${iv}.${tag}.${flipped.toString("base64")}`)).toBeNull();
  });
});
