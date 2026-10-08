import "server-only";

/**
 * Human-facing surface for the dead-letter queue: list what is dead, replay
 * what should not have been, discard what was correctly dead. Backed by the
 * DeadLetter table the failureCallback writes.
 *
 * Deliberately the ONLY caller of DeadLetter.deleteMany: a DLQ without a
 * way to clear a false positive is a table nobody trusts, so operators
 * would stop looking at it.
 */

import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/credits";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireOperator();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const rows = await db.deadLetter.findMany({
    where: { replayedAt: null, eventType: { startsWith: "qstash." } },
    orderBy: { failedAt: "desc" },
    take: 100,
  });
  return NextResponse.json({
    deadLetters: rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      caseRef: r.caseRef,
      targetUrl: r.targetUrl,
      attempts: r.attempts,
      error: r.error,
      failedAt: r.failedAt.toISOString(),
      payload: safeParse(r.payload),
    })),
  });
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
