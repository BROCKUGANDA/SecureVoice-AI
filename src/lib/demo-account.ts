/**
 * The demo account, defined once.
 *
 * Client-safe by design (no `server-only`, no database) so the SAME predicate
 * decides two different things: whether the marketing walkthrough is nagged with
 * a security banner, and whether a payment action is allowed to proceed without
 * a second factor. Two definitions of "is this the demo" is one too many — the
 * server would exempt an account the UI still nags, or, worse, the UI would hush
 * a banner for an account the server still refuses to charge.
 *
 * The variable is `NEXT_PUBLIC_DEMO_LOGIN_EMAIL`, the one `src/views/Auth.tsx:69`
 * already reads to offer the one-click demo sign-in, so the exemption is
 * configured exactly where the credential is. It accepts a comma-separated list.
 *
 * Unset means NOBODY is exempt: fail closed, and let a deployment opt in
 * explicitly.
 *
 * NOT the `demo` plan tier. `planTierFor` resolves an undeclared organisation to
 * `"demo"` (`src/lib/abuse/tiers.ts:39-41`), so a tier-based exemption would
 * hand every tenant that has never declared a tier a pass around second factor
 * on the money path, widening silently as customers are created.
 */

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** The configured demo addresses. Empty when the variable is unset. */
export function demoEmails(): Set<string> {
  return new Set(
    (process.env.NEXT_PUBLIC_DEMO_LOGIN_EMAIL ?? "")
      .split(",")
      .map(normalize)
      .filter((email) => email !== ""),
  );
}

export function isDemoAccount(email: string | null | undefined): boolean {
  const candidate = normalize(email ?? "");
  // An empty address can never match, so an identity with no email is not a
  // demo account by default — the failure mode is "asked for 2FA", never "skipped".
  if (candidate === "") return false;
  return demoEmails().has(candidate);
}
