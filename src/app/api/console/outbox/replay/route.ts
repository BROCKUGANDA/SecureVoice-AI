import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOperator } from "@/lib/credits";
import { replayDeadLetter } from "@/lib/outbox";
import { db } from "@/lib/db";
import { makeFailure, type FailureCode, type FailureInit } from "@/lib/failures/envelope";
import { parseJson } from "@/lib/validation/safe-log";

function failure(code: FailureCode, init: FailureInit = {}): NextResponse {
  const f = makeFailure(code, init);
  return NextResponse.json(f.body, {
    status: f.status,
    headers: { ...f.headers, "Cache-Control": "no-store" },
  });
}

export const dynamic = "force-dynamic";

/**
 * POST /api/console/outbox/replay — manual replay of a dead-lettered bank
 * webhook. Operator-only: replay re-sends a verdict to the bank, so it is
 * exactly the kind of action an auditor would ask about. 401/403 for anyone
 * else, never a silent no-op.
 */
const schema = z.object({
  deadLetterId: z.string().min(1).optional(),
  all: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  const guard = await requireOperator();
  if (!guard.ok) {
    return failure(guard.status === 401 ? "unauthenticated" : "not_found", { detail: guard.error });
  }

  const body = await parseJson(req);
  if (body === null) return failure("malformed_request", { detail: "Invalid JSON body" });
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return failure("semantically_invalid", { detail: "deadLetterId or all=true is required" });
  }

  if (parsed.data.all) {
    const pending = await db.deadLetter.findMany({ where: { replayedAt: null }, take: 50 });
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const dl of pending) results.push({ id: dl.id, ...(await replayDeadLetter(dl.id)) });
    return NextResponse.json({ ok: true, replayed: results.filter((r) => r.ok).length, results });
  }

  const result = await replayDeadLetter(parsed.data.deadLetterId!);
  if (!result.ok) {
    return failure(result.error === "dead_letter_not_found" ? "not_found" : "state_conflict", {
      detail: result.error,
    });
  }
  return NextResponse.json({ ok: true });
}

/** GET lists dead letters so the console can show what needs replaying. */
export async function GET() {
  const guard = await requireOperator();
  if (!guard.ok) {
    return failure(guard.status === 401 ? "unauthenticated" : "not_found", { detail: guard.error });
  }
  const rows = await db.deadLetter.findMany({ orderBy: { failedAt: "desc" }, take: 50 });
  return NextResponse.json(
    { ok: true, deadLetters: rows },
    { headers: { "Cache-Control": "no-store" } },
  );
}
