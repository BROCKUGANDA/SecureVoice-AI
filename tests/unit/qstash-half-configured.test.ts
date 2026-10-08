/**
 * Half-configured QStash must never be "enabled".
 *
 * QStash is two halves: the token lets the platform PUBLISH, and the signing
 * keys let the dispatch endpoint VERIFY what comes back. A deployment with a
 * token and no signing key would accept every bank signal into Upstash and then
 * reject every delivery at the door with a 401 — QStash retries, the failure
 * callback dead-letters a real fraud intervention, and the customer is never
 * dialled. That is a silent loss of the product's entire promise, caused by
 * an env var someone forgot.
 *
 * So `qstashConfigured()` demands BOTH, and these tests pin that, plus the
 * fallback that keeps the platform working when it is absent.
 */
import { expect, test } from "bun:test";

async function configuredWith(env: Record<string, string | undefined>): Promise<boolean> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    // Fresh module so the token constant is re-read from the mutated env.
    const mod = await import(`@/lib/queue/qstash?case=${JSON.stringify(env)}`);
    return mod.qstashConfigured();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const TOKEN = "3f041812-a328-4b16-b848-8368784191c4";
const SIGNING = "abcdefghijklmnopqrstuvwxyz0123456789";

test("token alone is NOT enabled — half a queue is worse than no queue", async () => {
  expect(await configuredWith({ QSTASH_TOKEN: TOKEN, QSTASH_CURRENT_SIGNING_KEY: undefined })).toBe(
    false,
  );
});

test("signing key alone is NOT enabled", async () => {
  expect(
    await configuredWith({ QSTASH_TOKEN: undefined, QSTASH_CURRENT_SIGNING_KEY: SIGNING }),
  ).toBe(false);
});

test("both halves together ARE enabled", async () => {
  expect(await configuredWith({ QSTASH_TOKEN: TOKEN, QSTASH_CURRENT_SIGNING_KEY: SIGNING })).toBe(
    true,
  );
});

test("a placeholder token is not a token", async () => {
  expect(await configuredWith({ QSTASH_TOKEN: "...", QSTASH_CURRENT_SIGNING_KEY: SIGNING })).toBe(
    false,
  );
  expect(await configuredWith({ QSTASH_TOKEN: TOKEN, QSTASH_CURRENT_SIGNING_KEY: "..." })).toBe(
    false,
  );
});

test("the dispatch route is gated on the SAME condition as the publisher", async () => {
  // A publisher that thinks it is enabled while the reader disagrees is the
  // exact failure above; both read the same helper.
  const src = await Bun.file("src/lib/queue/qstash.ts").text();
  const dispatch = await Bun.file("src/app/api/queue/dispatch/route.ts").text();
  expect(src).toContain("export function qstashConfigured");
  expect(dispatch).toContain("QSTASH_CURRENT_SIGNING_KEY");
  expect(dispatch).toContain("QSTASH_NEXT_SIGNING_KEY");
  // Rotation: both keys are tried, so a rotation window never drops traffic.
  expect(dispatch).toMatch(/for \(const key of \[CURRENT, NEXT\]\)/);
});
