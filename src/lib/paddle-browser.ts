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
