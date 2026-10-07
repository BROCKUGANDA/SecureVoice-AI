/**
 * The tenant is the SESSION, and this file pins that down.
 *
 * `session.activeOrganizationId` is the only thing that decides which
 * institution's data a request can touch (src/lib/credits.ts `getProfile`).
 * That is a deliberate design choice — a client-supplied `orgId` is a
 * cross-tenant read waiting to happen — and the OrgSwitcher in the navbar only
 * changes it through `set-active`, which the server authorises against the
 * membership table.
 *
 * The dangerous regression is subtle: someone adds `?orgId=` or `body.orgId`
 * support to a console route "just for the switcher", and every isolation
 * property still holds until an attacker uses it. So the checks below are
 * source-level on purpose: they are the ones that catch the change at the
 * moment it is made, not after it ships.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const API = new URL("../../src/app/api/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// Paths are normalised to forward slashes as they are collected: on Windows
// `join` produces backslashes, and a separator-dependent matcher would then
// quietly scan nothing.
const routeFiles: string[] = [];
(function walk(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name).split("\\").join("/");
    if (entry.isDirectory()) walk(join(dir, entry.name));
    else if (entry.name === "route.ts") routeFiles.push(p);
  }
})(API);

/** Paths relative to src/app/api/, for readable failure messages. */
const rel = (p: string): string => p.slice(API.length);

const read = (p: string): string => readFileSync(p, "utf8");

test("every console and v1 route resolves its tenant from the session", () => {
  const guarded = routeFiles.filter((p) => /\/api\/(console|v1)\//.test(p));
  expect(guarded.length, "no console/v1 routes found — the scan is broken").toBeGreaterThan(5);

  const offenders: string[] = [];
  for (const p of guarded) {
    const src = read(p);
    // A tenant from the wire is the thing to prevent: query string, JSON body,
    // path segment, or a header the client sets.
    const patterns: [RegExp, string][] = [
      [/searchParams\.get\(\s*["'](org|orgId|tenant|organizationId|org_id)["']/i, "query param"],
      [/\b(orgId|org_id|organizationId)\s*[,}]?\s*(?::|\bas\b)?\s*$/m, null],
      [/body\.(orgId|org_id|organizationId)/, "JSON body orgId"],
      [/\bparams\.(orgId|org_id|organizationId)/, "path param orgId"],
      [/headers\.get\(\s*["'](x-org|x-tenant|x-organization)/i, "org header"],
    ];
    for (const [re, label] of patterns) {
      if (label && re.test(src)) offenders.push(`${rel(p)}: ${label}`);
    }
  }
  expect(
    offenders,
    "a guarded route must derive org from the session, never from the request",
  ).toEqual([]);
});

test("getProfile reads the org from the session and has no org argument", () => {
  const src = read(join(API, "..", "..", "lib", "credits.ts"));
  expect(src).toContain("activeOrganizationId");
  // A parameter would be the loophole: `getProfile(orgId)` invites a caller to
  // pass someone else's tenant and is exactly what this file forbids.
  const sig = src.match(/export async function getProfile\(([^)]*)\)/)?.[1] ?? "";
  expect(sig.trim(), "getProfile must take no arguments").toBe("");
});

test("the org switcher changes the session, it does not send an org per request", () => {
  const src = read(join(API, "..", "..", "components", "shell", "OrgSwitcher.tsx"));
  // Goes through the server, which checks membership.
  expect(src).toContain("organization.setActive");
  // A raw fetch carrying an org id would bypass that check entirely.
  expect(src).not.toMatch(/fetch\(/);
  // And it refreshes, because every page reads the session during server render.
  expect(src).toContain("router.refresh()");
});

test("no console route trusts a client-supplied role", () => {
  const offenders: string[] = [];
  for (const p of routeFiles.filter((f) => /\/api\/console\//.test(f))) {
    const src = read(p);
    if (/\b(role)\s*[:=]\s*(?:body|parsed|payload|input)\b/.test(src)) {
      offenders.push(rel(p));
    }
  }
  // Role is read from the membership row via getProfile; accepting one from the
  // request would let any signed-in user mint themselves an operator.
  expect(offenders).toEqual([]);
});
