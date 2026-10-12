import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/better-auth";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { recordingDownloadUrl, RECORDING_CACHE_CONTROL } from "@/lib/storage/recordings";
import { logWarn } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

/**
 * GET /api/recordings/[id]/download — a presigned URL for a call recording.
 *
 * ── The security model ───────────────────────────────────────────────────────
 * A recording is a bank customer's voice, captured during a fraud-intervention
 * call. It is PDPL personal data, and the URL that retrieves it is a bearer
 * credential: whoever holds it can fetch the audio, with no further check at the
 * object store.
 *
 * That makes three rules load-bearing:
 *
 *   1. The org is derived from the SESSION, never from the request. A query
 *      string naming another organisation is not a parameter, it is an attempt.
 *   2. The case must belong to that org, and the check is what makes the tenant
 *      prefix on the object key meaningful rather than decorative. A cross-tenant
 *      probe is answered 404 — the same bytes a row that does not exist gets — so
 *      the endpoint cannot be used to learn which case ids another tenant holds.
 *      The refusal is still recorded server-side, where it is worth having.
 *   3. The URL is short-lived (5 minutes by default, hard-capped at 15). A
 *      recording link in a browser history or a screenshot is a real but bounded
 *      exposure, not an indefinite one.
 *
 * ── Why a redirect rather than a proxy ────────────────────────────────────────
 * The audio is fetched straight from the object store by the browser. Proxying
 * it through this server would put a multi-megabyte stream on the request path
 * of a service whose whole design assumption is that it never carries bulk
 * bytes, and would make the presigned URL pointless.
 *
 * ── The failure shapes, and why each is a 4xx not a 5xx ───────────────────────
 * A missing recording is 404, a cross-tenant ask is the same 404 (see rule 2), an
 * org-less session is 403 (there is no tenant to scope the request to, which is a
 * state the caller can act on: switch organisation), and an unconfigured store is
 * 503 (the platform cannot serve this today). None of them is a server bug, so
 * none of them is a 500.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  }

  // SERVER-DERIVED tenant. Never read an orgId from the query string, the body,
  // or a header — a recording URL is a bearer credential and the tenant that
  // scopes it must come from the authenticated session.
  const orgId = session.session.activeOrganizationId ?? null;
  if (!orgId) {
    return NextResponse.json(
      {
        error: "no_active_organization",
        reason: "switch to an organisation to download recordings",
      },
      { status: 403 },
    );
  }

  const { id: caseId } = await params;

  // The case row is the authority on which tenant a recording belongs to.
  // `select` is limited to the columns needed so a recording fetch never
  // materialises a transcript it does not need.
  const caseRow = await db.case.findUnique({
    where: { id: caseId },
    select: { id: true, orgId: true, conversationId: true },
  });

  if (!caseRow) {
    return NextResponse.json({ error: "recording_not_found" }, { status: 404 });
  }

  // The tenant check, answered with the SAME 404 as a row that does not exist.
  //
  // A probe across tenants is answered indistinguishably on purpose: case ids are
  // not secret, but they are enumerable aids that appear in audit views and bank
  // payloads, and a 403 would tell a holder of any valid session which ids exist
  // at someone else's tenant. Refusing visibly is worth something to an operator
  // debugging their own access — so the distinction is kept SERVER-SIDE, in the
  // warn below, where the isolation event is auditable without being disclosed.
  if (caseRow.orgId !== orgId) {
    logWarn("[recordings] cross-tenant download refused", {
      orgId,
      caseId,
      reason: "case_belongs_to_another_organization",
    });
    return NextResponse.json({ error: "recording_not_found" }, { status: 404 });
  }

  if (!caseRow.conversationId) {
    return NextResponse.json({ error: "no_recording_for_case" }, { status: 404 });
  }

  const result = await recordingDownloadUrl({ orgId, conversationId: caseRow.conversationId });
  if (!result.ok) {
    if (result.error === "storage_not_configured") {
      return NextResponse.json(
        { error: "storage_not_configured", reason: "object storage is not configured" },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return new NextResponse(
    JSON.stringify({ url: result.url, expiresInSeconds: result.expiresInSeconds }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // The URL in the body is a bearer credential. Caching this response
        // would put a still-valid recording link in a shared cache.
        "Cache-Control": RECORDING_CACHE_CONTROL,
      },
    },
  );
}
