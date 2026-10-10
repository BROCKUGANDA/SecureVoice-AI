/**
 * GATE — the multi-step onboarding wizard: strict schemas, the columns each step
 * writes, and the secret contract.
 *
 * The properties that matter here are the ones an operator cannot see from the
 * UI, which is exactly why they need a test:
 *
 *   1. **Secrets never come back.** A wizard that can re-display a stored key
 *      turns an operator session into a credential-exfiltration target. The GET
 *      is asserted field-by-field against the set of things it is allowed to
 *      return.
 *   2. **Unknown fields are rejected, not dropped.** A misspelled field that is
 *      silently ignored is a wizard that reports "Saved." for a value it never
 *      stored — the most damaging lie this surface could tell.
 *   3. **Each step writes the columns it claims to.** Institution profile writes
 *      the ORGANIZATION *and* mirrors the display name onto the profile, because
 *      the console header reads it from there.
 *   4. **An empty secret field keeps the stored one.** The wizard never
 *      re-displays a secret, so "blank" must mean "leave it alone" — otherwise
 *      simply tabbing through the form deletes the operator's Twilio token.
 *   5. **The webhook test sends the REAL signed envelope**, and times out at 3s
 *      rather than hanging the wizard.
 *
 *   bun test tests/console/setup.test.ts
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { NextRequest } from "next/server";
import { createHash, createHmac } from "node:crypto";
import { db } from "@/lib/db";
import * as realCredits from "@/lib/credits";
import { encryptSecret } from "@/lib/byok";
import { WEBHOOK_SIGNATURE_HEADER } from "@/lib/outbox";

/**
 * `test` with this suite's timeout applied.
 *
 * Bun's default is 5 s per test. Every assertion here runs against a REMOTE
 * database (~300 ms per round trip) and, for the webhook test, a real DNS
 * resolution. Aborting correct work at 5 s would make the suite report failures
 * that do not exist, which is how a gate stops being believed.
 */
const TIMEOUT_MS = 60_000;
function slowTest(name: string, fn: () => Promise<void> | void) {
  test(name, fn, TIMEOUT_MS);
}

process.env.ELEVENLABS_DRY_RUN = "true";
process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "setup-gate-secret";
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "setup-gate-secret";

const ORG = `0e0e0e0e-0000-4000-8000-${createHash("sha256")
  .update("setup-a")
  .digest("hex")
  .slice(0, 12)}`;
const USER_ID = `00000000-0000-4000-8000-${createHash("sha256")
  .update("setup-user")
  .digest("hex")
  .slice(0, 12)}`;

const session = { orgId: ORG as string | null, signedIn: true };

mock.module("@/lib/credits", () => ({
  ...realCredits,
  getProfile: async () =>
    session.signedIn
      ? {
          userId: USER_ID,
          email: "setup@securevoice.ae",
          name: "Setup Gate",
          role: "operator" as const,
          orgId: session.orgId,
          credits: 500,
          walletScope: (session.orgId ? "org" : "user") as "org" | "user",
        }
      : null,
}));

const { GET: getSetupRoute, POST: postSetup } = await import("@/app/api/console/setup/route");
const { POST: testWebhook } = await import("@/app/api/console/webhooks/test/route");

/**
 * A PUBLIC https endpoint on the default permitted port.
 *
 * Deliberately not a loopback address: the SSRF validator refuses private and
 * loopback targets and only permits port 443, so a "localhost receiver" would be
 * rejected before delivery is attempted and the signature assertion would never
 * run. DNS resolution still happens (that IS the check); `fetch` is stubbed, so
 * nothing leaves the machine.
 */
const LOCAL_RECEIVER = "https://example.com/securevoice";

