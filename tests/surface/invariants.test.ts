/**
 * GATE — the compliance invariants registry is true, or the build fails.
 *
 * `src/lib/flags.ts` used to declare four compliance and security controls as
 * feature flags. Nothing in `src/`, `scripts/` or `tests/` ever consulted them,
 * so the registry could report `complianceNoSecrets: false` to an operator who
 * set `COMPLIANCE_NO_CREDENTIAL_REQUESTS=false`, while the credential-ask refusal
 * kept firing — enforcement had never read the flag. The registry's own doc
 * comment promised a reviewer could answer "what cannot be disabled?" without
 * grepping source. It answered that question wrongly.
 *
 * The controls are now `INVARIANTS`, and every claim in that list is checked here
 * against the filesystem rather than trusted:
 *
 *   1. `enforcedAt` — the file exists, has that many lines, and the line at that
 *      number contains the named identifier. A path alone rots when a guard moves;
 *      a line number alone rots when anything above it changes. The pair is the
 *      only form that can fail.
 *   2. `provedBy` — the test file exists AND contains the guardrail token its
 *      assertion checks. "A test covers this refusal" is not a claim about a file
 *      name; it is a claim about an assertion, so the token is required.
 *   3. `neverConsultsFlags` — the enforcement files import nothing from
 *      `@/lib/flags`. That is *why* the guarantee is unconditional, and it is the
 *      property that would silently disappear if someone re-gated one of these
 *      paths behind a flag that "just defaults to true".
 *   4. The operator surface (`/api/console/invariants`) is the only place the
 *      registry is served, and it is not reachable without an operator session.
 *      The unauthenticated `/api/console/features` route is asserted to leak
 *      neither a flag it should not, nor an invariant at all.
 *   5. The gate is capable of failing. `flags.test.ts` has the mutation proof on
 *      the registry side; here the structural checks would each go red if an
 *      `enforcedAt` line moved, so they are asserted non-vacuously first.
 *
 * Run with `bun run test invariants` (or as part of `bun run test surface`).
 */
import { describe, expect, test, mock } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { INVARIANTS, clientFlags, invariantSurface } from "@/lib/flags";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * The stub the route's guard reads. Deliberately a standalone module object
 * rather than a forward of the real `@/lib/credits`: this route's import graph
 * reaches exactly one export of it, so nothing else can be missing at runtime.
 * If the route ever imports another symbol from credits, this mock has to grow
 * with it — and a link error is the loud failure that says so.
 */
let gate: { ok: true } | { ok: false; status: 401 | 403; error: string } = {
  ok: false,
  status: 401,
  error: "Sign in required — open the sign-in page.",
};

mock.module("@/lib/credits", () => ({
  requireOperator: async () => gate,
}));

/**
 * The check `enforcedAt` is graded by, factored out so this file can prove it is
 * capable of failing. Returns the list of reasons a pointer is NOT believed;
 * empty means the site holds.
 */
function enforcedAtProblems(site: { file: string; line: number; identifier: string }): string[] {
  const problems: string[] = [];
  if (!existsSync(join(ROOT, site.file))) {
    problems.push(`${site.file} does not exist`);
    return problems;
  }
  const lines = read(site.file).split(/\r?\n/);
  if (site.line < 1 || site.line > lines.length) {
    problems.push(`${site.file}:${site.line} is past the end of a ${lines.length}-line file`);
    return problems;
  }
  const at = lines[site.line - 1] ?? "";
  if (!at.includes(site.identifier)) {
    problems.push(`${site.file}:${site.line} does not contain "${site.identifier}"`);
  }
  return problems;
}

