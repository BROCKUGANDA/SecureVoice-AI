"use client";

/**
 * The Paddle browser SDK, initialised ONCE.
 *
 * ## Never silently default the environment
 *
 * `NEXT_PUBLIC_PADDLE_ENVIRONMENT` is read at call time and a missing or
 * unrecognised value THROWS. A default of `production` would point a developer's
 * local checkout at the live account and take real money during what everyone
 * believed was a test; a default of `sandbox` would let a production deploy
 * silently run test prices. Neither failure announces itself.
 *
 * The token is CLIENT-side, so it is a `NEXT_PUBLIC_` var and must be the
 * `test_` prefixed sandbox token in sandbox. The SERVER-side API key never
 * appears in this file or anywhere under `"use client"`.
 */

import { initializePaddle, type Paddle } from "@paddle/paddle-js";

export type PaddleEnvironment = "sandbox" | "production";

let paddlePromise: Promise<Paddle | undefined> | null = null;

/** The configured environment, or throw. */
export function paddleEnvironment(): PaddleEnvironment {
  const raw = process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT?.trim().toLowerCase();
  if (raw === "sandbox") return "sandbox";
  if (raw === "production") return "production";
  throw new Error(
    `NEXT_PUBLIC_PADDLE_ENVIRONMENT is not set to "sandbox" or "production" (got ${JSON.stringify(raw)}). ` +
      `Refusing to guess — a wrong environment charges the wrong Paddle account.`,
  );
}

/** The client-side token for the configured environment. */
export function paddleToken(): { env: PaddleEnvironment; token: string } {
  const env = paddleEnvironment();
  // One var for both environments. A per-env var (`..._SANDBOX` / `..._PROD`)
  // invites the classic failure: sandbox and live carry different tokens, and a
  // deploy that forgets to set the live one silently falls back to a sandbox
  // token — or, worse, the other way round. One var means one obvious value to
  // set, and the `test_` prefix check below catches a wrong-environment pairing.
  const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN?.trim();
  if (!token) {
    throw new Error(`NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is not set for the ${env} environment.`);
  }
  // Sandbox tokens are `test_` prefixed. Catching the mismatch here means a
  // production deploy carrying a sandbox token fails loudly at first checkout
  // rather than quietly running against the wrong account.
  if (env === "sandbox" && !token.startsWith("test_")) {
    throw new Error(
      `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN does not look like a SANDBOX token (expected a "test_" prefix).`,
    );
  }
  return { env, token };
}

/**
 * Price ids per tier, read from the environment.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A CONSTANT
 *
 * These six ids used to be a hardcoded `Record` of SANDBOX `pri_…` values
 * declared in `src/views/Pricing.tsx`, with a comment claiming they were "read
 * from env in any build that is not sandbox". That claim was false: nothing
 * anywhere read a price id from the environment. A production build therefore
 * rendered real prices wired to sandbox price objects — a checkout that either
 * fails outright or, worse, resolves to nothing, with no error to explain it.
 *
 * Price ids are environment-specific by definition. A sandbox id is not a stale
 * live id; it does not exist in the live catalog at all. So they are
 * configuration, and configuration belongs in the environment.
 *
 * ── WHY THERE IS A SEPARATE `NEXT_PUBLIC_` VAR RATHER THAN REUSING PADDLE_PRICES
 *
 * `PADDLE_PRICES` is server-only; `NEXT_PUBLIC_*` is inlined into the browser
 * bundle at build time, so the browser genuinely cannot read the server var.
 * That forces two vars — but it does NOT force two SHAPES, and this deliberately
 * uses the identical `key -> pri_…` shape that `parsePriceMap` enforces
 * server-side, so there is one mental model and one shape to review.
 *
 * The tier is recovered from the key's amount prefix (`usd_9900_month` ->
 * starter) using the same `usd_<cents>` -> plan table the billing code already
 * uses. An unrecognised amount is a hard error rather than a skipped entry: a
 * silently-dropped price is a pricing page with a missing Buy button that
 * reports nothing.
 */

