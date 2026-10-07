import "server-only";
/**
 * App-side half of the API gateway.
 *
 * The gateway has two halves that must agree. The EDGE half is Caddy
 * (Caddyfile, `handle /v1/*`): it terminates TLS, enforces the request-body
 * ceiling, stamps a request id and rewrites the public `/v1/...` URLs to the
 * internal `/api/v1/...` routes. This is the APP half: every `/v1` response goes
 * out with the same four headers and the same error envelope, so a bank
 * integrating against the API sees one contract regardless of which route
 * answered - and a request can be followed from the edge log to the app log to a
 * support ticket by one id.
 *
 * What it deliberately does NOT do: authentication. Each route authenticates
 * itself (producer key or HMAC); a gateway layer that was the only thing between
 * a caller and data would be one mis-ordered matcher away from none.
 */

import { NextResponse } from "next/server";
import {
  makeFailure,
  normaliseRequestId,
  type FailureCode,
  type FailureInit,
} from "@/lib/failures/envelope";

/** Bumped only for a breaking change; additive fields never bump it. */
export const API_VERSION = "1";

/** The request id Caddy / proxy.ts minted, or a fresh opaque one. Never trusts a hostile value. */
export function requestIdOf(req: Request): string {
  return normaliseRequestId(req.headers.get("x-request-id"));
}

/** Headers every gateway response carries. */
export function gatewayHeaders(requestId: string): Record<string, string> {
  return {
    "X-Request-Id": requestId,
    "X-SecureVoice-Api-Version": API_VERSION,
    // Case state and evidence are per-caller and change; no shared cache may keep them.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

export function gatewayJson(
  body: unknown,
  req: Request,
  init: { status?: number; headers?: Record<string, string> } = {},
): NextResponse {
  return NextResponse.json(body, {
    status: init.status ?? 200,
    headers: { ...gatewayHeaders(requestIdOf(req)), ...(init.headers ?? {}) },
  });
}

/** The project's one error envelope, with the gateway headers added. */
export function gatewayFailure(
  code: FailureCode,
  req: Request,
  init: FailureInit = {},
): NextResponse {
  const requestId = requestIdOf(req);
  const f = makeFailure(code, { ...init, requestId });
  return NextResponse.json(f.body, {
    status: f.status,
    headers: { ...f.headers, ...gatewayHeaders(requestId) },
  });
}
