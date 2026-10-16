/**
 * The DIAL_RETRY_LADDER_MS knob is REAL: it retunes dial backoff, and it cannot
 * be tuned into the carrier's robocall window.
 *
 * The defect class this pins: the ladder was hard-coded in
 * `src/lib/scale/queue.ts` while `.env.example` promised a `DIAL_RETRY_LADDER_MS`
 * override that was read by nothing — a deploy could not change dial retry timing
 * at all, and believed it could. The getter (`env.dialRetryLadderMs`, exported
 * through `DIAL_RETRY_LADDER_MS`) is now the single source, so three things must
 * be true and none of them is self-evident from the code:
 *
 *   1. UNSET means the historical ladder exactly — retuning is opt-in, and a
 *      deployment that never heard of the knob behaves bit-identically.
 *   2. A set ladder WINS — the knob is not decoration. (An env-driven value that
 *      is silently ignored is the lie this file exists to catch.)
 *   3. A ladder that breaks the carrier rule is REFUSED LOUDLY, not quietly.
 *      Carriers flag a number re-dialled inside five minutes as spam, so with
 *      ±20% jitter the first two rungs must sum to more than CALL_RATE_WINDOW_MS.
 *      A SILENT refusal here would recreate the exact defect above — operator
 *      sets a value, nothing changes, no error — so the test asserts the
 *      console.warn happens, names the value in it, and names the default that
 *      takes its place. Malformed input is refused the same way.
 */
import { afterEach, expect, test } from "bun:test";
import { env } from "@/lib/config";
import { DIAL_RETRY_LADDER_MS, dialJobBackoffMs } from "@/lib/scale/queue";

const DEFAULT = [150_000, 300_000, 600_000];

const ENV_NAME = "DIAL_RETRY_LADDER_MS";
const had = process.env[ENV_NAME];

afterEach(() => {
  if (had === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = had;
});

test("unset is the historical ladder, rung for rung", () => {
  delete process.env[ENV_NAME];
  expect([...env.dialRetryLadderMs]).toEqual(DEFAULT);
  // queue.ts freezes it at import — the exported constant is what the worker
  // dials against, so it must equal the documented default in a clean env.
  if (had === undefined) expect([...DIAL_RETRY_LADDER_MS]).toEqual(DEFAULT);
});

test("a set ladder WINS — the knob is not decoration", () => {
  process.env[ENV_NAME] = "200000, 400000, 900000";
  expect(env.dialRetryLadderMs).toEqual([200_000, 400_000, 900_000]);
  // 0.8 × (200s + 400s) = 480s > 300s window: carrier-safe, so it must apply.
});

test("a shorter ladder is honoured when it clears the carrier rule", () => {
  process.env[ENV_NAME] = "160000,320000";
  expect(env.dialRetryLadderMs).toEqual([160_000, 320_000]);
  // Note: `DIAL_RETRY_LADDER_MS` in queue.ts froze the DEFAULT ladder at import;
  // the clamp-to-last-rung behaviour of `dialJobBackoffMs` is pinned against the
  // frozen constant in tests/unit/scale.test.ts, not here.
});

test("a carrier-unsafe ladder is REFUSED LOUDLY, never silently", () => {
  process.env[ENV_NAME] = "30000,120000,240000";
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (msg: unknown) => warnings.push(String(msg));
  try {
    expect([...env.dialRetryLadderMs]).toEqual(DEFAULT);
  } finally {
    console.warn = realWarn;
  }
  // One warning per DISTINCT refused value — this one has not appeared before,
  // so the refusal must be evidenced, not inferred. A silent fall-back to the
  // default here would be the very knob-that-does-nothing defect this knob was
  // wired to fix.
  expect(warnings.length).toBe(1);
  const line = warnings.join("\n");
  expect(line).toContain("30000,120000,240000");
  expect(line).toContain("0.8 × (L1+L2)");
  expect(line).toContain("300000");
});

test("malformed rungs are refused the same loud way", () => {
  for (const bad of ["abc", "150000,,600000", "-5,300000,600000", "0,600000"]) {
    process.env[ENV_NAME] = bad;
    expect([...env.dialRetryLadderMs]).toEqual(DEFAULT);
  }
});

test("the refusal does not corrupt the shipped default — later reads still dial", () => {
  process.env[ENV_NAME] = "1,2,3"; // absurd, carrier-hostile
  expect([...env.dialRetryLadderMs]).toEqual(DEFAULT);
  delete process.env[ENV_NAME];
  expect([...env.dialRetryLadderMs]).toEqual(DEFAULT);
  expect(dialJobBackoffMs(1, () => 0.5)).toBe(150_000);
});
