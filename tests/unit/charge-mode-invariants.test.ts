/**
 * The charge rule has no behaviour test yet — and this file is NOT a substitute for
 * one. It is the gate that makes the rule hard to break silently while that test is
 * still blocked on a database.
 *
 * WHY THIS EXISTS. `src/lib/billing/charge-mode.ts` implements the owner's rule: a
 * demo run is never billed (the cost is ours), a paid tenant's runs are, and the
 * plan's published `includedPerMonth` is what is free. Before it, `deductCredit()`
 * debited a mutable wallet for EVERY session including the demo one, and
 * `src/app/api/console/fire/route.ts` called it — so "the demo is free" was a
 * sentence on the pricing page rather than a behaviour. It is now a behaviour, and
 * the two published strings that still described the old world were corrected with
 * it.
 *
 * What is still missing is the proof, and the honest reason is a fact about the
 * ledger, not a lapse: `available = wallet - held` is derived from journal rows
 * (`topup - consume - refund` for the wallet side), so an org seeded with only
 * `Organization.credits` and no top-up cannot reserve anything — `claimRun` answers
 * `ledger_refused`, not `empty_wallet`. A behavioural test therefore has to fund
 * BOTH sides deliberately, and every DB-backed billing suite in this repo is in the
 * recorded local-failure set, so a test written here could not be watched going red
 * for the right reason. Asserting the wrong failure is how a money-path test ends
 * up certifying a guess.
 *
 * So this file checks the five things that are true of the SOURCE and can be proved
 * here, and each one is a way the behaviour could quietly stop being true:
 *
 *   1. Nothing debits the wallet directly any more. A single new `deductCredit()`
 *      call in a route would re-create the unconditional debit.
 *   2. "Is this the demo" is decided by the configured address, never by plan tier,
 *      in BOTH exempting paths — `planTierFor` resolves an undeclared org to
 *      "demo", so a tier-keyed exemption is a free pass that widens as customers
 *      sign up.
 *   3. The claim happens BEFORE the run, so a refusal cannot be a free dial.
 *   4. The allowance is derived from `PLANS[].includedPerMonth`, not retyped — a
 *      second copy is the drift this repo's parity tests exist to catch.
 *   5. Published demo copy does not advertise a credit cost, because that is the
 *      sentence that already drifted once.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), "utf8");

/** Code lines only — a comment that names a banned call is documentation, not a call. */
function codeOf(rel: string): string {
  return read(rel)
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
}

/** Direct wallet moves, anywhere in the tree outside the module that owns them. */
function directDebits(): string[] {
  const files = [
    "src/app/api/console/fire/route.ts",
    "src/app/api/v1/interventions/route.ts",
    "src/app/api/elevenlabs/tools/card-freeze/route.ts",
    "src/app/api/elevenlabs/tools/verify-transaction/route.ts",
    "src/app/api/elevenlabs/tools/human-handoff/route.ts",
    "src/app/api/agent/route.ts",
    "src/worker/dial.ts",
    "src/lib/policy-gate.ts",
    "src/lib/elevenlabs/inbound.ts",
  ];
  const hits: string[] = [];
  for (const f of files) {
    const code = codeOf(f);
    for (const call of ["deductCredit(", "refundCredit("]) {
      if (code.includes(call)) hits.push(`${f}: ${call.slice(0, -1)}`);
    }
  }
  return hits;
}

