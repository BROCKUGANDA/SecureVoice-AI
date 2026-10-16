import { NextResponse } from "next/server";
import { clientFlags } from "@/lib/flags";

export const dynamic = "force-dynamic";

/**
 * The browser-visible feature flags.
 *
 * `process.env` is replaced at build time in the client bundle, so a client
 * component cannot read FEATURE_* itself. This route ships only the flags in
 * `clientFlags()` — never a server-only one, because a flag that depends on a
 * secret (realtime) would otherwise reveal server configuration to anyone who
 * loads the console. Unauthenticated on purpose: it exposes no operator data,
 * only which UI variants are compiled in, and the console needs it before the
 * session resolves to decide whether to attempt a socket.
 *
 * Compliance guarantees are NOT here, and never will be. They are not flags:
 * four of them (`complianceDisclosure`, `complianceNoSecrets`,
 * `compliancePiiRedaction`, `webhookStrictSignatures`) were declared as flags
 * here until they were reclassified, because the code enforcing them never read
 * the flag and the registry reported a control as OFF while it still fired. The
 * truthful list, with the file:line of each enforcement and the test that proves
 * it, is served by the operator-gated `/api/console/invariants`.
 */
export function GET() {
  return NextResponse.json(clientFlags(), {
    // Flags change on deploy, not on navigation — but caching this would make a
    // flag flip invisible until the entry expired, so keep it uncached.
    headers: { "Cache-Control": "no-store" },
  });
}
