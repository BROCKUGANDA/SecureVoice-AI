import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { backoffMs, maxAttempts } from "@/lib/email/outbox";

/**
 * The email worker's retry ladder.
 *
 * The worker is what makes the durable queue worth having: without it a Resend
 * outage costs an analyst their sign-in link into a fraud console. The
 * behaviour that matters is NOT "does it send" (the provider's job) but:
 *
 *   · a failed send is RETRIED rather than lost;
 *   · it is retried a BOUNDED number of times, then marked DEAD;
 *   · backoff is capped so a poisoned row cannot pin the queue;
 *   · two workers cannot both send the same message.
 *
 * ## Why these are source-level rather than DB-backed
 *
 * `drainEmailOutbox` claims rows with a raw `$queryRaw` FOR UPDATE SKIP LOCKED
 * statement, so exercising the full path needs a live Postgres. Two of these
 * properties are therefore asserted against the SOURCE (the claim SQL and the
 * retry decision are the parts most likely to be broken by an innocuous edit,
 * and neither is visible from a green integration run), while the arithmetic
 * below is exercised directly as real code.
 *
 * `deliverEmail` takes its sender by injection — that seam is the whole reason
 * a provider key is never needed to reason about the ladder.
 */

const WORKER = "scripts/email-worker.ts";
const OUTBOX_MODULE = "src/lib/email/outbox.ts";
const QUEUE_MODULE = "src/lib/email/queue.ts";

const read = (path: string) => readFileSync(path, "utf8");

describe("email worker — retry arithmetic", () => {
  test("the ladder is bounded", () => {
    // A row that will never succeed must reach DEAD in bounded time, or the
    // queue grows without limit during a provider outage.
    expect(maxAttempts()).toBeGreaterThan(0);
    expect(maxAttempts()).toBeLessThanOrEqual(10);
  });

  test("backoff is exponential but capped", () => {
    // Attempt 30 must not be a multi-day wait.
    expect(backoffMs(30)).toBeLessThanOrEqual(15 * 60_000);
    expect(backoffMs(30)).toBeGreaterThan(0);
  });

  test("backoff grows with attempt number", () => {
    // Fixed rand() so this is deterministic; the jitter range is checked apart.
    expect(backoffMs(1, 0.5)).toBeLessThan(backoffMs(6, 0.5));
  });

  test("backoff is jittered so workers do not retry in lockstep", () => {
    // Without jitter every queued message retries on the same schedule during a
    // provider outage and re-creates the burst that caused the rate limit.
    const low = backoffMs(5, 0);
    const high = backoffMs(5, 0.99);
    expect(high).toBeGreaterThan(low);
  });

  test("backoff never returns zero", () => {
    // A zero delay would become a hot spin loop against a failing provider.
    for (let attempt = 0; attempt < 12; attempt++) {
      expect(backoffMs(attempt, 0)).toBeGreaterThan(0);
    }
  });
});

describe("email worker — source invariants", () => {
  test("claims with SKIP LOCKED plus a compare-and-set re-assert", () => {
    const src = read(OUTBOX_MODULE);
    // SKIP LOCKED alone is NOT a claim across two statements: two workers can
    // both select the same id and both send a SINGLE-USE credential. One
    // operator would get a link that no longer works.
    expect(src).toContain("FOR UPDATE SKIP LOCKED");
    expect(src).toContain("RETURNING");
    expect(src).toMatch(/AND \(\s*\(e\.state = 'PENDING'/);
  });

  test("a failure leaves the row PENDING for another attempt", () => {
    const src = read(OUTBOX_MODULE);
    // The retry branch must reset state to PENDING, not leave it SENDING (which
    // would strand the row until the lease sweep) or DEAD (which would lose it).
    expect(src).toMatch(/state: "PENDING", attempts: attempt/);
  });

  test("exhausting the ladder marks DEAD", () => {
    const src = read(OUTBOX_MODULE);
    expect(src).toContain("attempt >= maxAttempts()");
    expect(src).toContain('state: "DEAD"');
  });

  test("a DEAD email is NOT written to the bank DeadLetter table", () => {
    const src = read(OUTBOX_MODULE);
    // DeadLetter's admin replay re-signs and re-POSTs a canonical-JSON body to
    // a BANK url. Replaying a sign-in link through it would attempt to deliver
    // a live credential to a bank's webhook endpoint.
    expect(src).not.toMatch(/db\.deadLetter\.create/);
  });

  test("the queued payload never carries the token", () => {
    const queue = read(QUEUE_MODULE);
    // A queued row outlives the token's TTL; a stored token is a live credential.
    expect(queue).toContain("delete (persistable as Record<string, unknown>).token");
    // And the row is written BEFORE the provider send, so a crash between mint
    // and send cannot drop the message.
    expect(queue.indexOf("await enqueueEmail(")).toBeLessThan(queue.indexOf("await sendQueuedEmail("));
  });

  test("the worker never prints a token", () => {
    const src = read(WORKER);
    expect(src).not.toContain("console.log(payload");
    expect(src).not.toContain("console.log(row.payload");
  });

  test("the sender is injected, so no provider key is needed to test", () => {
    // This seam is what keeps the ladder testable without a live network.
    const src = read(OUTBOX_MODULE);
    expect(src).toMatch(/sendRaw:\s*\(/);
  });
});

describe("email worker — deployment", () => {
  test("runs as a compose service wired into deploy", () => {
    // Without a running worker the queue is decorative: rows sit PENDING
    // forever and a Resend outage silently costs sign-in links.
    const compose = read("docker-compose.yml");
    expect(compose).toContain("email-worker:");
    expect(compose).toContain("scripts/email-worker.ts");
    const deploy = read(".github/workflows/deploy.yml");
    expect(deploy).toContain("email-worker");
  });

  test("boots without a provider key rather than crash-looping", () => {
    // A deployment that has not configured email yet must still start cleanly.
    const compose = read("docker-compose.yml");
    expect(compose).toMatch(/RESEND_API_KEY: \$\{RESEND_API_KEY:-\}/);
  });
});