import "server-only";
/**
 * Route helpers for WP-21 failure semantics and WP-12 multi-tenancy.
 *
 * Instead of wiring every route individually, these helpers make it trivial
 * to return a proper 5-field failure envelope and use scopedDb in any route.
 *
 * Usage in a route handler:
 *
 *   import { fail, ok, requireOrg, handlePrismaError } from "@/lib/route-helpers";
 *
 *   export async function POST(req: NextRequest) {
 *     // Multi-tenancy: require auth and scope the DB
 *     const auth = await requireOrg(req);
 *     if (!auth.ok) return fail(auth.failure);
 *
 *     // Use the scoped DB — queries are automatically tenant-scoped
 *     const cases = await auth.db.case.findMany();
 *
 *     // Return success
 *     return ok({ cases });
 *
 *     // Or handle errors with the proper envelope
 *     try {
 *       // ... do work ...
 *     } catch (err) {
 *       return fail(handlePrismaError(err));
 *     }
 *   }
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import {
  makeFailure,
  responseInitFor,
  type Failure,
  notFound,
  unauthenticated,
  policyPrecondition,
  stateConflict,
  semanticallyInvalid,
  internalBug,
  malformedRequest,
  dependencyUnavailable,
  shedLoad,
  rateLimited,
  crossTenantNotFound,
  newRequestId,
  scanFailure,
} from "@/lib/failures/envelope";
import { requireAuth, type Authed } from "@/lib/auth/guards";
import { Prisma } from "@/generated/prisma/client";
import { ZodError, type ZodIssue } from "zod";
import { logError } from "@/lib/validation/safe-log";

/**
 * Convert a Prisma error into a typed Failure.
 *
 * This is the single place that maps database error codes to our failure
 * envelope. Routes call this instead of guessing the right status code.
 */
export function handlePrismaError(err: unknown, requestId?: string): Failure {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
    return internalBug({ requestId });
  }

  switch (err.code) {
    case "P2025":
      // Record not found — could be cross-tenant
      return notFound({ requestId });
    case "P2002":
      // Unique constraint violation
      return makeFailure("unique_conflict", { requestId });
    case "P2003":
      // Foreign key violation
      return makeFailure("reference_conflict", { requestId });
    case "P2034":
      // Read-only transaction
      return dependencyUnavailable(5, { requestId });
    case "P2038":
      // Read timeout
      return makeFailure("statement_timeout", { requestId, retryAfterSec: 5 });
    default:
      // Unknown Prisma error — treat as internal bug
      return internalBug({ requestId, detail: `Prisma error: ${err.code}` });
  }
}

/**
 * Return a proper 5-field failure envelope as a NextResponse.
 *
 * This is the ONLY way a route should return an error. It ensures:
 * - The envelope has exactly 5 fields: code, message, retryable, requestId, docsUrl
 * - No stack traces, SQL, or internal identifiers leak
 * - The status code matches the failure code
 * - Retry-After header is emitted when required
 */
export function fail(failure: Failure): NextResponse {
  // Final safety check: scan the failure for leaks before sending
  const leaks = scanFailure(failure);
  if (leaks.length > 0) {
    logError("[route-helpers] LEAK DETECTED in failure", { leaks, message: failure.body.message });
    // Return a safe fallback
    const safe = internalBug({ requestId: failure.body.requestId });
    return NextResponse.json(safe.body, responseInitFor(safe));
  }
  return NextResponse.json(failure.body, responseInitFor(failure));
}

/**
 * Return a success response.
 */
