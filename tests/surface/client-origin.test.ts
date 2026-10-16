/**
 * No client component may dial an origin the repository has not declared.
 *
 * WHY THIS FILE EXISTS. `src/components/HealthCheck.tsx` was mounted in the root
 * layout and polled `https://voice.securevoice.ai/api/health` every 30 s on every
 * page of the product. That host has no DNS record (`ENOTFOUND`), the request
 * therefore always threw, and the `catch` it threw into was the ONLY branch that
 * sets `status = "degraded"` — so every visitor was shown a red banner reading
 * "Voice Engine experiencing degraded performance … Our team has been alerted."
 * A false alarm about a failure that never happened, on a bank's fraud console,
 * asserted in English on a bilingual product, and backed by no alerting.
 *
 * PR #86 deleted it. The mount came back on `main` through the promotion after
 * that (#88 re-conflicted `layout.tsx` and the deletion was resolved away), and
 * nothing — not lint, not tsc, not 4,900 tests — noticed, because a component
 * that renders a lie is not a type error. The same file also existed a second
 * time at the repo root (`components/HealthCheck.tsx`), unreferenced because the
 * `@/*` alias points at `src/*`, which is how a deleted file can look gone in one
 * tree and live in another.
 *
 * THE RULE, and why it is drawn here. A hard-coded absolute origin in code the
 * browser runs is banned unless it is in ALLOWED below, in two shapes:
 *   · the argument of `fetch()`;
 *   · the `??` fallback of one — because the fallback is what ships when an
 *     operator forgets the env var, which is exactly the incident above.
 * Origins that only appear as *displayed* text (a `placeholder="https://…"`
 * example in the CRM or webhook configuration UI) are not calls and are not
 * banned; the point is egress, not the presence of a URL in a string.
 *
 * Deliberately NOT the check: "is this host reachable". A gate that asks the
 * network turns a typo into a flaky test. This one only asks whether the
 * repository ever said this origin was allowed to be contacted.
 */
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Origins a browser bundle may contact without a same-origin policy problem to
 * solve here. Each entry is a decision, so an addition must say what it is for.
 */
const ALLOWED: Record<string, string> = {
  // The analytics SDK's own regional default, overridable by
  // NEXT_PUBLIC_POSTHOG_HOST. Not our host, and not a health claim.
  "us.i.posthog.com": "PostHog SDK default in src/app/providers.tsx",
};

/** Absolute origin as used in a call or a fallback. */
const FETCH_ORIGIN = /fetch\(\s*[`'"]https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/i;
const FALLBACK_ORIGIN = /\?\?\s*[`'"]https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/i;

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "coverage") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // `src/generated` is Prisma's output; the repo root holds the deployed app.
      if (entry === "generated") continue;
      sources(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Only modules the browser actually runs: a client component or a client hook. */
const CLIENT = sources(".").filter((f) => {
  const body = readFileSync(f, "utf8");
  return /^["']use client["']/m.test(body);
});

const offenders: string[] = [];
for (const file of CLIENT) {
  const body = readFileSync(file, "utf8");
  body.split("\n").forEach((line, i) => {
    const trimmed = line.trim();
    // Comments describe the rule; they are not egress.
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    for (const re of [FETCH_ORIGIN, FALLBACK_ORIGIN]) {
      const m = re.exec(line);
      if (!m) continue;
      const host = m[1]!.toLowerCase();
      if (ALLOWED[host]) continue;
      offenders.push(`${file}:${i + 1}: ${host}\n    ↳ ${trimmed.slice(0, 100)}`);
    }
  });
}

test("the scan is looking at client modules, or it is certifying nothing", () => {
  // Tripwire for the gate itself: an empty file list makes every assertion below
  // pass vacuously, which is the failure mode this whole family exists to prevent.
  // 40 is comfortably below the real count of client modules and comfortably above
  // the point where a broken walk would still report success.
  expect(CLIENT.length).toBeGreaterThan(40);
  expect(CLIENT.some((f) => f.includes(join("src", "views")))).toBe(true);
});

test("no client module dials an origin the repository has not declared", () => {
  expect(offenders, offenders.join("\n")).toEqual([]);
});

test("the ban can fail — both shapes are caught, and a relative call is not", () => {
  // Positive control. Without it this file cannot tell "clean" from "blind", and
  // the incident it was written for is exactly a case of clean-looking blindness.
  const caught: Array<[string, string]> = [
    ['fetch("https://voice.securevoice.ai/api/health")', "voice.securevoice.ai"],
    [
      'const u = process.env.X ?? "https://voice.securevoice.ai/api/health";',
      "voice.securevoice.ai",
    ],
  ];
  for (const [line, host] of caught) {
    const hit = [FETCH_ORIGIN, FALLBACK_ORIGIN].map((re) => re.exec(line)?.[1]).filter(Boolean);
    expect({ line, hit }).toEqual({ line, hit: [host] });
    expect(ALLOWED[host]).toBeUndefined();
  }
  // Same-origin calls are the normal case and must not be flagged, or the rule
  // would be relaxed the first time it annoyed someone.
  const relative = 'fetch("/api/console/outbox")';
  expect([FETCH_ORIGIN, FALLBACK_ORIGIN].some((re) => re.test(relative))).toBe(false);
});

test("every allowed origin is still a real decision", () => {
  // An allowlist entry whose host no longer appears anywhere is drift wearing the
  // costume of documentation: it lets the next host slide in under "there are
  // already exceptions".
  for (const [host, why] of Object.entries(ALLOWED)) {
    expect(why.length).toBeGreaterThan(15);
    const used = CLIENT.some((f) => readFileSync(f, "utf8").includes(host));
    expect({ host, stillUsedBySomeClientModule: used }).toEqual({
      host,
      stillUsedBySomeClientModule: true,
    });
  }
});
