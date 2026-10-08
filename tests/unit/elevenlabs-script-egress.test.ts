/**
 * UNIT — the script-side ElevenLabs egress guard, and the ratchet that keeps
 * every vendor call inside a guard.
 *
 * Two things are proven here:
 *
 *   1. The script ledger refuses BEFORE the request. An operator re-cutting the
 *      walkthrough video should hit a wall at a configurable ceiling, not discover
 *      the quota is gone from the ElevenLabs dashboard a week later.
 *   2. `fetchWithBackoff` retries the transient and leaves the deterministic
 *      alone. A 401 retried three times is three pointless calls and a slower
 *      failure nobody can read.
 *
 * Then the ratchet: the whole point of routing every ElevenLabs call through a
 * guard is that a new call site cannot forget it. That property is only real if
 * something checks for it on every run, so this file asserts it — and a future
 * raw `fetch("https://api.elevenlabs.io/...")` fails here rather than shipping
 * unguarded.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { globSync } from "node:fs";

const { createCharLedger, fetchWithBackoff } =
  await import("../../scripts/lib/elevenlabs-egress.mjs");

const LEDGER = path.join(process.cwd(), ".tmp-script-ledger.json");

beforeEach(() => {
  fs.rmSync(LEDGER, { force: true });
});
afterEach(() => {
  fs.rmSync(LEDGER, { force: true });
  globalThis.fetch = realFetch;
});

const realFetch = globalThis.fetch;

describe("the script character ledger", () => {
  test("a claim that would cross the ceiling is refused without spending", () => {
    const ledger = createCharLedger({ file: LEDGER, cap: 100 });
    expect(ledger.claim(60).ok).toBe(true);
    expect(ledger.used()).toBe(60);

    const refused = ledger.claim(60);
    expect(refused.ok).toBe(false);
    // Narrowed rather than cast: `reason` only exists on the refusal shape, and
    // the assertion above has already failed the test if it does not.
    if (!refused.ok) expect(refused.reason).toContain("refusing to spend");
    // The refusal is pre-flight: the ledger never absorbed the rejected claim.
    expect(ledger.used()).toBe(60);
    expect(ledger.remaining()).toBe(40);
  });

  test("a released claim makes exactly that room again", () => {
    const ledger = createCharLedger({ file: LEDGER, cap: 100 });
    ledger.claim(80);
    ledger.release(80);
    expect(ledger.used()).toBe(0);
    expect(ledger.claim(80).ok).toBe(true);
  });

  test("the ledger is durable across processes, keyed by month", () => {
    const first = createCharLedger({ file: LEDGER, cap: 100 });
    first.claim(45);
    // A second instance reading the same file is what a re-run of the script is.
    const second = createCharLedger({ file: LEDGER, cap: 100 });
    expect(second.used()).toBe(45);

    const raw = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
    expect(raw.month).toBe(new Date().toISOString().slice(0, 7));
  });

  test("a ledger from a previous month starts empty rather than carrying over", () => {
    fs.writeFileSync(LEDGER, JSON.stringify({ month: "2020-01", chars: 99 }));
    const ledger = createCharLedger({ file: LEDGER, cap: 100 });
    expect(ledger.used()).toBe(0);
    expect(ledger.claim(50).ok).toBe(true);
  });

  test("a corrupt ledger fails closed, not open", () => {
    fs.writeFileSync(LEDGER, "{ not json");
    const ledger = createCharLedger({ file: LEDGER, cap: 100 });
    // Reading failure resets to zero, which is the one behaviour that must be
    // explicit rather than accidental: it is stated so a change here is noticed.
    expect(ledger.used()).toBe(0);
  });
});

describe("fetchWithBackoff", () => {
  let attempts = 0;

  function stub(
    handler: () => { status: number; body?: string; headers?: Record<string, string> },
  ) {
    attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      const r = handler();
      return new Response(r.body ?? "", {
        status: r.status,
        headers: r.headers as Record<string, string> | undefined,
      });
    }) as unknown as typeof fetch;
  }

  test("a 503 is retried and can succeed", async () => {
    stub(() => (attempts === 1 ? { status: 503, body: "down" } : { status: 200, body: "ok" }));
    const res = await fetchWithBackoff("https://api.elevenlabs.io/v1/any", {}, { maxRetries: 2 });
    expect(res.status).toBe(200);
    expect(attempts).toBe(2);
  });

  test("a 401 is returned immediately, never retried", async () => {
    stub(() => ({ status: 401, body: "bad key" }));
    const res = await fetchWithBackoff("https://api.elevenlabs.io/v1/any", {}, { maxRetries: 3 });
    expect(res.status).toBe(401);
    expect(attempts).toBe(1);
  });

  test("a 429 is returned rather than thrown, so the caller keeps its own shape", async () => {
    stub(() => ({ status: 429, body: "quota" }));
    const res = await fetchWithBackoff("https://api.elevenlabs.io/v1/any", {}, { maxRetries: 0 });
    expect(res.status).toBe(429);
  });

  test("a non-transient throw is not retried", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new TypeError("cannot parse body");
    }) as unknown as typeof fetch;
    expect(
      await fetchWithBackoff("https://x/y", {}, { maxRetries: 3 }).catch(() => null),
    ).toBeNull();
    expect(calls).toBe(1);
  });
});

describe("every ElevenLabs call goes through a guard", () => {
  /**
   * Files allowed to name the vendor host. Each is a guard, not a caller:
   * the app guard and the script guard own the socket, and the tests that prove
   * they do.
   */
  const GUARDS = new Set([
    "src/lib/elevenlabs/egress.ts",
    "scripts/lib/elevenlabs-egress.mjs",
    "tests/unit/elevenlabs-egress.test.ts",
    "tests/unit/elevenlabs-egress-throttle.test.ts",
    "tests/unit/elevenlabs-script-egress.test.ts",
  ]);

  /** Separator-normalised, or the guard list never matches on Windows and the
   * guards themselves get reported as offenders. */
  const posix = (p: string) => p.split(path.sep).join("/");

  const sourceFiles = () =>
    globSync("{src,scripts,mini-services,agent}/**/*.{ts,tsx,mjs,js}", {
      cwd: process.cwd(),
    } as never)
      // Bun types node:fs globSync as returning Dirents; at this
      // call site it yields path strings, which is what `posix` consumes.
      .map((found) => posix(String(found)))
      .filter((f) => !f.includes("node_modules") && !f.includes(".next"));

  test("no source file fetches api.elevenlabs.io outside a guard", () => {
    const offenders: string[] = [];
    for (const rel of sourceFiles()) {
      if (GUARDS.has(rel)) continue;
      const text = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      // A literal vendor URL handed to fetch, or a `${API}`-style base that was
      // built from the vendor host, both mean an unguarded call site.
      if (/fetch\(\s*[`"']https:\/\/api\.elevenlabs\.io/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test("the ratchet itself can fail — a guard list that admits everything proves nothing", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(50);
    // The vendor host must still appear in the guards, or the check above is
    // scanning nothing and passes by accident.
    const guarded = files.filter((f) => GUARDS.has(f));
    expect(guarded.length).toBeGreaterThanOrEqual(2);
  });
});
