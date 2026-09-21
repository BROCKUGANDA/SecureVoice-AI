import { NextRequest, NextResponse } from "next/server";
import { requireSignedIn } from "@/lib/credits";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Server-Sent Events stream of live audit activity.
 * Polls the audit log every 2s and pushes new rows as SSE `activity` events;
 * closes after 90s — the client's EventSource reconnects automatically.
 *
 * Concurrency: uses a single setInterval that is cleared on close/cancel, so
 * a disconnected client never leaves a polling loop running. The abort
 * listener is also removed to prevent leaks in long-lived processes.
 *
 * Any signed-in seat may watch, scoped to their org when one is active.
 */

const POLL_MS = 2_000;
const MAX_STREAM_MS = 90_000;

export async function GET(req: NextRequest) {
  const guard = await requireSignedIn();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const afterParam = req.nextUrl.searchParams.get("after");
  let cursor = afterParam ? new Date(afterParam) : new Date(Date.now() - 60_000);
  if (Number.isNaN(cursor.getTime())) cursor = new Date(Date.now() - 60_000);

  const encoder = new TextEncoder();
  const orgId = guard.profile.orgId;

  let intervalId: ReturnType<typeof setInterval> | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
    if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
    req.signal.removeEventListener("abort", onAbort);
  };

  const onAbort = () => cleanup();

  const stream = new ReadableStream({
    start(controller) {
      const close = () => {
        cleanup();
        try { controller.close(); } catch {}
      };
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };

      send("open", { at: new Date().toISOString() });

      const started = Date.now();
      const tick = async () => {
        if (closed) return;
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
      };

      // Use setInterval so a single clearInterval stops all future polls.
      intervalId = setInterval(tick, POLL_MS);
      // First tick fires immediately (no initial 1.5s delay)
      void tick();

      // Hard stop after MAX_STREAM_MS — client EventSource reconnects.
      timeoutId = setTimeout(() => {
        send("close", { reason: "stream-timeout" });
        close();
      }, MAX_STREAM_MS);

      req.signal.addEventListener("abort", onAbort);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx buffering for SSE
    },
  });
}
