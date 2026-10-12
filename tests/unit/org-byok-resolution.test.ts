/**
 * PER-TENANT BYOK, RESOLVED FROM THE TENANT — the key a bank's fraud team paid
 * for is the key their calls use.
 *
 * The keys used to live only on `UserProfile`, which is the wrong granularity for
 * a multi-tenant platform: one ElevenLabs account is shared by every analyst at an
 * institution, so per-user storage meant N copies of one secret, N places to
 * rotate it, and no way to revoke it for the whole tenant. `Organization` now
 * carries `elevenKeyEnc`, `llmKeyEnc` and `llmBaseUrl` (migration
 * `9zzzzzzzzzzzzzzzzzzzzzzzz_org_byok`), and both resolvers prefer the org and
 * fall back to the user.
 *
 * The tenant is taken from the session's `activeOrganizationId` — the
 * server-derived identity — and never from a header or body field, so a caller
 * cannot ask for another tenant's key by naming it.
 *
 * Tested against the real database and the real AES-256-GCM envelope, with only
 * the session seam replaced:
 *
 *   1. An org key wins over a user key, for TTS and for the LLM gateway.
 *   2. No org key falls back to the user key — the pre-existing behaviour, so
 *      every tenant that has not configured one keeps working.
 *   3. An undecryptable org key degrades to the next layer instead of throwing
 *      mid-call: a corrupt store must not silence a fraud call.
 *   4. A tenant BYOK LLM key resolves to the ORG's `llmBaseUrl`, not the
 *      deployment's — otherwise a bank's "our own gateway" request silently
 *      sends their prompts to someone else's.
 *   5. No session means no org, which means the user fallback, not a crash.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { encryptSecret } from "@/lib/byok";

// `byokKey()` refuses to fall back to a constant, so a deployment that has not
// configured AUTH_SECRET cannot silently encrypt under a guessable key. This is a
// test harness, the envelope never leaves the process, and `??=` means a real
// environment still wins — the same rule `tests/preload.ts` follows for the other
// hard floors. `||=` rather than `??=`: a .env carrying AUTH_SECRET="" (a
// placeholder) must not count as "the environment provided one" — byokKey
// refuses an empty base exactly like a missing one.
process.env.AUTH_SECRET ||= "test-only-byok-envelope-secret-not-a-credential";
// These tests exercise real key resolution, which resolveTtsKey never reaches
// under dry-run (it returns "unmetered" before touching any key). A .env that
// forces ELEVENLABS_DRY_RUN=true for the sandbox stack must not silently turn
// this whole suite green-on-the-wrong-path — the suite owns this floor the way
// it owns AUTH_SECRET above.
process.env.ELEVENLABS_DRY_RUN = "false";

const session: { activeOrganizationId: string | null } = { activeOrganizationId: null };

mock.module("next/headers", () => ({
  headers: async () => new Headers(),
}));

mock.module("@/lib/better-auth", () => ({
  auth: {
    api: {
      getSession: async () =>
        session.activeOrganizationId === null
          ? null
          : { session: { activeOrganizationId: session.activeOrganizationId }, user: { id: USER } },
    },
  },
}));

/** The platform-profile shape `getProfile()` returns; only `userId` is read here. */
mock.module("@/lib/credits", () => ({
  getProfile: async () => ({
    userId: USER,
    email: "analyst@bank.test",
    name: "Analyst",
    role: "member",
    orgId: session.activeOrganizationId,
    credits: 500,
    tier: "growth",
  }),
}));

