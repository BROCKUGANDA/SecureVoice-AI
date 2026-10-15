/**
 * UNIT — the policy gate's country check resolves per tenant.
 *
 * `runPolicyGate` took an `orgId`, refused with the words "is not on the org
 * allowlist", and then read the global `ALLOWED_COUNTRIES` variable. The per-tenant
 * mechanism already existed two directories over — `geoPolicyFor` in
 * src/lib/abuse/geo.ts layers a per-call override, the in-process org registry, the
 * per-org env var and the global config, and its deny lists only ever grow. The gate
 * had a copy of the weakest layer and called it the org policy.
 *
 * So a tenant scoped to Japan by `ABUSE_ALLOWED_COUNTRIES__ORG_ACME` reached the
 * gate that runs BEFORE the geo layer, was measured against a list that had never
 * heard of Japan, and was refused. The refusal even said which list it had been
 * measured against, and named the wrong one.
 */
import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { clearOrgGeoPolicies, geoPolicyFor, setOrgGeoPolicy } from "@/lib/abuse/geo";
import { resetAbuseConfig, setAbuseConfig } from "@/lib/abuse/config";
import { HARD_DENIED_COUNTRIES } from "@/lib/abuse/config";

afterAll(() => {
  clearOrgGeoPolicies();
  resetAbuseConfig();
});

test("an org-scoped allowlist is the one the effective policy reports", () => {
  setAbuseConfig({ geo: { allowlist: ["AE"] } });
  setOrgGeoPolicy("org-jp-only", { allowlist: ["JP"] });

  expect(geoPolicyFor("org-jp-only").allowlist).toContain("JP");
  // The point of layering: a tenant that configured nothing keeps the global list,
  // and reading one org's policy must not leak into another's.
  expect(geoPolicyFor("org-nothing-set").allowlist).toEqual(["AE"]);
  expect(geoPolicyFor(null).allowlist).toEqual(["AE"]);
});

test("no tenant can widen or subtract the hard deny list", () => {
  setAbuseConfig({ geo: { allowlist: ["AE"] } });
  // An org that names a sanctioned destination in its allow list AND empties its
  // deny list. The allow list is a permission, so it is honoured; the deny list is
  // a safety net, so it is not.
  setOrgGeoPolicy("org-hostile", { allowlist: [...HARD_DENIED_COUNTRIES], denylist: [] });

  const policy = geoPolicyFor("org-hostile");
  for (const denied of HARD_DENIED_COUNTRIES) {
    expect({ denied, stillDenied: policy.denylist.includes(denied) }).toEqual({
      denied,
      stillDenied: true,
    });
  }
});

test("the policy gate asks the tenant resolver instead of keeping its own list", () => {
  // Structural, for the same reason compliance-disclosure.test.ts is structural:
  // the guarantee is about which module a file is allowed to consult, and a comment
  // does not stop the next reader from reaching for `process.env` again. The
  // behaviour tests above prove the resolver is correct; this one proves the gate is
  // wired to it.
  const source = readFileSync(join("src", "lib", "policy-gate.ts"), "utf8");
  expect(source).toContain("geoPolicyFor(");
  expect(source).not.toMatch(/process\.env\.ALLOWED_COUNTRIES/);
  expect(source).not.toMatch(/env\.ALLOWED_COUNTRIES/);
});
