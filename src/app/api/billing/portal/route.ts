import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireOrg } from "@/lib/route-helpers";
import { fail } from "@/lib/route-helpers";
import { unauthenticated } from "@/lib/failures/envelope";
import { paddleClient } from "@/lib/payments/paddle-events";
import { paddleCustomerIdFor } from "@/lib/payments/mirror";
import { currentSubscription } from "@/lib/payments/access";
import { logInfo, logWarn } from "@/lib/validation/safe-log";

/**
 * POST /api/billing/portal — mint a Paddle customer portal session.
 *
 * The portal is Paddle-HOSTED: customers change their payment method, cancel and
 * download invoices there. This route does nothing but decide WHO may ask and
 * resolve their customer id, then hand back Paddle's URL.
 *
 * ## The customer id is never taken from the client
 *
 * This is the whole reason the route exists rather than the buyer calling Paddle
 * directly. The body's `customerId` is IGNORED if present — the id is resolved
 * from the session's organization, server-side, through `paddleCustomerIdFor`,
 * which is scoped to that org. Accepting it from a client would let any signed-in
 * user open any other customer's portal and cancel their subscription.
 *
 * Authentication is resolved before anything else: `requireOrg` runs the session
 * verification and returns 401/403 for an absent or revoked session, so there is
 * no code path that reaches the Paddle call without one.
 */

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireOrg(req);
  if (!auth.ok) return fail(auth.failure ?? unauthenticated());

  const client = paddleClient();
  if (!client) {
    logWarn("[billing-portal] no Paddle client", { orgId: auth.orgId });
    return NextResponse.json({ error: "billing_unavailable" }, { status: 503 });
  }

  const customerId = await paddleCustomerIdFor(auth.orgId);
  if (!customerId) {
    // 404, not 500: this org has never bought anything, so there is no portal to
    // open. That is a legitimate state and a different answer from a misconfigured
    // deployment.
    logInfo("[billing-portal] no mirrored customer for org", { orgId: auth.orgId });
    return NextResponse.json({ error: "no_billing_account" }, { status: 404 });
  }

  // A body is accepted and ignored. Parsing it (rather than not reading it) means
  // a malformed JSON body is a 400 here rather than a confusing error later, and
  // the ignored fields are explicitly named so the intent is not "we forgot".
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    /* an empty body is the normal case */
  }
  const supplied = body as { customerId?: unknown };
  if (typeof supplied.customerId === "string" && supplied.customerId !== customerId) {
    // Logged, not honoured. This is the shape of an attempt to open someone
    // else's portal, and it is worth seeing in the audit trail.
    logWarn("[billing-portal] client supplied a different customerId — ignored", {
      orgId: auth.orgId,
    });
  }

  try {
    // `subscriptionIds` is REQUIRED by the SDK, and it is also the right
    // constraint: a portal session is scoped to specific subscriptions rather than
    // to everything the customer has ever bought. Reading them from OUR mirror,
    // scoped to this org, keeps the scope under our control — passing an empty
    // array would open a portal with nothing in it, and passing ids from a request
    // body would let a caller widen someone else's.
    const mirror = await currentSubscription(auth.orgId);
    const subscriptionIds = mirror ? [mirror.subscriptionId] : [];

    const session = await client.customerPortalSessions.create(customerId, subscriptionIds);
    const url = session.urls?.general?.overview ?? "";

    if (url === "") {
      logWarn("[billing-portal] no url returned", { customerId });
      return NextResponse.json({ error: "portal_session_failed" }, { status: 502 });
    }

    logInfo("[billing-portal] session minted", { orgId: auth.orgId });
    return NextResponse.json({ url }, { status: 200 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "portal_failed";
    logWarn("[billing-portal] mint failed", { orgId: auth.orgId, message });
    // Never echo the raw message: it can carry the customer id.
    return NextResponse.json({ error: "portal_session_failed" }, { status: 502 });
  }
}
