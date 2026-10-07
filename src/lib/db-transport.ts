/**
 * A production database connection must be encrypted.
 *
 * `DATABASE_URL` is passed to the pool verbatim, so a URL without an SSL mode
 * sends every case row, transcript and phone number across the network in
 * plaintext — while everything above it (Caddy, HSTS, CSP) makes the deployment
 * LOOK TLS-protected. The one place a plaintext hop is defensible is a private
 * network the operator controls, so that case is allowed only by explicit
 * opt-in rather than by silence.
 *
 * Pure: no I/O, no server imports. The env is injectable so the gate's own
 * test can drive every branch without touching process.env.
 */
export function assertTransportIsEncrypted(
  url: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!url) return; // the pool's own error is more specific than ours
  if (env.NODE_ENV !== "production") return;
  if (env.DB_ALLOW_PLAINTEXT_PRIVATE_NETWORK === "true") return;

  const mode = /[?&]sslmode=([^&]+)/.exec(url)?.[1]?.toLowerCase();
  const encrypted = mode === "require" || mode === "verify-ca" || mode === "verify-full";
  if (!encrypted) {
    throw new Error(
      "DATABASE_URL must set sslmode=require (or verify-ca/verify-full) in production. " +
        "Case rows, transcripts and phone numbers would otherwise cross the network in " +
        "plaintext. On a private network you control, set " +
        "DB_ALLOW_PLAINTEXT_PRIVATE_NETWORK=true to acknowledge that explicitly.",
    );
  }
}
