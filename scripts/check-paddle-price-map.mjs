#!/usr/bin/env node
/**
 * Refuse to publish a release image that cannot sell.
 *
 * ## Why this exists
 *
 * `NEXT_PUBLIC_*` is INLINED AT BUILD TIME. A release image built without the
 * Paddle price map has a pricing page that renders the rate card and offers no
 * checkout — the page looks right and sells nothing. The image is PUBLISHED,
 * so the artifact that claims to be a release is the one that cannot take
 * money.
 *
 * Measured on 2026-10-21, on the v0.2.49 release: all three Paddle build args
 * were EMPTY, because the repository variables the build reads
 * (`vars.NEXT_PUBLIC_PADDLE_PRICES`, `…_ENVIRONMENT`, `…_CLIENT_TOKEN`) did not
 * exist. The box's own `.env` had them, so the BRANCH deploy of the same commit
 * had a working pricing page and the RELEASED image did not: two artifacts, one
 * commit, and only one of them could take money.
 *
 * So the release refuses to publish an image that cannot sell. A missing
 * variable is a mistake, and a mistake that costs money later should be a red
 * build now rather than a quiet hole in a release.
 *
 * ## What it checks
 *
 * The same shape `src/lib/paddle-browser.ts` accepts, because a map this
 * script calls usable is exactly a map `paddlePriceIds()` will not throw on:
 *
 *   · it parses as JSON, and it is an object
 *   · every value is a Paddle price id (`pri_…`)
 *   · every key is `usd_<cents>_<month|year>`
 *   · every tier has BOTH intervals
 *
 * The last one is the one that bites. A half-filled map renders a working
 * monthly Buy button and a dead annual one, and `paddlePriceIds()` rejects the
 * WHOLE map rather than half of it — so a map missing one interval is not a
 * degraded pricing page, it is no pricing page at all.
 *
 * The annual price is ten months, which is the ratio
 * `tests/billing/catalog-parity.test.ts` asserts, so `usd_<A>_month` pairs
 * with `usd_<A*10>_year`. If the rate card ever changes that ratio, the parity
 * test fails first and says so.
 *
 * ## Usage
 *
 *   NEXT_PUBLIC_PADDLE_PRICES='{"usd_250000_month":"pri_…", …}' \
 *   NEXT_PUBLIC_PADDLE_ENVIRONMENT=sandbox \
 *   NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=test_… \
 *   node scripts/check-paddle-price-map.mjs
 *
 * Exit code 0 means the map is publishable. Exit code 1 means it is not, and
 * the message says which of the three values is wrong.
 */

const PRICES = process.env.NEXT_PUBLIC_PADDLE_PRICES ?? "";
const ENVIRONMENT = process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT ?? "";
const CLIENT_TOKEN = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN ?? "";

const problems = [];

if (!PRICES.trim()) {
  problems.push("NEXT_PUBLIC_PADDLE_PRICES is empty");
}
if (!ENVIRONMENT.trim()) {
  problems.push("NEXT_PUBLIC_PADDLE_ENVIRONMENT is empty");
}
if (!CLIENT_TOKEN.trim()) {
  problems.push("NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is empty");
}

// A Paddle environment is a closed set, and a typo here is a checkout that
// opens against the wrong account rather than a build that fails.
if (ENVIRONMENT.trim() && !["sandbox", "production"].includes(ENVIRONMENT.trim())) {
  problems.push(`NEXT_PUBLIC_PADDLE_ENVIRONMENT is "${ENVIRONMENT}" (sandbox or production)`);
}

let map = null;
if (PRICES.trim()) {
  try {
    map = JSON.parse(PRICES);
  } catch (err) {
    problems.push(
      `NEXT_PUBLIC_PADDLE_PRICES is not JSON: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (map !== null && (typeof map !== "object" || map === null || Array.isArray(map))) {
    problems.push("NEXT_PUBLIC_PADDLE_PRICES is not a JSON object");
    map = null;
  }
}

if (map !== null) {
  const keys = Object.keys(map);
  if (keys.length === 0) {
    problems.push("NEXT_PUBLIC_PADDLE_PRICES is an empty object");
  }
  for (const [key, value] of Object.entries(map)) {
    if (typeof value !== "string" || !/^pri_[A-Za-z0-9]+$/.test(value)) {
      problems.push(`${key} is not a Paddle price id (pri_…)`);
    }
    if (!/^usd_\d+_(month|year)$/.test(key)) {
      problems.push(`${key} is not usd_<cents>_<month|year>`);
    }
  }
  for (const key of keys) {
    const parts = key.match(/^usd_(\d+)_(month|year)$/);
    if (!parts) continue;
    const amount = Number(parts[1]);
    const partner = parts[2] === "month" ? `usd_${amount * 10}_year` : `usd_${amount / 10}_month`;
    if (!map[partner]) {
      problems.push(`${key} has no ${partner} — a tier needs both intervals`);
    }
  }
}

if (problems.length > 0) {
  console.error("the release build args are not publishable:");
  for (const problem of problems) {
    console.error(`  · ${problem}`);
  }
  console.error(
    "NEXT_PUBLIC_* is inlined at BUILD time, so the published image would ship a pricing\n" +
      "page that renders the rate card and cannot take money. Set the repository\n" +
      "variables and re-run the release.",
  );
  process.exit(1);
}

console.log(`price map: ${Object.keys(map).length} ids, every tier has both intervals`);
console.log(`paddle environment: ${ENVIRONMENT}`);
const prefix = CLIENT_TOKEN.split("_")[0];
if (prefix !== "test" && prefix !== "prod") {
  console.warn(
    `::warning::the client token does not look like a Paddle client token (test_/prod_ prefix)`,
  );
} else {
  console.log(`client token prefix: ${prefix}_`);
}
