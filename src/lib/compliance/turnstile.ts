import "server-only";
/**
 * Cloudflare Turnstile verification.
 *
 * Called ONLY from the server. The token is rendered by the widget in the
 * browser, posted with the form, and redeemed here against Cloudflare's
 * siteverify endpoint — never from the client. A browser-side "is this token
 * valid" check proves nothing, because the attacker controls the browser.
 *
 * Tokens are SINGLE USE. Redeeming one and then replaying the same string fails
 * at Cloudflare, which is what makes a captured token useless rather than a
 * permanent bypass. The caller must therefore treat a successful verification as
 * spent: it is not cached, not retried, and not reused across requests.
 *
 * FAIL CLOSED. A network error, a timeout, a non-2xx, or a non-JSON body is a
 * rejection, not a pass. If Cloudflare is unreachable, the safe failure is "no
 * sign-in", never "sign-in allowed". Anything else turns an outage at Cloudflare
 * into an open door.
 */

/**
 * Where the token is carried.
 *
 * Cloudflare's own convention is a `cf-turnstile-response` field in the request
 * body. We send the same value in a header of the same name instead, because
 * Better Auth's client owns and serialises that body — reading it server-side
 * would mean consuming the stream the auth handler still needs. The name is
 * unchanged so the two halves are obviously the same token.
 */
const TOKEN_FIELD = "cf-turnstile-response";

/** How long to wait on siteverify before giving up and failing closed. */
const VERIFY_TIMEOUT_MS = 10_000;

/**
 * Actions, one per protected surface.
 *
 * An action is attacker-visible but not attacker-chosen — it is baked into the
 * widget — so it is a cheap, meaningful cross-check that the token was minted
 * for THIS form rather than replayed from another one on the same site.
 */
export const TURNSTILE_ACTIONS = {
  login: "login",
  pilot: "pilot",
} as const;

export type TurnstileAction = (typeof TURNSTILE_ACTIONS)[keyof typeof TURNSTILE_ACTIONS];

export interface TurnstileResult {
  ok: boolean;
  /** Safe to log. Never contains the token or the secret. */
  reason?: string;
  hostname?: string;
}

function isConfigured(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET?.trim());
}

/**
 * Hostnames the token may legitimately have been minted on.
 *
 * A production value must NOT contain `localhost` or `127.0.0.1` — siteverify
 * echoes the hostname the widget was solved on, so allowing loopback in
 * production would let a token minted against a developer's machine satisfy a
 * production check.
 */
function expectedHostnames(): Set<string> {
  return new Set(
    (process.env.TURNSTILE_HOSTNAMES ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function turnstileRequired(pathname: string): TurnstileAction | null {
  if (pathname === "/api/auth/sign-in/email") return TURNSTILE_ACTIONS.login;
  return null;
}

/**
 * Redeem a token. `token` is whatever arrived on the request; it is treated as
 * hostile input throughout.
 */
export async function verifyTurnstile(
  token: unknown,
  expectedAction: TurnstileAction,
  clientIp: string | undefined,
): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET?.trim();

  // Not configured => not enforced. This is a deliberate deployment switch: a
  // self-hosted evaluation box with no Cloudflare account must still boot and
  // still sign people in. Production sets the secret, and `preflight` should
  // refuse a production deploy that does not.
  if (!secret) return { ok: true, reason: "turnstile_not_configured" };

  if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
    return { ok: false, reason: "token_missing_or_malformed" };
  }

  const hosts = expectedHostnames();
  if (hosts.size === 0) {
    // Configured but with no allowlist: every token would fail the hostname
    // check, which looks like a broken widget rather than a config error.
    return { ok: false, reason: "turnstile_hostnames_not_configured" };
  }

  let result: Record<string, unknown>;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      body: new URLSearchParams({
        secret,
        response: token,
        ...(clientIp ? { remoteip: clientIp } : {}),
      }),
    });
    if (!res.ok) return { ok: false, reason: `siteverify_http_${res.status}` };
    result = (await res.json()) as Record<string, unknown>;
  } catch {
    // Timeout, DNS failure, TLS error, non-JSON. Fail closed.
    return { ok: false, reason: "siteverify_unreachable" };
  }

  if (result.success !== true) return { ok: false, reason: "siteverify_not_success" };
  if (result.action !== expectedAction) return { ok: false, reason: "action_mismatch" };

  const hostname = typeof result.hostname === "string" ? result.hostname.toLowerCase() : "";
  if (!hosts.has(hostname)) return { ok: false, reason: "hostname_mismatch" };

  return { ok: true, hostname };
}

export { TOKEN_FIELD as TURNSTILE_TOKEN_FIELD, isConfigured as turnstileConfigured };