/**
 * `usd_<cents>` -> plan id.
 *
 * BOTH intervals are listed because the price key encodes the AMOUNT actually
 * charged, and the annual amount is ten times the monthly one (`usd_99000_year`
 * is $990/yr against `usd_9900_month` at $99/mo — the 10x annual ratio
 * `tests/billing/catalog-parity.test.ts` asserts). Listing only the monthly
 * amounts would leave every `*_year` key unresolvable, and the completeness
 * check below would then reject the whole map and the pricing page would refuse
 * to render. Mirrors PRICE_KEY_TO_PLAN in payments/overage.ts, which carries the
 * monthly set because billing only ever quotes a monthly anchor.
 */
const AMOUNT_TO_PLAN: Readonly<Record<string, string>> = Object.freeze({
  usd_9900: "starter",
  usd_99000: "starter",
  usd_49900: "growth",
  usd_499000: "growth",
  usd_200000: "enterprise",
  usd_2000000: "enterprise",
});

type PriceTier = { month: string; year: string };

/**
 * The price id map by tier, or null when the environment does not supply one.
 *
 * `null` rather than a throw here: the caller decides what a missing map means.
 * The pricing page turns it into a loud failure (see `paddlePriceIds`), while a
 * component that merely wants to know "is checkout wired?" can ask
 * `paddlePricesConfigured` without catching.
 */
function readPriceIds(): Record<string, PriceTier> | null {
  const raw = process.env.NEXT_PUBLIC_PADDLE_PRICES;
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const byTier: Record<string, PriceTier> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string" || !/^pri_[A-Za-z0-9]+$/.test(value)) continue;
    // Key shape: `usd_<cents>_<interval>`.
    const parts = key.split("_");
    if (parts.length < 3) continue;
    const plan = AMOUNT_TO_PLAN[parts.slice(0, 2).join("_")];
    if (!plan) continue;
    const interval = parts[2];
    if (interval !== "month" && interval !== "year") continue;
    const tier = (byTier[plan] ??= { month: "", year: "" });
    tier[interval] = value;
  }

  // Only usable if EVERY tier has BOTH intervals. A half-filled map would render
  // a working monthly Buy and a dead annual one, which reads as a bug in one tier
  // rather than a config error.
  const complete = Object.values(byTier).every(
    (t) => t.month.startsWith("pri_") && t.year.startsWith("pri_"),
  );
  return Object.keys(byTier).length > 0 && complete ? byTier : null;
}

/**
 * Price ids for the pricing page, by tier.
 *
 * Throws when the environment supplies no complete map. This is the ONE place
 * the missing config is allowed to be loud: the pricing page is where a customer
 * is about to be shown a Buy button, and a Buy button wired to nothing is worse
 * than a build that refuses to render one.
 */
export function paddlePriceIds(): Record<string, PriceTier> {
  const ids = readPriceIds();
  if (!ids) {
    throw new Error(
      "NEXT_PUBLIC_PADDLE_PRICES is not set to a complete price map. It must be " +
        'JSON of usd_<cents>_<month|year> -> "pri_...", e.g. ' +
        '{"usd_9900_month":"pri_…","usd_9900_year":"pri_…", …}. ' +
        "Refusing to fall back to any bundled id — sandbox price ids do not exist " +
        "in the live catalog.",
    );
  }
  return ids;
}

/** True when the environment supplies a complete price map. */
export function paddlePricesConfigured(): boolean {
  return readPriceIds() !== null;
}

/**
 * Initialise Paddle once, idempotently.
 *
 * The promise is cached so a component re-mounting (a view switch in this SPA,
 * for instance) does not re-initialise and re-inject the checkout iframe.
 */
export function getPaddle(): Promise<Paddle | undefined> {
  const { env, token } = paddleToken();
  if (!paddlePromise) {
    paddlePromise = initializePaddle({
      environment: env,
      token,
      // Checkout is opened imperatively with `Paddle.Checkout.open()`, so no
      // `eventCallback` is registered here. Success handling is the redirect to
      // /welcome, which is also what Paddle's own `checkout.completed` event
      // would give us — the redirect is the authoritative signal because the
      // webhook is what actually credits anything.
    });
  }
  return paddlePromise;
}
