import * as Sentry from "@sentry/nextjs";

/**
 * Browser-side error capture and tracing — the client half of the Sentry story.
 *
 * ── Why this file is named what it is ────────────────────────────────────────
 * `sentry.client.config.ts` is the v8 name. The SDK at `@sentry/nextjs@11.4.0`
 * auto-instruments `instrumentation-client.ts` (a Next.js file convention, see
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation-client.md`),
 * and nothing loads the old path any more — so a config file sitting at the
 * repository root with a valid DSN in the environment captured exactly nothing.
 * Browser errors, the entire React tree, and every client fetch went unreported
 * while the code that was supposed to catch them looked complete and correct.
 *
 * `NEXT_PUBLIC_SENTRY_DSN` is inlined into the bundle at build time. Without it
 * `Sentry.init` is not called at all, so a deployment that has not opted in ships
 * no Sentry transport in its client bundle.
 *
 * ── The scrubbing rules are the server's, deliberately ───────────────────────
 * Same field names, same refusal, mirrored from `src/instrumentation.ts`. They
 * are duplicated rather than shared because this module is bundled into the
 * browser and the server file is not — but a field stripped on one side and sent
 * on the other is a leak with a comment next to it, so the two lists must move
 * together. `tests/unit/sentry-scrub-parity.test.ts` is what keeps that true.
 */

/** Authorization material, in any of the shapes the SDK may have collected it. */
const CREDENTIAL_FIELDS = /authorization|auth|token|api.?key|secret|cookie/i;
/** Bank-facing payload that must never leave the browser as an event attribute. */
const CUSTOMER_FIELDS = /phone|email|merchant|amount|transcript|case_?ref|sms/i;

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
    environment:
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? (process.env.NODE_ENV || "development"),
    // Page-load and navigation spans, so "the console was blank for a customer"
    // is answerable with timings rather than guesses.
    integrations: [Sentry.browserTracingIntegration()],
    beforeSend(event) {
      if (event.request?.headers) {
        const headers = event.request.headers as Record<string, unknown>;
        for (const key of Object.keys(headers)) {
          if (CREDENTIAL_FIELDS.test(key)) delete headers[key];
        }
      }
      // The request body is where a credential actually lives: the console posts
      // BYOK keys and magic-link tokens through fetch, and Sentry's own request
      // capture would transmit the body verbatim.
      if (event.request?.data) delete event.request.data;
      if (event.extra) {
        const extra = event.extra as Record<string, unknown>;
        for (const key of Object.keys(extra)) {
          if (CUSTOMER_FIELDS.test(key)) delete extra[key];
        }
      }
      if (event.user?.id) delete event.user.id;
      if (event.user?.email) delete event.user.email;
      return event;
    },
  });
}

/**
 * Router transition timings. Next calls this before it renders the destination,
 * and the SDK turns it into a navigation span — the difference between "slow"
 * and "slow on the way into the console".
 */
export function onRouterTransitionStart(url: string, navigationType: string): void {
  if (!dsn) return;
  Sentry.captureRouterTransitionStart(url, navigationType as never);
}
