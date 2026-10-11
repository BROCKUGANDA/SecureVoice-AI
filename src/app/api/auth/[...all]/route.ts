import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse } from "next/server";
import { auth } from "@/lib/better-auth";
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
  const forwarded = req.headers.get("x-forwarded-for");
  const clientIp = forwarded?.split(",")[0]?.trim() || undefined;

  const result = await verifyTurnstile(req.headers.get(TURNSTILE_TOKEN_FIELD), action, clientIp);
  if (result.ok) return null;

  // Coarse on purpose: enough for the UI to say "try again", not enough to tell
  // an attacker which of the four checks failed.
  return NextResponse.json(
    { error: "bot_check_failed", reason: result.reason },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

async function guarded(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  const action = turnstileRequired(pathname);

  // POST only. A GET to the same path is a session/cookie read, not a
  // credential submission; gating it would break Better Auth's own endpoints.
  if (action && req.method === "POST") {
    const blocked = await gateTurnstile(req, action);
    if (blocked) return blocked;
  }

  return upstream.POST(req);
}

export const GET = upstream.GET;
export const POST = guarded;