export function ok(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

/**
 * Is this If-None-Match header satisfied by `etag`?
 *
 * RFC 7232 §2.3: the header is a comma-separated candidate list compared
 * WEAKLY, so a `W/`-prefixed candidate matches a strong ETag, and `*` matches
 * anything. Without this, a client that echoes back what it was sent (or a
 * proxy that rewrites it) would miss the 304 and re-pull the body the helper
 * exists to save.
 */
function ifNoneMatchSatisfied(ifNoneMatch: string, etag: string): boolean {
  return ifNoneMatch
    .split(",")
    .map((candidate) => candidate.trim().replace(/^W\//i, ""))
    .some((candidate) => candidate === "*" || candidate === etag);
}

/**
 * Conditional JSON response: strong ETag + `If-None-Match` revalidation, for
 * the hot authenticated GETs.
 *
 * The body is serialized HERE, not by `NextResponse.json` first, for two
 * reasons that make the ETag honest rather than decorative:
 *   1. A response body is a one-shot stream — the sha256 must be taken from
 *      the object before anything serializes it.
 *   2. The exact bytes hashed are the exact bytes served, so a client that
 *      sends the ETag back is answering for the body it actually received.
 *
 * `Cache-Control: private, no-cache` is the point of the helper (not
 * `no-store`): the client MAY keep the body, but must revalidate before use —
 * an unchanged poll becomes a body-less 304. Private, because every one of
 * these payloads is tenant-scoped and must never land in a shared cache.
 *
 * `req` may be omitted: tests invoke route handlers bare, and a response
 * without a request to revalidate against is unconditional — but it still
 * carries the ETag so the NEXT round trip can be conditional.
 */
export function etaggedJson(
  req: { headers: { get(name: string): string | null } } | undefined,
  body: unknown,
  init?: ResponseInit,
): NextResponse {
  const serialized = JSON.stringify(body);
  const etag = `"${createHash("sha256").update(serialized).digest("hex")}"`;
  const headers = new Headers(init?.headers);
  headers.set("ETag", etag);
  headers.set("Cache-Control", "private, no-cache");
  headers.set("Content-Type", "application/json");
  const ifNoneMatch = req?.headers.get("if-none-match") ?? null;
  if (ifNoneMatch !== null && ifNoneMatchSatisfied(ifNoneMatch, etag)) {
    // A 304 carries no body, so a Content-Type describing it would be a lie.
    const notModified = new Headers(headers);
    notModified.delete("Content-Type");
    return new NextResponse(null, { status: 304, headers: notModified });
  }
  return new NextResponse(serialized, { ...init, headers });
}

/**
 * Require authentication and return a scoped DB client.
 *
 * Returns Authed (with scoped db) or a Failure for unauthenticated requests.
 */
export async function requireOrg(
  req: NextRequest,
): Promise<Authed | { ok: false; failure: Failure }> {
  const cookie = req.headers.get("cookie");
  const auth = await requireAuth(cookie);
  if (!auth.ok) {
    return { ok: false, failure: unauthenticated() };
  }
  return auth;
}

/**
 * Require authentication with a specific capability.
 */
export async function requireOrgWithCapability(
  req: NextRequest,
  capability: string,
): Promise<Authed | { ok: false; failure: Failure }> {
  const cookie = req.headers.get("cookie");
  const auth = await requireAuth(cookie);
  if (!auth.ok) {
    return { ok: false, failure: unauthenticated() };
  }
  // Check capability
  const { assertCapability, CapabilityError } = await import("@/lib/auth/rbac");
  try {
    assertCapability(auth.role, capability as any);
  } catch (err) {
    if (err instanceof CapabilityError) {
      return { ok: false, failure: policyPrecondition({ detail: err.message }) };
    }
    throw err;
  }
  return auth;
}

/**
 * Read the issue array off a Zod error, or `null` when this is not one.
 *
 * Zod **4** renamed the field: `ZodError.errors` (Zod 3) is now `ZodError.issues`.
 * Keying on `.errors` therefore matched nothing in this repo and every real
 * validation failure fell through to the generic 500 handler instead of the
 * promised 422. Both spellings are accepted, with `issues` first, so the
 * function works against either major version.
 *
 * The structural fallback is deliberate rather than lazy: `instanceof` fails
 * whenever two copies of zod are resolved in one process (a transitive
 * dependency can pull its own), and in that case a genuine ZodError would be
 * misclassified as "not a validation error" — the exact failure this guard
 * exists to catch. An array-valued `issues` on an Error is unambiguous enough
 * to accept; a non-array is refused, so an unrelated error carrying
 * `issues: "boom"` is still not treated as a validation failure.
 */
function zodIssuesOf(err: unknown): ZodIssue[] | null {
  if (err instanceof ZodError) return err.issues;
  if (
    err instanceof Error &&
    "issues" in err &&
    Array.isArray((err as { issues: unknown }).issues)
  ) {
    return (err as { issues: ZodIssue[] }).issues;
  }
  // Zod 3's spelling, kept so this keeps working if the major is ever reverted.
  if (
    err instanceof Error &&
    "errors" in err &&
    Array.isArray((err as { errors: unknown }).errors)
  ) {
    return (err as { errors: ZodIssue[] }).errors;
  }
  return null;
}

/**
 * Handle Zod validation errors and return a proper 422 response.
 */
export function handleZodError(err: unknown, requestId?: string): Failure | null {
  const issues = zodIssuesOf(err);
  if (issues === null) return null;
  const messages = issues
    // `path` is typed as always-present on a ZodIssue, but the Zod 3 branch and
    // a hand-rolled error can omit it — an issue with no path is a root-level
    // failure, not a reason to throw here.
    .map(
      (issue) =>
        `${(issue.path ?? []).map((p) => String(p)).join(".") || "root"}: ${issue.message}`,
    )
    .slice(0, 3)
    .join("; ");
  return semanticallyInvalid({ requestId, detail: messages });
}

// Re-export common failure constructors for convenience
export {
  notFound,
  unauthenticated,
  policyPrecondition,
  stateConflict,
  semanticallyInvalid,
  internalBug,
  malformedRequest,
  dependencyUnavailable,
  shedLoad,
  rateLimited,
  crossTenantNotFound,
  newRequestId,
};
