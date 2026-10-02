import { NextResponse } from "next/server";

import { buildOpenApiDocument } from "@/lib/contracts/openapi";

export const dynamic = "force-static";

/**
 * GET /openapi — the OpenAPI 3.1 description of this integration contract.
 *
 * GENERATED, never hand-maintained: `buildOpenApiDocument()` reads
 * `src/lib/contracts/schema.ts`, which is transcribed field-by-field from the
 * real request/response code. A hand-written spec is a copy that starts
 * diverging the moment the code changes and keeps being published afterwards,
 * because nothing notices — and an OpenAPI document with one invented field name
 * is worse than no document at all, since a bank generates a client from it.
 *
 * `force-static` because the document is a pure function of the source: caching
 * it is correct, and it keeps a route handler out of the hot path. The
 * consequence is that a deploy is required for a contract change to be visible,
 * which is the behaviour a versioned contract wants anyway.
 *
 * The path is `/openapi`, not `/openapi.json`: an App Router route's URL is its
 * directory name, and the work package's allowed-paths list did not permit
 * adding a sibling `openapi.json/` directory. One canonical URL beats two copies.
 * See docs/INTEGRATION-CONTRACT.md § Machine-readable contract.
 */
export async function GET() {
  return NextResponse.json(buildOpenApiDocument(), {
    headers: {
      "Cache-Control": "public, max-age=300, must-revalidate",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
