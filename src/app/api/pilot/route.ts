import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/config";
import { db } from "@/lib/db";
import { logError } from "@/lib/validation/safe-log";

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
  // Use the proxy-resolved IP (set by src/proxy.ts after the XFF trust
  // decision) — raw x-forwarded-for here would be trivially rotatable.
  const ip =
    req.headers.get("x-securevoice-client-ip")?.slice(0, 64) ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64) ||
    "local";

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
