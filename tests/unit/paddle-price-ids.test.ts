import { afterEach, describe, expect, test } from "bun:test";
import { paddlePriceIds, paddlePricesConfigured } from "@/lib/paddle-browser";

/**
 * The price map is the one thing that must be true in BOTH environments and
 * wrong in neither. A sandbox `pri_` id does not exist in the live catalog, so a
 * bundled constant could only ever be correct somewhere. These tests pin the
 * parsing rules that make a per-environment value swap sufficient.
 */

const SANDBOX = JSON.stringify({
  usd_250000_month: "pri_01m4kc8amfsr590wkmf02v0q91",
  usd_2500000_year: "pri_01m4kmzw3cq4na5tfn6xqd6ekn",
  usd_900000_month: "pri_01m4kc8bdy18z7h9g4qwbv6vqq",
  usd_9000000_year: "pri_01m4kmzwg9vdfe2c4x5qnz2s4s",
  usd_2500000_month: "pri_01m4kc8c6y167c8jx1pk7vcazx",
  usd_25000000_year: "pri_01m4kmzwwqy407sttdb550w8dt",
});

const save = process.env.NEXT_PUBLIC_PADDLE_PRICES;
afterEach(() => {
  if (save === undefined) delete process.env.NEXT_PUBLIC_PADDLE_PRICES;
  else process.env.NEXT_PUBLIC_PADDLE_PRICES = save;
});

/**
 * The tiers the sandbox map must resolve. `paddlePriceIds` returns an
 * index-signature record, so each lookup is `PriceTier | undefined` to the
 * compiler; a map that dropped a tier would make the assertions below vacuous,
 * so missing tiers are a hard failure here.
 *
 * The interval is part of the key, and it has to be: Starter's annual price is
 * $2,500 x 10 = $25,000, and Enterprise's monthly price is $25,000, so
 * `usd_2500000` alone names two different prices. `usd_2500000_month` is
 * Enterprise and `usd_2500000_year` is Starter.
 */
function resolvedIds() {
  const ids = paddlePriceIds();
  const { starter, growth, enterprise } = ids;
  if (starter === undefined || growth === undefined || enterprise === undefined) {
    throw new Error(
      `the fixture map must resolve all three tiers, got: ${Object.keys(ids).sort().join(", ")}`,
    );
  }
  return { ids, starter, growth, enterprise };
}

describe("paddlePriceIds", () => {
  test("resolves every tier and BOTH intervals from a flat price map", () => {
    process.env.NEXT_PUBLIC_PADDLE_PRICES = SANDBOX;
    const { ids, starter, growth, enterprise } = resolvedIds();
    expect(Object.keys(ids).sort()).toEqual(["enterprise", "growth", "starter"]);
    expect(starter.month).toBe("pri_01m4kc8amfsr590wkmf02v0q91");
    expect(starter.year).toBe("pri_01m4kmzw3cq4na5tfn6xqd6ekn");
    expect(growth.month).toBe("pri_01m4kc8bdy18z7h9g4qwbv6vqq");
    expect(enterprise.year).toBe("pri_01m4kmzwwqy407sttdb550w8dt");
  });

  test("the annual amount maps to the same tier as its monthly anchor", () => {
    // $2,500/mo -> $25,000/yr is a 10x key difference. Resolving `usd_2500000_year`
    // against the MONTHLY table is the bug that would silently drop every
    // annual Buy button.
    process.env.NEXT_PUBLIC_PADDLE_PRICES = SANDBOX;
    const { starter, growth, enterprise } = resolvedIds();
    expect(starter.year).not.toBe("");
    expect(growth.year).not.toBe("");
    expect(enterprise.year).not.toBe("");
  });

  test("a half-filled map is rejected rather than half-rendered", () => {
    // Only monthly ids present: the annual Buy button would be dead with no
    // error, which reads as a one-tier bug instead of a config error.
    process.env.NEXT_PUBLIC_PADDLE_PRICES = JSON.stringify({
      usd_250000_month: "pri_aaa1",
      usd_900000_month: "pri_bbb1",
      usd_2500000_month: "pri_ccc1",
    });
    expect(paddlePricesConfigured()).toBe(false);
    expect(() => paddlePriceIds()).toThrow(/NEXT_PUBLIC_PADDLE_PRICES/);
  });

  test("unset, malformed, non-JSON and non-pri values all refuse loudly", () => {
    delete process.env.NEXT_PUBLIC_PADDLE_PRICES;
    expect(() => paddlePriceIds()).toThrow(/NEXT_PUBLIC_PADDLE_PRICES/);

    process.env.NEXT_PUBLIC_PADDLE_PRICES = "not json";
    expect(() => paddlePriceIds()).toThrow();

    process.env.NEXT_PUBLIC_PADDLE_PRICES = JSON.stringify(["a", "b"]);
    expect(() => paddlePriceIds()).toThrow();

    // A sandbox-shaped map with a non-`pri_` value must not be accepted.
    process.env.NEXT_PUBLIC_PADDLE_PRICES = JSON.stringify({
      usd_250000_month: "nope",
      usd_2500000_year: "nope2",
      usd_900000_month: "nope3",
      usd_9000000_year: "nope4",
      usd_2500000_month: "nope5",
      usd_25000000_year: "nope6",
    });
    expect(paddlePricesConfigured()).toBe(false);
  });

  test("the error names the live hazard, not just the variable", () => {
    delete process.env.NEXT_PUBLIC_PADDLE_PRICES;
    try {
      paddlePriceIds();
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as Error).message).toMatch(/sandbox price ids do not exist/i);
    }
  });
});
