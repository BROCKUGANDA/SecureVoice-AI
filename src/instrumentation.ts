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
}
