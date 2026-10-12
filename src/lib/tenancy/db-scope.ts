import "server-only";
/**
 * Database-enforced tenant isolation, for the queries that opt into it.
 *
 * ── What this adds over the application-layer guard ──────────────────────────
 * `src/lib/tenancy/guard.ts` builds a Prisma client extension that injects an
 * `orgId` predicate into every query — good, and proven by
 * `tests/tenancy/*`. It is still application logic: a forgotten `.use()`, a raw
 * query, or a new route that reaches for bare `db` reopens the hole, and nothing
 * at the database notices.
 *
 * This module is the other kind of control. Inside the transaction, the session
 * becomes `sv_tenant` — a role with neither `BYPASSRLS` nor superuser — and
 * `app.org_id` is pinned. The row-level policies from migration
 * `9zzzzzzzzzzzzzzzzzzzzzz_tenant_rls` then decide what is readable and writable,
 * below the application, below the ORM, and below any code path someone forgets
 * to scope. A missing predicate stops being a leak and becomes zero rows.
 *
 * ── Why the application role cannot be the tenant role ───────────────────────
 * This deployment connects as a role that IS a superuser with BYPASSRLS (asserted
 * live by `tests/tenancy/rls-enforcement.test.ts`, not assumed). Policies do not
 * apply to such a role at all, so simply turning RLS on would have changed
 * nothing while looking like it had. `SET LOCAL ROLE` is what makes the guard bind
 * without moving every connection onto a least-privilege user — which is the
 * correct end state for a sovereign deployment and is recorded as remaining work
 * rather than claimed here.
 *
 * `SET LOCAL` (not `SET`) is mandatory: the pool reuses connections, and a session
 * variable that outlives the transaction would hand the next, unrelated query this
 * tenant's identity.
 */
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { logWarn } from "@/lib/validation/safe-log";

/** The role a scoped transaction runs as. A constant, never caller input. */
export const TENANT_ROLE = "sv_tenant" as const;

export type TenantScopeReport = {
  /** Role the current session ran as inside the scope; `sv_tenant` means the switch worked. */
  effectiveRole: string;
  /** True when the CONNECTING role skips policies — i.e. RLS needs SET ROLE to bind. */
  connectingRoleBypassesRls: boolean;
  /** Org-bearing base tables, and how many of them have row security enabled. */
  orgTables: number;
  orgTablesWithRls: number;
  /** Tables a tenant can see rows from despite the policies, i.e. unprotected. */
  unprotectedTables: string[];
};

/**
 * Run `fn` as one tenant, enforced by the database.
 *
 * @param orgId the tenant whose rows are reachable. Required: an empty value
 *              would run under a role whose policies match nothing, which reads
 *              as "the table is empty" — a confusing failure, so it is refused.
 */
export async function withTenantScope<T>(
  orgId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!orgId) {
    throw new Error(
      "withTenantScope requires an orgId — an unscoped tenant transaction would see zero rows and look like an empty database",
    );
  }
  return db.$transaction(
    async (tx) => {
      // A bind parameter is legal here and illegal in `SET ... = $1`, which is why
      // the GUC goes through set_config(). The third argument is "local to the
      // transaction".
      await tx.$executeRaw`SELECT set_config('app.org_id', ${orgId}, true)`;
      // Role names are identifiers and cannot be parameterised. This one is a
      // literal above, not a value from a request, so there is nothing to inject.
      await tx.$executeRawUnsafe(`SET LOCAL ROLE "${TENANT_ROLE}"`);
      try {
        return await fn(tx);
      } finally {
        // Belt and braces for a pooled connection: `SET LOCAL` already reverts at
        // commit or rollback, and this makes the revert independent of that.
        await tx.$executeRawUnsafe("RESET ROLE").catch(() => undefined);
      }
    },
    { maxWait: 30_000, timeout: 30_000 },
  );
}

/**
 * Isolation posture, read from the live catalog.
 *
 * Reported so that "RLS is on" can never again mean "a migration exists": the
 * numbers are the policies' actual coverage and the connecting role's actual
 * attributes.
 */
export async function tenantScopeReport(): Promise<TenantScopeReport> {
  const rows = await db.$queryRaw<
    {
      effective_role: string;
      bypass: boolean;
      org_tables: number;
      guarded: number;
      unprotected: string | null;
    }[]
  >`
    WITH org_cols AS (
      SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
      WHERE c.table_schema = 'public'
        AND c.column_name = 'orgId'
        AND tb.table_type = 'BASE TABLE'
    ),
    catalog AS (
      SELECT k.relname, k.relrowsecurity
      FROM pg_class k
      WHERE k.relkind = 'r' AND k.relnamespace = 'public'::regnamespace
    )
    SELECT
      current_user AS effective_role,
      (SELECT usesuper OR usebypassrls FROM pg_user WHERE usename = current_user LIMIT 1) AS bypass,
      (SELECT count(*)::int FROM org_cols) AS org_tables,
      (SELECT count(*)::int FROM org_cols o JOIN catalog c ON c.relname = o.table_name
        WHERE c.relrowsecurity) AS guarded,
      (SELECT string_agg(o.table_name, ',' ORDER BY o.table_name)
         FROM org_cols o JOIN catalog c ON c.relname = o.table_name
        WHERE NOT c.relrowsecurity) AS unprotected
  `;
  const row = rows[0];
  if (!row) {
    logWarn("[tenancy] catalog query returned no row — reporting the closed posture", {});
    return {
      effectiveRole: "unknown",
      connectingRoleBypassesRls: true,
      orgTables: 0,
      orgTablesWithRls: 0,
      unprotectedTables: [],
    };
  }
  return {
    effectiveRole: row.effective_role,
    connectingRoleBypassesRls: !!row.bypass,
    orgTables: row.org_tables,
    orgTablesWithRls: row.guarded,
    unprotectedTables: (row.unprotected ?? "").split(",").filter(Boolean),
  };
}
