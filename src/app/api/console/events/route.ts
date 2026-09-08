import { NextRequest, NextResponse } from "next/server";
import { requireOperator } from "@/lib/credits";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Server-Sent Events stream of live audit activity (checklist #25: the UI
 * reflects background work without blocking the request that triggered it).
 * Polls the audit log every 2s and pushes new rows as SSE `activity` events;
 * closes after 90s — the client's EventSource reconnects automatically.
 */

export async function GET(req: NextRequest) {
  const guard = await requireOperator();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const afterParam = req.nextUrl.searchParams.get("after");
  let cursor = afterParam ? new Date(afterParam) : new Date(Date.now() - 60_000);
  if (Number.isNaN(cursor.getTime())) cursor = new Date(Date.now() - 60_000);

  const encoder = new TextEncoder();
  const orgId = guard.profile.orgId;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("open", { at: new Date().toISOString() });

      const started = Date.now();
      const tick = async () => {
        try {
          const rows = await db.auditLog.findMany({
            where: {
              createdAt: { gt: cursor },
              ...(orgId ? { orgId } : {}),
            },
            orderBy: { createdAt: "asc" },
            select: {
              callRef: true, action: true, intent: true, redactedText: true, createdAt: true,
            },
            take: 20,
          });
          if (rows.length > 0) {
            cursor = rows[rows.length - 1].createdAt;
            send("activity", rows.map((r) => ({
              callRef: r.callRef,
              action: r.action,
              intent: r.intent,
              detail: (r.redactedText ?? "").slice(0, 90),
              at: r.createdAt.toISOString(),
            })));
          }
        } catch {
          // DB blip — keep the stream alive, next tick retries
        }
        if (Date.now() - started < 90_000) {
          setTimeout(tick, 2000);
        } else {
          send("close", { reason: "stream-timeout" });
          controller.close();
        }
      };
      setTimeout(tick, 1500);

      req.signal.addEventListener("abort", () => {
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
    },
  });
}
