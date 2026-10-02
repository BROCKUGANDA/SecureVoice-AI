import "server-only";
/**
 * The activity feed's read model — one query, org-scoped, resumable.
 *
 * Extracted from the SSE route so the two properties that matter are testable
 * without a browser:
 *
 *   1. **Tenancy.** An org-scoped read can never return another org's rows. The
 *      scope is a required argument, not an optional filter, so a new caller
 *      cannot forget it. Org-less sessions see the un-namespaced default rows
 *      only — they are not "see everything".
 *   2. **Resumability.** The cursor is `(createdAt, id)`, not `createdAt`
 *      alone: two rows can share a millisecond, and a timestamp-only cursor
 *      silently drops the second one. That is the bug that makes a reconnect
 *      lose an event, and it is invisible until you test for it.
 */

import { db } from "@/lib/db";

export type ActivityRow = {
  id: string;
  callRef: string;
  action: string;
  intent: string | null;
  redactedText: string | null;
  createdAt: Date;
  orgId: string | null;
};

export type ActivityCursor = { createdAt: Date; id: string };

export type OrgScope = { orgId: string } | { shared: true };

/** Build the scope predicate. Org-less sessions get the default rows only. */
export function scopeWhere(scope: OrgScope) {
  return "orgId" in scope
    ? { orgId: scope.orgId }
    : { OR: [{ orgId: null }, { orgId: "default" }] };
}

export async function fetchActivitySince(args: {
  scope: OrgScope;
  cursor?: ActivityCursor;
  take?: number;
}): Promise<ActivityRow[]> {
  const take = Math.min(Math.max(args.take ?? 20, 1), 100);
  const cursor = args.cursor;
  return db.auditLog.findMany({
    where: {
      AND: [
        cursor
          ? {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { gt: cursor.id } },
              ],
            }
          : {},
        scopeWhere(args.scope),
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      callRef: true,
      action: true,
      intent: true,
      redactedText: true,
      createdAt: true,
      orgId: true,
    },
    take,
  }) as Promise<ActivityRow[]>;
}

export function nextCursor(rows: ActivityRow[]): ActivityCursor | undefined {
  const last = rows[rows.length - 1];
  return last ? { createdAt: last.createdAt, id: last.id } : undefined;
}
