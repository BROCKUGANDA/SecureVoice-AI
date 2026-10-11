import { afterEach, describe, expect, test } from "bun:test";
import { paddlePriceIds, paddlePricesConfigured } from "@/lib/paddle-browser";

/**
 * The price map is the one thing that must be true in BOTH environments and
 * wrong in neither. A sandbox `pri_` id does not exist in the live catalog, so a
 * bundled constant could only ever be correct somewhere. These tests pin the
 * parsing rules that make a per-environment value swap sufficient.
 */

const SANDBOX = JSON.stringify({
  usd_9900_month: "pri_01m4kc8amfsr590wkmf02v0q91",
  usd_99000_year: "pri_01m4kmzw3cq4na5tfn6xqd6ekn",
  usd_49900_month: "pri_01m4kc8bdy18z7h9g4qwbv6vqq",
  usd_499000_year: "pri_01m4kmzwg9vdfe2c4x5qnz2s4s",
  usd_200000_month: "pri_01m4kc8c6y167c8jx1pk7vcazx",
  usd_2000000_year: "pri_01m4kmzwwqy407sttdb550w8dt",
});

const save = process.env.NEXT_PUBLIC_PADDLE_PRICES;
afterEach(() => {
  if (save === undefined) delete process.env.NEXT_PUBLIC_PADDLE_PRICES;
  else process.env.NEXT_PUBLIC_PADDLE_PRICES = save;
});

describe("paddlePriceIds", () => {
  test("resolves every tier and BOTH intervals from a flat price map", () => {
    process.env.NEXT_PUBLIC_PADDLE_PRICES = SANDBOX;
    const ids = paddlePriceIds();
    expect(Object.keys(ids).sort()).toEqual(["enterprise", "growth", "starter"]);
    expect(ids.starter.month).toBe("pri_01m4kc8amfsr590wkmf02v0q91");
    expect(ids.starter.year).toBe("pri_01m4kmzw3cq4na5tfn6xqd6ekn");
    expect(ids.growth.month).toBe("pri_01m4kc8bdy18z7h9g4qwbv6vqq");
    expect(ids.enterprise.year).toBe("pri_01m4kmzwwqy407sttdb550w8dt");
  });

  test("the annual amount maps to the same tier as its monthly anchor", () => {
    // $99/mo -> $990/yr is a 10x key difference. Resolving `usd_99000_year`
    // against the MONTHLY table is the bug that would silently drop every
    // annual Buy button.
    process.env.NEXT_PUBLIC_PADDLE_PRICES = SANDBOX;
    const ids = paddlePriceIds();
    expect(ids.starter.year).not.toBe("");
    expect(ids.growth.year).not.toBe("");
    expect(ids.enterprise.year).not.toBe("");
  });

  test("a half-filled map is rejected rather than half-rendered", () => {
    // Only monthly ids present: the annual Buy button would be dead with no
    // error, which reads as a one-tier bug instead of a config error.
    process.env.NEXT_PUBLIC_PADDLE_PRICES = JSON.stringify({
      usd_9900_month: "pri_aaa1",
      usd_49900_month: "pri_bbb1",
      usd_200000_month: "pri_ccc1",
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
      usd_9900_month: "nope",
      usd_99000_year: "nope2",
      usd_49900_month: "nope3",
      usd_499000_year: "nope4",
      usd_200000_month: "nope5",
      usd_2000000_year: "nope6",
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