import { NextResponse } from "next/server";
import { invariantSurface } from "@/lib/flags";
import { requireOperator } from "@/lib/credits";

export const dynamic = "force-dynamic";

/**
 * The compliance invariants — the guarantees this build cannot be configured
 * out of.
 *
 * WHY THIS IS NOT ON `/api/console/features`. That route is unauthenticated on
 * purpose, and its own doc comment explains the boundary: it ships *which UI
 * variants are compiled in*, and nothing else, because a server-side flag can
 * imply a server-side secret. An invariant is the opposite kind of fact — it is
 * a statement about enforcement, and it names source files and test files.
 * Putting it there would widen the unauthenticated surface past what it already
 * discloses, for no benefit: nobody rendering a browser variant needs it.
 *
 * So the honest answer to "where do the invariants go so a reviewer can see
 * them?" is a new operator-authenticated surface, and this is it. `requireOperator`
 * is the same gate `src/app/api/console/settings` and
 * `src/app/api/console/producer-keys` use for their operator-facing GETs —
 * session-backed, role-checked — and it is deliberately not `requirePrivileged`:
 * this reads no state, changes nothing, and step-up exists for actions, not for
 * answers.
 *
 * The payload is derived from `INVARIANTS` in `src/lib/flags.ts`, and
 * `tests/surface/invariants.test.ts` proves that registry against the filesystem.
 * Nothing here is a string the route invented.
 *
 * No database is touched: an absent session is refused by the guard before any
 * handler logic runs, and the successful path is a compile-time constant.
 */
export async function GET() {
  const guard = await requireOperator();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  return NextResponse.json(
    {
      // Stated explicitly so a consumer cannot read `configurable: false` as a
      // value that happened to resolve to false today.
      note: "These are invariants, not flags. No environment variable enables or disables any of them, and `enforced` is a property of the build rather than a read.",
      invariants: invariantSurface(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
