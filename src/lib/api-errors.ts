import "server-only";
/**
 * Shared error-response helpers — one place to build consistent API error
 * bodies so every route returns the same shape.
 *
 * Usage in route handlers:
 *   return badRequest("Invalid JSON body");
 *   return unauthorized("Sign in required");
 *   return forbidden("Operator access required");
 *   return notFound("Case not found");
 *   return unprocessable("Invalid signal: riskScore must be 0.5–0.99");
 *   return paymentRequired("Insufficient credits", { credits: 0 });
 *   return tooManyRequests("Rate limit exceeded", 30);
 *   return upstreamError("Speech synthesis unavailable");
 *   return internalError("Case recording failed");
 */

import { NextResponse } from "next/server";
import type { ConsumeResult } from "@/lib/ratelimit";
import { rateLimitHeaders } from "@/lib/ratelimit";

export function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

export function unauthorized(error = "Sign in required — open the sign-in page."): NextResponse {
  return NextResponse.json({ error }, { status: 401 });
}

export function forbidden(error = "Operator access required."): NextResponse {
  return NextResponse.json({ error }, { status: 403 });
}

export function notFound(error = "Not found"): NextResponse {
  return NextResponse.json({ error }, { status: 404 });
}

/**
 * Map a Zod failure to a machine-readable code.
 *
 * A strict schema that refuses an unknown field is a different event from one
 * that refuses a missing required field, and a bank integrating against these
 * tools branches on the distinction — so the reason travels in the body, not
 * only in prose. (WP-22: unknown fields are rejected, never passed through.)
 */
export function schemaErrorCode(error: { issues?: readonly { code?: string }[] }): string {
  const codes = new Set((error.issues ?? []).map((i) => i.code));
  if (codes.has("unrecognized_keys")) return "unknown_field";
  if (codes.size === 0) return "invalid_payload";
  return "invalid_payload";
}

export function unprocessable(error: string, code = "invalid_payload"): NextResponse {
  return NextResponse.json({ error, code }, { status: 422 });
}

export function paymentRequired(error: string, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json(
    { error, ...extra },
    { status: 402, headers: { "X-Credits-Balance": "0" } },
  );
}

/**
 * A `429` from the token-bucket limiter.
 *
 * Pass the `ConsumeResult`, not a rounded number: the result is the only thing
 * that still knows the bucket's capacity, and `X-RateLimit-Limit` / `-Remaining`
 * / `-Reset` are what a client with a queue of signals actually needs. A bare
 * `Retry-After` says when to come back; it does not say how much room is left
 * when you do.
 */
export function tooManyRequests(
  error = "Rate limit exceeded; retry later.",
  rl?: ConsumeResult | number,
): NextResponse {
  let headers: Record<string, string>;
  if (typeof rl === "number") {
    // A budget refusal (the monthly upstream spend breaker), not a windowed
    // bucket: there is no per-window capacity to report, so `Retry-After` and an
    // empty remaining are the honest answer. Emitting a fabricated
    // `X-RateLimit-Limit` here would be a client parsing a number that means
    // nothing.
    headers = {
      "Retry-After": String(Math.max(1, Math.ceil(rl))),
      "X-RateLimit-Remaining": "0",
    };
  } else if (rl) {
    headers = rateLimitHeaders(rl);
  } else {
    headers = { "Retry-After": "60", "X-RateLimit-Remaining": "0" };
  }
  return NextResponse.json({ error }, { status: 429, headers });
}

export function upstreamError(error: string, status = 503): NextResponse {
  return NextResponse.json({ error }, { status });
}

export function internalError(error = "Internal server error"): NextResponse {
  return NextResponse.json({ error }, { status: 500 });
}

/** Parse a JSON body safely. Returns null on parse failure. */
export async function parseJson<T = unknown>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}
