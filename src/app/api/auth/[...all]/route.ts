import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse } from "next/server";
import { auth } from "@/lib/better-auth";
import { isTrustedOrigin, trustedOriginsFromEnv } from "@/lib/auth/origins";
import {
  checkBadActor,
  forgiveSource,
  recordStrike,
  timeUntilStrikesBelow,
} from "@/lib/abuse/bad-actor";
import { logWarn } from "@/lib/validation/safe-log";
import {
  TURNSTILE_TOKEN_FIELD,
  turnstileRequired,
  verifyTurnstile,
} from "@/lib/compliance/turnstile";

// Better Auth's adapter returns one function per HTTP method. Destructure rather
// than wrap a single callable — there isn't one, and calling the object fails.
const upstream = toNextJsHandler(auth);

/**
 * Turnstile gate in front of the sign-in path.
 *
 * WHY A HEADER, NOT THE FORM FIELD: Cloudflare's convention is
 * `cf-turnstile-response` in the request body, but Better Auth's client posts
 * JSON and owns that body. Reading it here would mean parsing — and either
 * consuming the stream the handler still needs, or buffering it. The header
 * carries the same token, is set by our own client on our own origin, and needs
 * no body access at all. The name matches Cloudflare's so the two are obviously
 * the same value to anyone reading both halves.
 *
 * WHY HERE AND NOT IN MIDDLEWARE: src/proxy.ts runs before the route and already
 * applies the pre-auth rate limit, but it cannot inspect a POST body without
 * consuming it. This is the first point where the header is available.
 *
 * The check is additive. Credential verification, lockout and session creation
 * are untouched and still run for every request that passes.
 */
async function gateTurnstile(
  req: Request,
  action: NonNullable<ReturnType<typeof turnstileRequired>>,
): Promise<NextResponse | null> {
  const result = await verifyTurnstile(
    req.headers.get(TURNSTILE_TOKEN_FIELD),
    action,
    clientIpOf(req),
  );
  if (result.ok) return null;

  // Coarse on purpose: enough for the UI to say "try again", not enough to tell
  // an attacker which of the four checks failed.
  return NextResponse.json(
    { error: "bot_check_failed", reason: result.reason },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * The failed-credential budget, enforced with the platform's own bad-actor
 * ladder (`src/lib/abuse/bad-actor.ts`) — the one built for forged Twilio
 * webhooks, reused rather than duplicated.
 *
 * Better Auth's `rateLimit` (30 requests / 60 s, database-backed) is a throughput
 * ceiling: it treats a person mistyping once and someone running a password list
 * as the same traffic, and it does not escalate.
 *
 * `sentinel()` is not this either. It is a connection to the hosted Better Auth
 * Infra service, and `sentinel()` with no options resolves no `apiUrl`, `kvUrl`
 * or `apiKey` — so none of its checks can run. Believing that call locks accounts
 * out is how a deployment ships believing it has a lockout when it has none.
 */
const AUTH_FAILED_MAX = Number(process.env.AUTH_FAILED_LOGIN_MAX ?? 5);

function clientIpOf(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function refusedCredentialSource(retryAfterMs: number): NextResponse {
  return NextResponse.json(
    { error: "too_many_failed_signins" },
    {
      status: 429,
      headers: {
        "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
        "Cache-Control": "no-store",
      },
    },
  );
}

async function guarded(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  const action = turnstileRequired(pathname);

  // A credential POST whose `Origin` Better Auth will refuse. Logged here because
  // the refusal itself is silent: the browser gets two words — `Invalid origin` —
  // and the server gets nothing, so the operator's only lead is a screenshot. The
  // log names both sides of the mismatch and the env var that closes it.
  //
  // Diagnostic only. The decision stays Better Auth's, because it is the code that
  // has to agree with the allowlist; refusing here as well would let the two
  // definitions of "trusted" drift and leave a request refused by neither.
  if (req.method === "POST") {
    const origin = req.headers.get("origin");
    const allowlist = trustedOriginsFromEnv().origins;
    if (origin && !isTrustedOrigin(origin, allowlist)) {
      logWarn("[auth] credential request from an origin outside the CSRF allowlist", {
        action,
        rejectedOrigin: origin,
        trustedOrigins: allowlist.join(" "),
        fix: "add this origin to BETTER_AUTH_TRUSTED_ORIGINS, or point BETTER_AUTH_URL at the host users actually reach",
      });
    }
  }

  // POST only. A GET to the same path is a session/cookie read, not a
  // credential submission; gating it would break Better Auth's own endpoints.
  if (!action || req.method !== "POST") return upstream.POST(req);

  const key = `auth:${clientIpOf(req)}`;
  const before = checkBadActor(key);
  if (before.action === "block" || before.strikes >= AUTH_FAILED_MAX) {
    logWarn("[auth] sign-in refused — source is over the failed-credential budget", {
      action,
      state: before.action,
      strikes: before.strikes,
    });
    // A ladder block carries its own lift time; a budget refusal is when the
    // strikes that earned it decay out of the window.
    return refusedCredentialSource(
      before.retryAfterMs ?? timeUntilStrikesBelow(key, AUTH_FAILED_MAX),
    );
  }

  const blocked = await gateTurnstile(req, action);
  if (blocked) return blocked;

  const res = await upstream.POST(req);

  if (res.status >= 200 && res.status < 300) {
    // Verified credentials end the suspicion, so a shared egress address is not
    // punished for someone else's typos.
    forgiveSource(key);
    return res;
  }

  // Strike on a rejected credential, not on a rejected bot check: the 403 above
  // came from Turnstile, and conflating the two would let a failing CAPTCHA
  // lock a whole office out of their bank console.
  if (res.status === 401 || res.status === 403) {
    const after = recordStrike(key, 1);
    if (after.action === "block") {
      logWarn("[auth] source blocked by the bad-actor ladder", {
        action,
        strikes: after.strikes,
        blockedForMs: after.retryAfterMs ?? 0,
      });
    }
  }
  return res;
}

export const GET = upstream.GET;
export const POST = guarded;
