/**
 * GATE — `scripts/check-paddle-price-map.mjs`: the release refuses to publish
 * an image whose pricing page cannot take money.
 *
 * `NEXT_PUBLIC_*` is INLINED AT BUILD TIME, so the release image either has a
 * working price map compiled into its bundle or it does not. Measured on
 * 2026-10-21, on v0.2.49: all three Paddle build args were EMPTY (the
 * repository variables the build reads did not exist), so the published image
 * had a pricing page that rendered the rate card and offered no checkout —
 * while the branch build of the same commit, which reads the box's `.env`,
 * sold fine. Two artifacts, one commit, one of them useless.
 *
 * The rule this script enforces is the shape `src/lib/paddle-browser.ts`
 * accepts, because a map this script calls publishable is exactly a map
 * `paddlePriceIds()` will not throw on:
 *
 *   · it parses as JSON, and it is an object
 *   · every value is a Paddle price id (`pri_…`)
 *   · every key is `usd_<cents>_<month|year>`
 *   · every tier has BOTH intervals
 *
 * The last one is the one that bites: a half-filled map renders a working
 * monthly Buy button and a dead annual one, and `paddlePriceIds()` rejects the
 * WHOLE map rather than half of it — so a map missing one interval is not a
 * degraded pricing page, it is no pricing page at all.
 *
 * The script is run as a subprocess, because that is how the release runs it:
 * the exit code is the contract, not the return value.
 *
 *   bun test tests/unit/paddle-price-map-gate.test.ts
 */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/check-paddle-price-map.mjs", import.meta.url));

/** The real map, as the box's `.env` and the repository variable both hold it. */
const GOOD_PRICES = JSON.stringify({
  usd_250000_month: "pri_01m5e3p5mtatwpg7vadgyvm66m",
  usd_2500000_year: "pri_01m5e3p60n6p9nkz9v3qkp8km4",
  usd_900000_month: "pri_01m5e3p6qxeegheceqgth9nn7w",
  usd_9000000_year: "pri_01m5e3p73tw5nqva9s096ryf3j",
  usd_2500000_month: "pri_01m5e3p8j9xdpbss7j45apj7nc",
  usd_25000000_year: "pri_01m5e3p8xvera1vbmsed9m9xw6",
});

function run(env: Record<string, string | undefined>) {
  const child = Bun.spawnSync({
    cmd: [process.execPath, SCRIPT],
    env: {
      PATH: process.env.PATH ?? "",
      NEXT_PUBLIC_PADDLE_PRICES: env.NEXT_PUBLIC_PADDLE_PRICES ?? "",
      NEXT_PUBLIC_PADDLE_ENVIRONMENT: env.NEXT_PUBLIC_PADDLE_ENVIRONMENT ?? "",
      NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: child.exitCode,
    out: child.stdout.toString(),
    err: child.stderr.toString(),
  };
}

describe("the release price-map gate", () => {
  test("passes the map the box and the repository variable both hold", () => {
    const r = run({
      NEXT_PUBLIC_PADDLE_PRICES: GOOD_PRICES,
      NEXT_PUBLIC_PADDLE_ENVIRONMENT: "sandbox",
      NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_8055a2ad0d57cc58f2aabf06680",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("every tier has both intervals");
  });

  test("fails when the map is missing entirely", () => {
    // This is the v0.2.49 case: the repository variables did not exist, so the
    // build args were empty and the published image could not sell.
    const r = run({
      NEXT_PUBLIC_PADDLE_PRICES: "",
      NEXT_PUBLIC_PADDLE_ENVIRONMENT: "sandbox",
      NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_8055a2ad0d57cc58f2aabf06680",
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("NEXT_PUBLIC_PADDLE_PRICES is empty");
  });

  test("fails when the map has had its quotes stripped", () => {
    // A map that is PRESENT and is not JSON is the quietest way to ship a dead
    // pricing page: it looks configured, and every key is a name.
    const r = run({
      NEXT_PUBLIC_PADDLE_PRICES: "{usd_250000_month:pri_a,usd_2500000_year:pri_b}",
      NEXT_PUBLIC_PADDLE_ENVIRONMENT: "sandbox",
      NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_8055a2ad0d57cc58f2aabf06680",
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("not JSON");
  });

  test("fails when one tier has no annual price", () => {
    // The half-filled map: the monthly Buy button works, the annual one does
    // not, and `paddlePriceIds()` throws on the whole map — so the page renders
    // with no checkout at all.
    const r = run({
      NEXT_PUBLIC_PADDLE_PRICES: JSON.stringify({
        usd_250000_month: "pri_01m5e3p5mtatwpg7vadgyvm66m",
        usd_900000_month: "pri_01m5e3p6qxeegheceqgth9nn7w",
      }),
      NEXT_PUBLIC_PADDLE_ENVIRONMENT: "sandbox",
      NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_8055a2ad0d57cc58f2aabf06680",
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("a tier needs both intervals");
  });

  test("fails when the environment is not one of the two Paddle environments", () => {
    // A typo here is a checkout that opens against the wrong account.
    const r = run({
      NEXT_PUBLIC_PADDLE_PRICES: GOOD_PRICES,
      NEXT_PUBLIC_PADDLE_ENVIRONMENT: "sandbxo",
      NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "test_8055a2ad0d57cc58f2aabf06680",
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("sandbox or production");
  });

  test("fails when the client token is missing", () => {
    // Without it `paddleToken()` throws at runtime, and the Buy button is a
    // button that opens nothing.
    const r = run({
      NEXT_PUBLIC_PADDLE_PRICES: GOOD_PRICES,
      NEXT_PUBLIC_PADDLE_ENVIRONMENT: "sandbox",
      NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "",
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is empty");
  });
});
