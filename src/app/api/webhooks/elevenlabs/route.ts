import { NextRequest, NextResponse } from "next/server";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { processInboundEvent } from "@/lib/elevenlabs/inbound";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/elevenlabs — post-call ingest (WP-4).
 *
 * The ElevenLabs conversation plane reports completed calls here. The
 * handler does the minimum synchronously — verify signature, dedupe,
 * enqueue — and returns 2xx fast; all redaction/persistence/audit work
 * happens in `processInboundEvent` (fired without await) so provider
 * retries never pile up behind database writes.
 *
 * Signature scheme (verified with the platform SDK, not hand-rolled):
 *   ElevenLabs-Signature: t={unix},v0={hmac-sha256(`${t}.${body}`, secret)}
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const sigHeader = req.headers.get("elevenlabs-signature");
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;

  if (!secret) {
    console.error("[webhooks/elevenlabs] ELEVENLABS_WEBHOOK_SECRET is not set");
    return NextResponse.json({ error: "ingest_unconfigured" }, { status: 503 });
  }

  let event: any;
  try {
    const client = new ElevenLabsClient({
      apiKey: process.env.ELEVENLABS_API_KEY ?? "webhook-verification-only",
    });
    event = await client.webhooks.constructEvent(raw, sigHeader ?? "", secret);
  } catch {
    // Never a 5xx for a verification failure — 4xx exactly like WP-3's
    // refusal discipline.
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }

  const data = event?.data ?? {};
  const eventType: string = event?.type ?? "unknown";
  const conversationId: string | null = typeof data.conversation_id === "string" ? data.conversation_id : null;
  const agentId: string | null = typeof data.agent_id === "string" ? data.agent_id : null;
  const eventTimestamp: number | null =
    typeof event?.event_timestamp === "number"
      ? event.event_timestamp
      : typeof event?.event_timestamp === "string"
        ? Number(event.event_timestamp)
        : null;

  try {
    const row = await db.webhookEvent.create({
      data: { provider: "elevenlabs", eventType, conversationId, agentId, eventTimestamp },
    });
    // Enqueue by handing off without await; tests await the row directly.
    void processInboundEvent(row.id, event).catch(async (err) => {
      console.error("[webhooks/elevenlabs] processing failed:", err);
      await db.webhookEvent
        .update({ where: { id: row.id }, data: { error: String(err).slice(0, 500) } })
        .catch(() => {});
    });
    return NextResponse.json({ ok: true, received: true });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // An exact delivery replay. Two cases:
      //   - already processed  -> duplicate, return the original outcome shape
      //   - not yet processed  -> the first attempt failed; re-process now
      const existing = await db.webhookEvent.findFirst({
        where: { provider: "elevenlabs", eventType, conversationId, eventTimestamp },
      });
      if (existing && existing.processed) {
        return NextResponse.json({ ok: true, duplicate: true });
      }
      if (existing) {
        void processInboundEvent(existing.id, event).catch(() => {});
        return NextResponse.json({ ok: true, reprocessing: true });
      }
      // Row vanished between the two writes (admin purge) — sight of replay.
      return NextResponse.json({ ok: true, duplicate: true });
    }
    console.error("[webhooks/elevenlabs] webhookEvent insert failed:", err);
    return NextResponse.json({ error: "ingest_persist_failed" }, { status: 503 });
  }
}
