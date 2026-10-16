import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/config";
import { db } from "@/lib/db";
import { logError } from "@/lib/validation/safe-log";
import { resolveClientIp } from "@/lib/client-ip";
import { enqueueEmail } from "@/lib/email/outbox";
import { SUPPORT_EMAIL as PUBLIC_SUPPORT_EMAIL } from "@/lib/public-config";

export const dynamic = "force-dynamic";

/* ————— in-memory sliding-window rate limit (per IP) ————— */
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_WINDOW = env.pilotRateLimitPerHour;
const MAX_TRACKED_IPS = 10_000; // bound memory; XFF is spoofable, so an
// attacker cycling fake IPs can't grow this forever
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) {
    hits.set(ip, arr);
    return true;
  }
  arr.push(now);
  hits.set(ip, arr);
  // opportunistic cleanup
  if (hits.size > 500) {
    for (const [k, v] of hits) {
      if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
    }
  }
  if (hits.size > MAX_TRACKED_IPS) {
    // hard cap: drop the oldest half (Map preserves insertion order)
    const drop = Math.ceil(hits.size / 2);
    let i = 0;
    for (const k of hits.keys()) {
      if (i++ >= drop) break;
      hits.delete(k);
    }
  }
  return false;
}

/* ————— validation ————— */
const pilotSchema = z.object({
  name: z.string().trim().min(2, "Name is too short").max(80),
  email: z.string().trim().toLowerCase().email().max(160),
  institution: z.string().trim().min(2, "Institution is too short").max(120),
  role: z.string().trim().max(80).optional().or(z.literal("")),
  volume: z.string().trim().max(40).optional().or(z.literal("")),
  message: z.string().trim().max(600).optional().or(z.literal("")),
  // honeypot — real users never fill this (hidden field). Any non-empty
  // value marks a bot; max(0) would make the field always "" and the trap dead.
  company_url: z.string().max(200).optional(),
  source: z.string().trim().max(24).optional(),
});

const REF_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function makeRef(): string {
  let s = "";
  for (let i = 0; i < 5; i++) {
    s += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
  }
  return `SV-P-${s}`;
}

export async function POST(req: NextRequest) {
  // One resolver for the whole codebase (src/lib/client-ip.ts). The previous
  // inline read trusted `x-forwarded-for` whenever the proxy header was absent,
  // which is precisely the case an attacker creates by skipping the proxy — so
  // the fallback defeated the comment two lines above it. `resolveClientIp`
  // believes no header at all unless src/proxy.ts marked the request, so the
  // budget below can no longer be rotated by choosing a header value.
  const ip = resolveClientIp(req.headers);

  if (rateLimited(ip)) {
    return NextResponse.json(
      { ok: false, error: "Too many requests. Please try again later." },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }

  const parsed = pilotSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { ok: false, error: first?.message ?? "Please check the form and try again." },
      { status: 422 },
    );
  }

  const d = parsed.data;
  // bot caught by honeypot → pretend success, store nothing
  if (d.company_url) {
    return NextResponse.json({ ok: true, ref: "SV-P-00000" });
  }

  // ref is 5 chars from a 32-symbol alphabet — collisions become likely around
  // a few thousand rows, so retry the insert on a unique-constraint hit
  // instead of surfacing a 500.
  for (let attemptN = 0; attemptN < 5; attemptN++) {
    try {
      const row = await db.pilotRequest.create({
        data: {
          ref: makeRef(),
          name: d.name,
          email: d.email,
          institution: d.institution,
          role: d.role || null,
          volume: d.volume || null,
          message: d.message || null,
          source: d.source || "website",
        },
        select: { ref: true, createdAt: true },
      });

      // Notify the sales inbox.
      //
      // The enquiry row is committed first, so a mail failure can never lose a
      // lead. What is NOT true — and was the bug — is that the notification can be
      // fired off unawaited. `enqueueAndSendEmail` does the queue INSERT and the
      // provider call in one floating promise, so the response could return 200
      // while nothing had been queued yet: no queue row means no drain retry, and
      // the only trace is a log line nobody reads. Found by the gate, which
      // asserted the row immediately after the request and found it missing under a
      // containerised database where the floating promise had not landed.
      //
      // So the awaited half is the DURABLE half and the offloaded half is the
      // delivery: the queue entry is written before this handler answers, and the
      // mail worker (10s drain) sends it. That keeps the property the original
      // comment was protecting — a provider outage must not turn a successful
      // enquiry into a 500 for the person at the form — while dropping the part
      // that was never true: an unawaited enqueue is not "retried by the worker",
      // because nothing was queued. A pilot lead does not compete with a magic
      // link for seconds; it competes with silence.
      //
      // The recipient falls back to the public support mailbox rather than being
      // skipped. It USED to be `if (notifyTo)`, on the reasoning that the mailbox
      // is an operational choice — which is true, and is why PILOT_NOTIFY_EMAIL
      // still overrides. But an unset variable then made the notification SILENT:
      // the enquiry was stored, the response was 200, the console showed it, and
      // no mail was ever sent. Found in production on 2026-10-14 with
      // PILOT_NOTIFY_EMAIL absent from the box's .env — every pilot lead since was
      // a row and a lie. A lead is the one thing on this site with no other
      // channel, so "nobody configured it" has to mean support@, not nobody.
      const notifyTo = (
        process.env.PILOT_NOTIFY_EMAIL?.trim() ||
        process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim() ||
        PUBLIC_SUPPORT_EMAIL
      ).toLowerCase();
      if (notifyTo) {
        try {
          await enqueueEmail({
            kind: "pilot_request",
            toEmail: notifyTo,
            subject: `Pilot request: ${d.institution} — ${d.name}`,
            props: {
              ref: row.ref,
              name: d.name,
              email: d.email,
              institution: d.institution,
              role: d.role || null,
              volume: d.volume || null,
              message: d.message || null,
              source: d.source || "website",
            },
          });
        } catch (err) {
          // Visible, never fatal: the enquiry is already durable. But it is
          // logged as what it is — a lead whose notification was never queued has
          // no second channel and no retry, so the operator has to be able to
          // find this line.
          logError("[pilot] notification not queued — the lead is stored, the mail is not", {
            ref: row.ref,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return NextResponse.json({ ok: true, ref: row.ref, createdAt: row.createdAt });
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "P2002") continue; // ref collision — try a fresh ref
      logError("[pilot] insert failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }
  }
  return NextResponse.json(
    { ok: false, error: "We could not save your request. Please try again shortly." },
    { status: 500 },
  );
}
