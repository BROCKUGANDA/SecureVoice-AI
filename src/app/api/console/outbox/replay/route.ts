import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperator } from "@/lib/credits";
import { replayDeadLetter } from "@/lib/outbox";
import { db } from "@/lib/db";
import { badRequest, parseJson } from "@/lib/api-errors";

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
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const body = await parseJson(req);
  if (body === null) return badRequest("Invalid JSON body");
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "deadLetterId or all=true is required" }, { status: 422 });
  }

  if (parsed.data.all) {
    const pending = await db.deadLetter.findMany({ where: { replayedAt: null }, take: 50 });
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const dl of pending) results.push({ id: dl.id, ...(await replayDeadLetter(dl.id)) });
    return NextResponse.json({ ok: true, replayed: results.filter((r) => r.ok).length, results });
  }

  const result = await replayDeadLetter(parsed.data.deadLetterId!);
  if (!result.ok) {
    const status = result.error === "dead_letter_not_found" ? 404 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true });
}

/** GET lists dead letters so the console can show what needs replaying. */
export async function GET() {
  const guard = await requireOperator();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const rows = await db.deadLetter.findMany({ orderBy: { failedAt: "desc" }, take: 50 });
  return NextResponse.json({ ok: true, deadLetters: rows }, { headers: { "Cache-Control": "no-store" } });
}