/** Which predicate each exemption path is allowed to consult. */
function exemptionPredicates(rel: string): { demoAccount: boolean; planTier: boolean } {
  const code = codeOf(rel);
  return {
    demoAccount: /isDemoAccount\s*\(/.test(code),
    planTier: /planTierFor\s*\(|planTier\s*[=!]==?\s*["']demo["']/.test(code),
  };
}

test("the gate has the files it claims to read", () => {
  // Tripwire: an empty read list makes every rule below pass vacuously, which is
  // the failure shape this whole family of gates exists to prevent.
  for (const f of ["src/lib/billing/charge-mode.ts", "src/app/api/console/fire/route.ts"]) {
    expect(read(f).length, f).toBeGreaterThan(500);
  }
});

test("1. nothing debits the wallet directly — charge-mode is the only door", () => {
  expect(directDebits(), directDebits().join("\n")).toEqual([]);
  // …and the module that replaced them is the one the fire route actually calls.
  const fire = codeOf("src/app/api/console/fire/route.ts");
  expect(fire.includes("claimRun(")).toBe(true);
  expect(fire.includes("refundRun(")).toBe(true);
});

test("2. the demo exemption is keyed on the configured address, not the plan tier", () => {
  for (const rel of ["src/lib/billing/charge-mode.ts", "src/lib/auth/two-factor-gate.ts"]) {
    const used = exemptionPredicates(rel);
    expect({ file: rel, ...used }).toEqual({
      file: rel,
      demoAccount: true,
      planTier: false,
    });
  }
});

test("3. the claim is taken before the run, and returned on every nothing-armed path", () => {
  const fire = codeOf("src/app/api/console/fire/route.ts");
  const claimAt = fire.indexOf("await claimRun(");
  const firstUpstream = fire.search(/await (fetch|intervene|dial|enqueue)/);
  expect(claimAt).toBeGreaterThan(-1);
  // A refund per refusal path (rate limit, policy gate, upstream failure): three
  // documented exits. Fewer means a path was added that keeps the credit while
  // arming nothing — which is the exact shape of a silent over-charge.
  expect((fire.match(/await refundRun\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  expect(claimAt).toBeLessThan(firstUpstream === -1 ? fire.length : firstUpstream);
});

test("4. the free allowance is derived from the catalog, never retyped", () => {
  const charge = codeOf("src/lib/billing/charge-mode.ts");
  expect(charge.includes("PLAN_INCLUDED_UNITS")).toBe(true);
  expect(charge.includes("unitsForPlan")).toBe(true);
  // No literal allowance: 500 / 2500 / 10000 belong to `PLANS` and its parity
  // tests, and a copy here would be free to drift the day a price changes.
  expect(charge).not.toMatch(/includedUnits:\s*\d/);
});

test("5. published demo copy does not advertise a credit cost", () => {
  const auth = read(join("src", "views", "Auth.tsx"));
  const demoNote = /role:\s*"demo",[\s\S]*?note:\s*"([^"]*)"/.exec(auth)?.[1] ?? "";
  expect(demoNote.length).toBeGreaterThan(40);
  expect(demoNote).not.toMatch(/\d+\s+credits/);
  // It says the true thing instead, so the sentence is checkable rather than
  // merely absent: the demo is metered and audited, and not billed.
  expect(demoNote.toLowerCase()).toContain("never billed");
});

test("every rule can fail — planted violations, and the clean cases they must not bite", () => {
  // Rule 1: the exact line that used to be true.
  const reintroduced = "const claim = await deductCredit(userId, orgId);";
  expect(reintroduced.includes("deductCredit(")).toBe(true);

  // Rule 2: a tier-keyed exemption is the widening hole.
  const tierKeyed = 'if (planTierFor(orgId) === "demo") return null;';
  expect(/planTierFor\s*\(|planTier\s*[=!]==?\s*["']demo["']/.test(tierKeyed)).toBe(true);
  const emailKeyed = "if (isDemoAccount(identity.email)) return null;";
  expect(/planTierFor\s*\(|planTier\s*[=!]==?\s*["']demo["']/.test(emailKeyed)).toBe(false);

  // Rule 3: a claim taken AFTER the dial cannot refund what was already spent.
  const reordered = "await fetch(upstream);\nconst claim = await claimRun(input);";
  expect(reordered.indexOf("await claimRun(")).toBeGreaterThan(
    reordered.search(/await (fetch|intervene|dial|enqueue)/),
  );

  // Rule 5: the string this gate was written for.
  expect(/\d+\s+credits/.test("Guided live scenario. 25 credits.")).toBe(true);
  expect(/\d+\s+credits/.test("Guided live scenario. Never billed: the cost is ours.")).toBe(false);
});