function jsonPost(url: string, body: unknown) {
  return new NextRequest(
    new Request(`http://localhost${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function readJson(res: Response) {
  return (await res.json().catch(() => ({}))) as Record<string, never> & {
    error?: string;
    ok?: boolean;
    step?: number;
    completed?: boolean;
    org?: Record<string, unknown>;
    telecom?: Record<string, unknown>;
    ai?: Record<string, unknown>;
    webhooks?: Record<string, unknown>;
    status?: number;
    ms?: number;
  };
}

const save = (step: number, data: Record<string, unknown>) =>
  postSetup(jsonPost("/api/console/setup", { action: "save", step, data }));

beforeAll(async () => {
  await db.organization.upsert({
    where: { id: ORG },
    create: {
      id: ORG,
      name: "Setup Gate Org",
      slug: `setup-gate-${ORG.slice(-6)}`,
      createdAt: new Date(),
    },
    update: {},
  });
  await db.user.upsert({
    where: { id: USER_ID },
    create: {
      id: USER_ID,
      email: `setup.${ORG.slice(-6)}@securevoice.ae`,
      name: "Setup Gate",
      emailVerified: true,
    },
    update: {},
  });
  await db.userProfile.upsert({
    where: { userId: USER_ID },
    create: { userId: USER_ID, email: `setup.${ORG.slice(-6)}@securevoice.ae`, name: "Setup Gate" },
    update: {},
  });
}, TIMEOUT_MS);

afterAll(async () => {
  await db.userProfile.deleteMany({ where: { userId: USER_ID } });
  await db.organization.deleteMany({ where: { id: ORG } });
  await db.user.deleteMany({ where: { id: USER_ID } });
  await db.$disconnect();
}, TIMEOUT_MS);

slowTest("setup: an anonymous caller is refused and a tenant-less caller is a 409", async () => {
  session.signedIn = false;
  expect((await getSetupRoute()).status).toBe(401);
  session.signedIn = true;

  session.orgId = null;
  try {
    expect((await getSetupRoute()).status).toBe(409);
    expect((await save(1, { orgName: "No Tenant Bank" })).status).toBe(409);
  } finally {
    session.orgId = ORG;
  }
});

slowTest("setup: an unknown field is rejected, never silently dropped", async () => {
  const res = await save(1, {
    orgName: "Strict Bank",
    orgLogoUrl: "",
    institutionType: "bank",
    region: "UAE",
    shariahCompliant: false,
    // A plausible typo. A non-strict schema would ignore it and answer "Saved."
    // for a value that was never stored.
    regionTypo: "UAE",
  });
  expect(res.status).toBe(422);
  const body = await readJson(res);
  expect(body.error).toBeTruthy();
});

slowTest(
  "setup: step 1 writes the organization AND mirrors the name the console header reads",
  async () => {
    const res = await save(1, {
      orgName: "Emirates National Bank — Fraud Ops",
      orgLogoUrl: "https://cdn.example.ae/logo.png",
      institutionType: "insurer",
      region: "GCC",
      shariahCompliant: true,
    });
    expect(res.status).toBe(200);
    expect((await readJson(res)).step).toBe(2);

    const org = await db.organization.findUniqueOrThrow({ where: { id: ORG } });
    expect(org.name).toBe("Emirates National Bank — Fraud Ops");
    expect(org.institutionType).toBe("insurer");
    expect(org.region).toBe("GCC");
    expect(org.shariahCompliant).toBe(true);
    // The header reads `orgName` off the PROFILE, so writing only the organization
    // would report success on a field the operator can see did not change.
    const profile = await db.userProfile.findUniqueOrThrow({ where: { userId: USER_ID } });
    expect(profile.orgName).toBe("Emirates National Bank — Fraud Ops");
    expect(org.setupStep).toBe(2);
  },
);

slowTest("setup: telecom validates E.164 and the sender id, and seals the auth token", async () => {
  const bad = await save(2, { twilioVoiceNumber: "0455501234", twilioSmsSenderId: "ENB" });
  expect(bad.status).toBe(422);
  expect((await readJson(bad)).error).toContain("E.164");

  const badSid = await save(2, {
    twilioVoiceNumber: "+97145550123",
    twilioSmsSenderId: "ENB",
    twilioMessagingServiceSid: "not-a-sid",
  });
  expect(badSid.status).toBe(422);

  const ok = await save(2, {
    twilioVoiceNumber: "+97145550123",
    twilioSmsSenderId: "ENB FRAUD",
    twilioMessagingServiceSid: "",
    twilioAuthToken: "twilio-auth-token-0123456789abcdef",
  });
  expect(ok.status).toBe(200);

  const org = await db.organization.findUniqueOrThrow({ where: { id: ORG } });
  expect(org.twilioVoiceNumber).toBe("+97145550123");
  expect(org.twilioSmsSenderId).toBe("ENB FRAUD");
  expect(org.twilioAuthTokenEnc).toBeTruthy();
  // Sealed at rest: the plaintext must not be recoverable from the column.
  expect(org.twilioAuthTokenEnc).not.toContain("twilio-auth-token");
});

slowTest("setup: a blank secret field KEEPS the stored secret instead of clearing it", async () => {
  const before = await db.organization.findUniqueOrThrow({
    where: { id: ORG },
    select: { twilioAuthTokenEnc: true },
  });
  // Step 2 again with the secret left empty — exactly what tabbing through the
  // form sends. Deleting the operator's token here would be silent data loss.
  const res = await save(2, {
    twilioVoiceNumber: "+97145550199",
    twilioSmsSenderId: "ENB FRAUD 2",
    twilioMessagingServiceSid: "",
    twilioAuthToken: "",
  });
  expect(res.status).toBe(200);
  const after = await db.organization.findUniqueOrThrow({
    where: { id: ORG },
    select: { twilioAuthTokenEnc: true, twilioVoiceNumber: true },
  });
  expect(after.twilioAuthTokenEnc).toBe(before.twilioAuthTokenEnc);
  expect(after.twilioVoiceNumber).toBe("+97145550199");
});

slowTest(
  "setup: BYOK keys are sealed onto the profile, and a base URL is stored in the clear",
  async () => {
    const res = await save(3, {
      elevenKey: "sk_live_NOT_A_REAL_KEY_000",
      llmKey: "sk-bank-gateway-key-abcdefghijkl",
      llmBaseUrl: "https://llm-gateway.example.ae/v1/",
    });
    expect(res.status).toBe(200);

    const profile = await db.userProfile.findUniqueOrThrow({ where: { userId: USER_ID } });
    expect(profile.elevenKeyEnc).toBeTruthy();
    expect(profile.elevenKeyEnc).not.toContain("sk_live_NOT_A_REAL_KEY_000");
    expect(profile.llmKeyEnc).toBeTruthy();
    expect(profile.llmKeyEnc).not.toContain("sk-bank-gateway-key");
    // The base URL is not a secret: an operator must be able to SEE where their key
    // is going.
    expect(profile.llmBaseUrl).toBe("https://llm-gateway.example.ae/v1/");
  },
);

slowTest("setup: the acknowledgement gate refuses to advance on step 4", async () => {
  const refused = await save(4, { pdplAcknowledged: false });
  expect(refused.status).toBe(422);
  const accepted = await save(4, { pdplAcknowledged: true });
  expect(accepted.status).toBe(200);
});

slowTest("setup: the webhook URL is SSRF-validated and the secret is sealed", async () => {
  const internal = await save(5, { vendorWebhookUrl: "http://169.254.169.254/latest/meta-data/" });
  expect(internal.status).toBe(422);
  expect((await readJson(internal)).error).toBeTruthy();

  const ok = await save(5, {
    vendorWebhookUrl: "https://example.com/securevoice",
    vendorWebhookSecret: "whsec_0123456789abcdef",
  });
  expect(ok.status).toBe(200);

  const org = await db.organization.findUniqueOrThrow({ where: { id: ORG } });
  expect(org.vendorWebhookUrl).toBe("https://example.com/securevoice");
  expect(org.vendorWebhookSecretEnc).toBeTruthy();
  expect(org.vendorWebhookSecretEnc).not.toContain("whsec_0123456789abcdef");
});

slowTest("setup: the GET never returns a secret — only masked forms and booleans", async () => {
  const body = await readJson(await getSetupRoute());
  expect(body.ok).toBe(true);
  expect(JSON.stringify(body)).not.toContain("sk_live_NOT_A_REAL_KEY_000");
  expect(JSON.stringify(body)).not.toContain("sk-bank-gateway-key-abcdefghijkl");
  expect(JSON.stringify(body)).not.toContain("twilio-auth-token-0123456789abcdef");
  expect(JSON.stringify(body)).not.toContain("whsec_0123456789abcdef");

  // The shape that IS allowed: a masked key and a "configured" flag.
  expect(typeof body.ai?.elevenKeyMasked).toBe("string");
  expect(String(body.ai?.elevenKeyMasked)).toContain("…");
  expect(body.telecom?.twilioAuthTokenConfigured).toBe(true);
  expect(body.webhooks?.vendorWebhookSecretConfigured).toBe(true);
  expect(body.webhooks).not.toHaveProperty("vendorWebhookSecret");
  expect(body.telecom).not.toHaveProperty("twilioAuthToken");
  expect(body.ai).not.toHaveProperty("llmKey");
});

slowTest(
  "setup: finish stamps completion, and finishing again keeps the original date",
  async () => {
    const first = await postSetup(jsonPost("/api/console/setup", { action: "finish" }));
    expect(first.status).toBe(200);
    const body = await readJson(first);
    expect(body.completed).toBe(true);
    const original = body.completedAt ?? String((await getSetupRoute()).status);
    expect(original).toBeTruthy();

    const stored = await db.organization.findUniqueOrThrow({
      where: { id: ORG },
      select: { setupCompletedAt: true },
    });
    expect(stored.setupCompletedAt).toBeInstanceOf(Date);

    await db.organization.update({ where: { id: ORG }, data: { setupStep: 1 } });
    await postSetup(jsonPost("/api/console/setup", { action: "finish" }));
    const again = await db.organization.findUniqueOrThrow({
      where: { id: ORG },
      select: { setupCompletedAt: true },
    });
    // Re-running setup must not erase when the institution was onboarded.
    expect(again.setupCompletedAt?.getTime()).toBe(stored.setupCompletedAt?.getTime());
  },
);

slowTest("setup: skip resets progress but does NOT claim the tenant is onboarded", async () => {
  const res = await postSetup(jsonPost("/api/console/setup", { action: "skip" }));
  expect(res.status).toBe(200);
  const org = await db.organization.findUniqueOrThrow({
    where: { id: ORG },
    select: { setupStep: true, setupCompletedAt: true },
  });
  // Skipped is not onboarded: conflating them would let the Command Center claim
  // an institution is configured when it is not.
  expect(org.setupStep).toBe(1);
  expect(org.setupCompletedAt).not.toBeNull(); // from the earlier finish — untouched by skip
});

slowTest("setup: an unknown action and an out-of-range step are refused", async () => {
  expect((await postSetup(jsonPost("/api/console/setup", { action: "obliterate" }))).status).toBe(
    422,
  );
  expect((await save(99, { orgName: "x" })).status).toBe(422);
  expect((await save(0, { orgName: "x" })).status).toBe(422);
});

slowTest(
  "webhooks: the test delivery signs the REAL envelope and honours its 3s budget",
  async () => {
    const secret = "whsec_0123456789abcdef";
    await db.organization.update({
      where: { id: ORG },
      data: {
        vendorWebhookUrl: LOCAL_RECEIVER,
        vendorWebhookSecretEnc: encryptSecret(secret),
      },
    });

    const originalFetch = globalThis.fetch;
    const seen: { body: string; sig: string | null }[] = [];
    let respondWith: () => Response = () => new Response("ok", { status: 200 });
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        body: String(init?.body ?? ""),
        sig: new Headers(init?.headers as HeadersInit).get(WEBHOOK_SIGNATURE_HEADER),
      });
      return respondWith();
    }) as typeof fetch;

    try {
      // Happy path: a 200 from the tenant's endpoint.
      const ok = await testWebhook(
        new NextRequest(
          new Request("http://localhost/api/console/webhooks/test", { method: "POST" }),
        ),
      );
      expect(ok.status).toBe(200);
      const okBody = await readJson(ok);
      expect(okBody.ok).toBe(true);
      expect(okBody.status).toBe(200);

      // The signature must be a real HMAC over `timestamp.body` — the same contract
      // the delivery worker uses, or the test proves nothing about production.
      const [sent] = seen;
      expect(sent).toBeDefined();
      const parts = Object.fromEntries(
        (sent!.sig ?? "").split(",").map((p) => p.trim().split("=")),
      );
      expect(parts.v1).toBeTruthy();
      const expected = createHmac("sha256", secret)
        .update(`${parts.t}.${sent!.body}`)
        .digest("hex");
      expect(parts.v1).toBe(expected);
      // No customer data rides along on a test delivery.
      expect(sent!.body).toContain("webhook_test");
      expect(sent!.body).not.toContain("elevenKey");

      // Failure path: a 401 from the bank is REPORTED, not thrown.
      respondWith = () => new Response("nope", { status: 401 });
      const denied = await testWebhook(
        new NextRequest(
          new Request("http://localhost/api/console/webhooks/test", { method: "POST" }),
        ),
      );
      const deniedBody = await readJson(denied);
      expect(deniedBody.ok).toBe(false);
      expect(deniedBody.status).toBe(401);
      expect(deniedBody.error).toContain("401");

      // Timeout path: a hanging endpoint must not hang the wizard.
      //
      // The stub honours `init.signal` — a promise that simply never settles would
      // never be released, because AbortSignal only reaches a fetch implementation
      // that LISTENS to it. Testing against a naive stub would prove nothing about
      // the timeout budget.
      respondWith = () => new Response("ok", { status: 200 });
      globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("The operation was aborted");
            err.name = "TimeoutError";
            reject(err);
          });
        })) as unknown as typeof fetch;
      const started = Date.now();
      const timedOut = await testWebhook(
        new NextRequest(
          new Request("http://localhost/api/console/webhooks/test", { method: "POST" }),
        ),
      );
      const elapsed = Date.now() - started;
      const timeoutBody = await readJson(timedOut);
      expect(timeoutBody.ok).toBe(false);
      expect(String(timeoutBody.error)).toContain("3000ms");
      // Generous ceiling: the budget is 3s, allow for scheduler noise in CI.
      expect(elapsed).toBeLessThan(15_000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

slowTest(
  "webhooks: an endpoint with no usable signing key is refused, not signed with the platform key",
  async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await db.organization.update({
        where: { id: ORG },
        data: { vendorWebhookUrl: "https://example.com/securevoice", vendorWebhookSecretEnc: null },
      });
      const res = await testWebhook(
        new NextRequest(
          new Request("http://localhost/api/console/webhooks/test", { method: "POST" }),
        ),
      );
      expect(res.status).toBe(422);
      // A payload signed with a key the bank never issued is either rejected or,
      // worse, believed — so no request is made at all.
      expect(called).toBe(false);
      expect((await readJson(res)).error).toContain("signing key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
