import { NextResponse } from "next/server";

import { buildAsyncApiDocument } from "@/lib/contracts/asyncapi";

export const dynamic = "force-static";

/**
 * GET /asyncapi — the OUTBOUND webhook surface, as AsyncAPI 3.0.
 *
 * Generated from `src/lib/contracts/schema.ts` for the same reason the OpenAPI
 * document is: a second hand-written copy of the same envelope is a second thing
 * to forget to update.
 *
 * It is served rather than written to `docs/asyncapi.json` on purpose. A
 * checked-in JSON artefact is a snapshot with no build step behind it; it would
 * be accurate on the day it was written and silently wrong after the first
 * envelope change, and nothing in CI would notice. A route that derives itself
 * from the source cannot be stale — and it means there is exactly one URL to put
 * in an integration runbook.
 */
export async function GET() {
  return NextResponse.json(buildAsyncApiDocument(), {
    headers: {
      "Cache-Control": "public, max-age=300, must-revalidate",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
