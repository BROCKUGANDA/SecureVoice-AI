/**
 * UNIT — the spoken-money rules reached the real prompt.
 *
 * These lines used to live in src/lib/agent-prompts.ts, an institution-aware
 * prompt builder that no code path ever called — so "a 0.00 authorization hold is
 * 'a pre-authorization hold', never 'zero Dirhams'" was written down, carefully,
 * in a file with an import count of zero. The rules now sit in `SPOKEN_MONEY_RULES`
 * and are spread into the system prompt the real drafter sends
 * (src/lib/llm.ts, `draftAgentReply`).
 *
 * The assertions are about content, not wording: the zero-amount case must name
 * the pre-authorization hold, symbols must be banned, and exchange-rate guessing
 * must be refused with the banking-app redirect. Wording can change; those three
 * properties are the reason the rules exist.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SPOKEN_MONEY_RULES } from "@/lib/llm";

describe("SPOKEN_MONEY_RULES", () => {
  test("a zero amount is a pre-authorization hold, never zero currency", () => {
    const zero = SPOKEN_MONEY_RULES.find((r) => /zero/i.test(r));
    expect(zero).toBeDefined();
    expect(zero!).toContain("PRE-AUTHORIZATION HOLD");
    expect(zero!).toContain("never");
  });

  test("currency symbols are banned in spoken output", () => {
    const symbols = SPOKEN_MONEY_RULES.find((r) => /symbol/i.test(r));
    expect(symbols).toBeDefined();
    expect(symbols!).toContain("never");
  });

  test("exchange-rate guessing is refused, with the redirect the refusal text uses", () => {
    const rates = SPOKEN_MONEY_RULES.find((r) => /exchange rate/i.test(r));
    expect(rates).toBeDefined();
    expect(rates!).toContain("banking app");
  });

  test("the rules are in the prompt the drafter actually sends", () => {
    // Direct check that the constant is not just exported but consumed: the
    // system array spreads it. A rule that exists in a named export and never
    // reaches the model is the same unwired guard this file was extracted from.
    const source = readFileSync(join("src", "lib", "llm.ts"), "utf8");
    expect(source).toContain("...SPOKEN_MONEY_RULES");
  });
});