describe("every invariant points at enforcement that exists", () => {
  test("the registry is populated, or the loops below prove nothing", () => {
    // Same discipline as the published-claims gate: a guard iterating an empty
    // list is green while watching nothing.
    expect(INVARIANTS.length).toBe(4);
    for (const invariant of INVARIANTS) {
      expect(
        invariant.enforcedAt.length,
        `${invariant.name} has no enforcement site`,
      ).toBeGreaterThan(0);
      expect(invariant.provedBy.length, `${invariant.name} has no proof`).toBeGreaterThan(0);
    }
  });

  test("each enforcedAt file exists and that exact line carries that identifier", () => {
    const failures: string[] = [];
    for (const invariant of INVARIANTS) {
      for (const site of invariant.enforcedAt) {
        for (const problem of enforcedAtProblems(site))
          failures.push(`${invariant.name}: ${problem}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  test("each provedBy test exists and asserts the guardrail token", () => {
    for (const invariant of INVARIANTS) {
      for (const proof of invariant.provedBy) {
        expect(existsSync(join(ROOT, proof.file)), `${proof.file} does not exist`).toBe(true);
        expect(
          read(proof.file),
          `${proof.file} never asserts "${proof.asserts}" — it does not cover the refusal`,
        ).toContain(proof.asserts);
      }
    }
  });

  test("the enforcement files read no flag, which is what makes them unconditional", () => {
    for (const invariant of INVARIANTS) {
      expect(
        invariant.neverConsultsFlags.length,
        `${invariant.name} names no unconditional enforcement file`,
      ).toBeGreaterThan(0);
      for (const file of invariant.neverConsultsFlags) {
        expect(existsSync(join(ROOT, file)), `${file} does not exist`).toBe(true);
        const src = read(file);
        // Both spellings: `@/lib/flags` for the app graph, `lib/flags` for a
        // relative import. Either would mean the guard asks permission.
        expect(src, `${file} imports the flag registry`).not.toContain("lib/flags");
        expect(src, `${file} calls flag()`).not.toMatch(/\bflag\(/);
      }
    }
  });

  test("each retired env var is a name the registry says it ignores", () => {
    const surface = invariantSurface();
    expect(surface.length).toBe(INVARIANTS.length);
    for (const entry of surface) {
      expect(entry.enforced).toBe(true);
      expect(entry.configurable).toBe(false);
      expect(entry.envVarsIgnored.length, `${entry.name} retires nothing`).toBeGreaterThan(0);
      // An `envVar`-shaped claim has to look like one, or "ignored" is decoration.
      for (const envVar of entry.envVarsIgnored) {
        expect(envVar, `${entry.name} names a non-env-var`).toMatch(/^[A-Z][A-Z0-9_]{4,}$/);
      }
    }
  });
});

describe("the operator surface serves the invariants and nobody else does", () => {
  test("/api/console/features still serves exactly the client-safe flag", async () => {
    const { GET } = await import("@/app/api/console/features/route");
    const res = (await GET()) as Response;
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["consoleLiveFeed"]);
    // The registry split must not have widened the public surface.
    for (const invariant of INVARIANTS) {
      expect(
        body,
        `invariant ${invariant.name} reached the unauthenticated route`,
      ).not.toHaveProperty(invariant.name);
    }
    expect(JSON.stringify(body)).not.toContain("enforcedAt");
  });

  test("clientFlags() itself cannot carry an invariant", () => {
    const sent = clientFlags();
    for (const invariant of INVARIANTS) {
      expect(sent).not.toHaveProperty(invariant.name);
      expect(sent).not.toHaveProperty(`${invariant.name}Enabled`);
    }
  });

  test("/api/console/invariants is refused without an operator session", async () => {
    const { GET } = await import("@/app/api/console/invariants/route");
    gate = { ok: false, status: 401, error: "Sign in required — open the sign-in page." };
    const anon = await GET();
    expect(anon.status).toBe(401);
    expect(JSON.stringify(await anon.json())).not.toContain("enforcedAt");

    gate = { ok: false, status: 403, error: "Operator access required." };
    const member = await GET();
    expect(member.status).toBe(403);
    expect(JSON.stringify(await member.json())).not.toContain("complianceNoSecrets");
  });

  test("an operator gets the whole registry, and every pointer in it is a real file:line", async () => {
    const { GET } = await import("@/app/api/console/invariants/route");
    gate = { ok: true };
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as { invariants: ReturnType<typeof invariantSurface> };
    expect(body.invariants.map((i) => i.name).sort()).toEqual([
      "complianceDisclosure",
      "complianceNoSecrets",
      "compliancePiiRedaction",
      "webhookStrictSignatures",
    ]);

    for (const entry of body.invariants) {
      // What a reviewer actually needs: a place to open, and a test to run.
      expect(entry.enforcedAt.length).toBeGreaterThan(0);
      for (const at of entry.enforcedAt) {
        const [file, lineRaw] = at.split(":");
        expect(existsSync(join(ROOT, file ?? "")), `${at} is not a real path`).toBe(true);
        const line = Number(lineRaw);
        const text = read(file ?? "").split(/\r?\n/)[line - 1] ?? "";
        expect(text.length, `${at} points at an empty line`).toBeGreaterThan(0);
      }
      for (const proof of entry.provedBy) {
        expect(existsSync(join(ROOT, proof)), `${proof} does not exist`).toBe(true);
      }
      expect(entry.notConfigurable.length).toBeGreaterThan(40);
    }
  });

  test("the route's own claim about why it is not on the public surface is in the source", () => {
    // The doc comment is the reviewable answer to "why a new surface?". Asserting
    // it stays is cheap, and a rewrite that quietly moves invariants back onto the
    // unauthenticated route would drop it.
    const route = read("src/app/api/console/invariants/route.ts");
    expect(route).toContain("requireOperator");
    expect(route).toContain("/api/console/features");
    const features = read("src/app/api/console/features/route.ts");
    expect(features).toContain("/api/console/invariants");
    expect(features).toContain("clientFlags");
  });
});

describe("the gate is capable of failing", () => {
  test("a fabricated enforcement pointer is rejected", () => {
    // Without this, `enforcedAtProblems` could be a function that always returns
    // no problems and the suite above would be grading nothing. Same discipline
    // as the fabricated sentence fed to every ban in published-claims.test.ts.
    const site = INVARIANTS[0]?.enforcedAt[0];
    expect(site).toBeDefined();
    const real = site!;

    // A path that does not exist.
    expect(
      enforcedAtProblems({ ...real, file: "src/lib/compliance/definitely-not-here.ts" }),
    ).not.toEqual([]);

    // A line past the end of a real file.
    const lineCount = read(real.file).split(/\r?\n/).length;
    expect(enforcedAtProblems({ ...real, line: lineCount + 500 })).not.toEqual([]);

    // A real line, named identifier deliberately not on it. The last line of the
    // file is `}` or similar in every enforcement site here; asserting the check
    // notices an absent identifier is the whole point of pinning a line.
    expect(enforcedAtProblems({ ...real, identifier: "zzzNotARealIdentifier_zzz" })).not.toEqual(
      [],
    );

    // …and the genuine pointer passes, so the three above are not failing for an
    // unrelated reason (a broken helper reports problems for everything).
    expect(enforcedAtProblems(real)).toEqual([]);
  });

  test("the repository root this gate reads is this repository", () => {
    // A check that silently resolved to a different tree would grade the wrong
    // repository and report it as this one.
    expect(existsSync(join(ROOT, "src/lib/flags.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "package.json"))).toBe(true);
    // Stronger than "a file with this name exists": the tree being graded has to
    // be the tree carrying the registry under test.
    expect(read("src/lib/flags.ts")).toContain("export const INVARIANTS");
    expect(read("package.json")).toContain("scripts/run-tests.mjs");
  });
});