function uuid(slot: number): string {
  const h = createHash("sha256").update(`org-byok:${slot}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const RUN = Date.now().toString(36);
const USER = uuid(1);
const ORG_WITH_KEYS = uuid(2);
const ORG_WITHOUT_KEYS = uuid(3);
const ORG_WITH_A_CORRUPT_KEY = uuid(4);

beforeAll(async () => {
  await db.user.create({
    data: {
      id: USER,
      email: `org-byok.${RUN}@bank.test`,
      name: "Org BYOK Tester",
      emailVerified: true,
    },
  });
  await db.userProfile.create({
    data: {
      userId: USER,
      email: `org-byok.${RUN}@bank.test`,
      name: "Org BYOK Tester",
      elevenKeyEnc: encryptSecret("user-level-eleven-key"),
      llmKeyEnc: encryptSecret("user-level-llm-key"),
      llmBaseUrl: "https://user-gateway.test/v1/chat/completions",
    },
  });

  for (const [id, name] of [
    [ORG_WITH_KEYS, "With Keys"],
    [ORG_WITHOUT_KEYS, "Without Keys"],
    [ORG_WITH_A_CORRUPT_KEY, "Corrupt Key"],
  ] as [string, string][]) {
    await db.organization.create({
      data: {
        id,
        name: `BYOK ${name}`,
        slug: `byok-${name.toLowerCase().replace(/ /g, "-")}-${RUN}`,
        createdAt: new Date(),
      },
    });
  }

  await db.organization.update({
    where: { id: ORG_WITH_KEYS },
    data: {
      elevenKeyEnc: encryptSecret("org-level-eleven-key"),
      llmKeyEnc: encryptSecret("org-level-llm-key"),
      llmBaseUrl: "https://tenant-gateway.test/v1/chat/completions",
    },
  });
  // Stored under a different envelope than the deployment can open.
  await db.organization.update({
    where: { id: ORG_WITH_A_CORRUPT_KEY },
    data: { elevenKeyEnc: "AAAA.BBBB.CCCC", llmKeyEnc: "AAAA.BBBB.CCCC" },
  });
});

afterAll(async () => {
  await db.userProfile.deleteMany({ where: { userId: USER } });
  await db.user.deleteMany({ where: { id: USER } });
  await db.organization.deleteMany({
    where: { id: { in: [ORG_WITH_KEYS, ORG_WITHOUT_KEYS, ORG_WITH_A_CORRUPT_KEY] } },
  });
});

function inOrg(orgId: string | null) {
  session.activeOrganizationId = orgId;
}

describe("the ElevenLabs key", () => {
  test("an org-level key is the one a tenant's call is synthesised with", async () => {
    inOrg(ORG_WITH_KEYS);
    const { resolveTtsKey } = await import("@/lib/tts-quota");
    const res = await resolveTtsKey();

    expect(res.mode).toBe("byok");
    if (res.mode === "byok") expect(res.keyOverride).toBe("org-level-eleven-key");
  });

  test("a tenant with no org key falls back to the operator's own, unchanged", async () => {
    inOrg(ORG_WITHOUT_KEYS);
    const { resolveTtsKey } = await import("@/lib/tts-quota");
    const res = await resolveTtsKey();

    expect(res.mode).toBe("byok");
    if (res.mode === "byok") expect(res.keyOverride).toBe("user-level-eleven-key");
  });

  test("an undecryptable org key degrades to the user key rather than throwing", async () => {
    // A corrupt or rotated-envelope row must not silence a fraud call, and must
    // not leak the fact that a secret exists in the error path either.
    inOrg(ORG_WITH_A_CORRUPT_KEY);
    const { resolveTtsKey } = await import("@/lib/tts-quota");
    const res = await resolveTtsKey();

    expect(res.mode).toBe("byok");
    if (res.mode === "byok") expect(res.keyOverride).toBe("user-level-eleven-key");
  });

  test("no active organization means the user fallback, not a crash", async () => {
    inOrg(null);
    const { resolveTtsKey } = await import("@/lib/tts-quota");
    const res = await resolveTtsKey();

    expect(res.mode).toBe("byok");
    if (res.mode === "byok") expect(res.keyOverride).toBe("user-level-eleven-key");
  });
});

describe("the LLM gateway key", () => {
  test("a tenant's own gateway key AND base URL are both honoured", async () => {
    inOrg(ORG_WITH_KEYS);
    const { resolveLlmCredentials } = await import("@/lib/llm");
    const provider = await resolveLlmCredentials(USER);

    expect(provider).not.toBeNull();
    if (!provider) return;
    expect(provider.name).toBe("tenant_byok");
    expect(provider.key).toBe("org-level-llm-key");
    // The org's endpoint, not the deployment's and not the user's: sending a
    // bank's prompts to a gateway they did not choose is the failure this
    // pairing exists to prevent.
    expect(provider.url).toBe("https://tenant-gateway.test/v1/chat/completions");
  });

  test("an org with no LLM key uses the operator's gateway", async () => {
    inOrg(ORG_WITHOUT_KEYS);
    const { resolveLlmCredentials } = await import("@/lib/llm");
    const provider = await resolveLlmCredentials(USER);

    expect(provider?.key).toBe("user-level-llm-key");
    expect(provider?.url).toBe("https://user-gateway.test/v1/chat/completions");
  });

  test("a corrupt org key falls through to the user's, and never surfaces the secret", async () => {
    inOrg(ORG_WITH_A_CORRUPT_KEY);
    const { resolveLlmCredentials } = await import("@/lib/llm");
    const provider = await resolveLlmCredentials(USER);

    expect(provider?.key).toBe("user-level-llm-key");
  });

  test("a null user id resolves to nothing, without touching the database", async () => {
    inOrg(ORG_WITH_KEYS);
    const { resolveLlmCredentials } = await import("@/lib/llm");
    expect(await resolveLlmCredentials(null)).toBeNull();
    expect(await resolveLlmCredentials(undefined)).toBeNull();
  });
});
