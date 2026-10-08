/**
 * Next.js instrumentation hook — runs once at server boot (Node runtime).
 * Surfaces missing critical configuration immediately in the logs instead of
 * as a confusing 500 on the first request that needed it.
 *
 * Deliberately NON-fatal: the reference deployment boots with no .env at all
 * (audit-only dry-run demo), and crashing there would break the zero-config
 * judge path. The failures that are actually unsafe (e.g. BYOK encryption
 * without AUTH_SECRET) fail closed at the point of use.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertCriticalConfig } = await import("@/lib/config");
  const missing = assertCriticalConfig();
  if (missing.length > 0) {
    console.warn(
      `[config] missing critical env vars: ${missing.join(", ")} — ` +
        `the platform boots in degraded/audit-only mode; set them before enabling live voice or BYOK.`,
    );
  }

  // Sentry is surfaced the moment the DSN env var exists, and ONLY then —
  // importing the Sentry SDK unconditionally at boot adds its transport
  // overhead to every request path even when a deployment has not opted in.
  if (process.env.SENTRY_DSN) {
    const { init } = await import("@sentry/nextjs");
    try {
      init({
        dsn: process.env.SENTRY_DSN,
        tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
        environment: process.env.SENTRY_ENVIRONMENT ?? (process.env.NODE_ENV || "development"),
        serverName: process.env.RENDER_INSTANCE_ID ?? undefined,
        // Never send payloads: our bank-facing rows frequently contain an
        // SMS body or a partial transcript, and Sentry's own request-body
        // capture would transmit it off-platform.
        beforeSend(event) {
          if (event.request?.data) delete event.request.data;
          if (event.extra) {
            for (const k of Object.keys(event.extra)) {
              if (/phone|email|merchant|amount|transcript|case_?ref|sms/i.test(k))
                delete (event.extra as any)[k];
            }
          }
          return event;
        },
      });
      console.warn(
        "[sentry] initialised (traces: " +
          (process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1") +
          ", environment: " +
          (process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV) +
          ")",
      );
    } catch (err) {
      console.error(
        "[sentry] init failed — continuing without remote error capture:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // The "did we forget to flip it?" class of failure — loud at every boot,
  // plus `bun run preflight` before any demo or go-live.
  if (process.env.ELEVENLABS_DRY_RUN === "true") {
    console.warn(
      "[config] ELEVENLABS_DRY_RUN=true — NO real voice. Flip to false before judges or real users.",
    );
  }
  if (!process.env.BETTER_AUTH_SECRET || process.env.BETTER_AUTH_SECRET.length < 32) {
    console.warn(
      "[config] BETTER_AUTH_SECRET missing or under 32 chars — auth will throw at import. Generate with: openssl rand -base64 32",
    );
  }

  if (!process.env.QSTASH_TOKEN) {
    console.warn(
      "[config] QSTASH_TOKEN unset — bank signals enqueue via the Postgres queue directly. Set QSTASH_TOKEN and QSTASH_CURRENT/NEXT_SIGNING_KEY to dispatch through Upstash.",
    );
  }
  if (!process.env.SENTRY_DSN) {
    console.warn("[config] SENTRY_DSN unset — remote error capture is off for this deployment.");
  }
}
