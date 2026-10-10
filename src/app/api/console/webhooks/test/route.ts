import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/credits";
import { canonicalJson, signPayload, WEBHOOK_SIGNATURE_HEADER, SCHEMA_VERSION } from "@/lib/outbox";
import { resolveVendorEndpoint, assertVendorUrlDeliverable } from "@/lib/vendor-endpoint";
import { unprocessable } from "@/lib/api-errors";

export const dynamic = "force-dynamic";

/** A test delivery must not hold a wizard step open. */
const TEST_TIMEOUT_MS = 3000;

/**
 * "Send test webhook" — prove the tenant's endpoint is reachable BEFORE any real
 * verdict depends on it.
 *
 *   POST /api/console/webhooks/test → { ok, status, ms, error? }
 *
 * It signs and sends a REAL envelope, byte-for-byte the shape the delivery worker
 * sends (`canonicalJson` + `signPayload` from src/lib/outbox.ts), because a test
 * that posts something the real sender would not is worth nothing: the bank would
 * pass this check and then reject every actual event.
 *
 * Two guards, both of which the production path has and this must not skip:
 *
 *  - The endpoint is resolved with `requireSecret: true`, so an endpoint with no
 *    usable signing key is refused rather than signed with the platform secret.
 *  - The URL is re-validated immediately before delivery (`assertVendorUrlDeliverable`),
 *    because DNS can change between the moment it was saved and this moment.
 *
 * The body carries no customer data — a placeholder case reference and the words
 * "test". A test delivery is not a reason to send a real transcript to an
 * endpoint the operator has only just typed.
 */
export async function POST(req: NextRequest) {
  const guard = await requireOperator();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const orgId = guard.profile.orgId;
  if (!orgId) {
    return NextResponse.json(
      { error: "No organization is linked to this account, so there is no endpoint to test." },
      { status: 409 },
    );
  }

  const resolved = await resolveVendorEndpoint(orgId);
  if (!resolved.ok) {
    // "no_endpoint" is a configuration state, not a failure of the network — it
    // gets a distinct message so the wizard can tell the operator to finish the
    // previous step rather than to check their firewall.
    return NextResponse.json(
      { ok: false, error: resolved.reason, code: resolved.code },
      { status: 422 },
    );
  }

  const endpoint = resolved.endpoint;
  const urlOk = await assertVendorUrlDeliverable(endpoint.url);
  if (!urlOk.ok) return unprocessable(urlOk.reason, "endpoint_not_deliverable");

  const body = canonicalJson({
    schema_version: SCHEMA_VERSION,
    event_id: `test-${Date.now()}`,
    event_type: "securevoice.webhook_test",
    case_ref: "TEST-EVENT",
    org_id: orgId,
    occurred_at: new Date().toISOString(),
    data: {
      message: "SecureVoice test delivery. No customer data is included in this event.",
    },
  });

  const started = Date.now();
  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_SIGNATURE_HEADER]: signPayload(body, Math.floor(started / 1000), endpoint.secret),
      },
      body,
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    const ms = Date.now() - started;
    // A 4xx/5xx is reported as a FAILED test with the status visible, rather than
    // an exception: "your endpoint answered 401" is the single most useful thing
    // an operator can be told here.
    return NextResponse.json({
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      ms,
      endpoint: endpoint.url,
      ...(res.ok ? {} : { error: `endpoint answered HTTP ${res.status}` }),
    });
  } catch (err) {
    const ms = Date.now() - started;
    const timedOut =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return NextResponse.json({
      ok: false,
      status: 0,
      ms,
      endpoint: endpoint.url,
      error: timedOut
        ? `no answer within ${TEST_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err),
    });
  }
}
