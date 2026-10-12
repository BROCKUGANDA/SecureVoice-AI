import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/credits";
import { db } from "@/lib/db";
import { logError } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

/**
 * GET /api/console/mail — the received-email inbox, operator-only.
 *
 * The RECEIVE half of the email surface, surfaced in the console so an operator
 * sees a bank's reply without logging into the mailbox. Rows are written by
 * `POST /api/email/inbound` (the Resend `email.received` webhook).
 *
 * Deliberately NOT org-scoped: mail arrives at platform mailboxes
 * (support@ / legal@ / founder@), not at a tenant. Access is therefore gated on
 * the operator role, exactly like `/api/console/dead-letter`, rather than on an
 * org predicate that would silently hide every row.
 *
 * Why it cannot move to the database-enforced path (`withTenantScope`) either,
 * even though `EmailInbound` DOES carry `orgId` and does have a `tenant_scope`
 * policy (added by `9zzzzzzzzzzzzzzzzzzzzzzz_tenant_rls_coverage`):
 *
 *   · Nothing populates that column. The only writer, `POST /api/email/inbound`,
 *     cannot attribute an inbound message to an organisation — the sender is a
 *     customer answering support@ — so it stores every row with `orgId` NULL.
 *     The policy is `"orgId" IS NOT NULL AND "orgId" = current_setting('app.org_id')`,
 *     so inside a tenant scope this route would return ZERO rows for every
 *     organisation: an inbox that is empty, not an inbox that is bounded. That is
 *     a behavioural break presented as a security win.
 *   · The org-less arm is not available either: `EmailInbound` is in neither
 *     `TENANTED_MODELS` nor `PLATFORM_MODELS` (src/lib/tenancy/guard.ts), so
 *     `scopedDb()` refuses the model with `unregistered_model` rather than
 *     guessing a scope for it.
 *
 * Both facts are asserted — the first in tests/tenancy/rls-enforcement.test.ts
 * (a real inbound row is invisible to `sv_tenant`), the second in
 * tests/tenancy/org-models.test.ts — so if inbound mail ever IS correlated to a
 * tenant, those gates flip and this route becomes convertible.
 *
 * Read-only. There is no mutation here: replying is a human action in the
 * mailbox, and a half-built reply path that writes nothing would be worse than
 * none.
 */
const LIMIT = 25;

export async function GET() {
  const guard = await requireOperator();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  try {
    const rows = await db.emailInbound.findMany({
      orderBy: { receivedAt: "desc" },
      take: LIMIT,
      select: {
        id: true,
        messageId: true,
        recipient: true,
        fromEmail: true,
        fromName: true,
        subject: true,
        // A preview only. The body is stored redacted, and the list view has no
        // reason to ship 20k of it to the browser.
        bodyText: true,
        attachmentNames: true,
        receivedAt: true,
      },
    });

    return NextResponse.json(
      {
        ok: true,
        mailboxes: ["support", "legal", "founder"],
        messages: rows.map((r) => ({
          ...r,
          receivedAt: r.receivedAt.toISOString(),
          preview: r.bodyText.slice(0, 240),
          attachments: JSON.parse(r.attachmentNames) as string[],
          bodyText: undefined,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    // The table is new (migration 20261011071127). A deployment that has not
    // run it yet must degrade to an empty inbox, not a 500 on the console.
    logError("[console/mail] inbox read failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: true, mailboxes: ["support", "legal", "founder"], messages: [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
