import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOperator } from "@/lib/credits";
import { db } from "@/lib/db";
import { decryptSecret, encryptSecret, maskKey } from "@/lib/byok";

export const dynamic = "force-dynamic";

/**
 * Operator settings — white-labeling + BYOK (Bring Your Own Key).
 *
 *   GET    /api/console/settings → { orgName, orgLogoUrl, elevenKey: masked|null, credits }
 *   POST   /api/console/settings → { orgName?, orgLogoUrl?, elevenKey? }  (partial update)
 *   DELETE /api/console/settings?field=elevenKey → removes the BYOK key
 *
 * BYOK security: the ElevenLabs key is AES-256-GCM encrypted at rest with an
 * AUTH_SECRET-derived key, decrypted only in-process for upstream calls, and
 * only ever returned masked (sk_…last4).
 */

const schema = z.object({
  orgName: z.string().trim().max(60).optional(),
  orgLogoUrl: z.string().trim().url().max(300).optional().or(z.literal("")),
  elevenKey: z.string().trim().min(20).max(80).optional(),
});

async function readSettings(): Promise<{ settings: Record<string, unknown> } | { error: { status: number; error: string } }> {
  const guard = await requireOperator();
  if (!guard.ok) return { error: { status: guard.status, error: guard.error } };
  const row = await db.userProfile.findUnique({ where: { clerkUserId: guard.profile.clerkUserId } });
  if (!row) return { error: { status: 404, error: "Profile not found" } };
  const key = row.elevenKeyEnc ? decryptSecret(row.elevenKeyEnc) : null;
  return {
    settings: {
      orgName: row.orgName ?? null,
      orgLogoUrl: row.orgLogoUrl ?? null,
      elevenKeyMasked: key ? maskKey(key) : null,
      credits: row.credits,
    },
  };
}

export async function GET() {
  const result = await readSettings();
  if ("error" in result) {
    return NextResponse.json({ error: result.error.error }, { status: result.error.status });
  }
  return NextResponse.json(result.settings, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = await requireOperator();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json({ error: `${first?.path.join(".")} ${first?.message ?? "invalid"}` }, { status: 422 });
  }
  const d = parsed.data;

  const data: Record<string, unknown> = {};
  if (d.orgName !== undefined) data.orgName = d.orgName || null;
  if (d.orgLogoUrl !== undefined) data.orgLogoUrl = d.orgLogoUrl || null;
  if (d.elevenKey !== undefined) {
    // sanity: platform key format is sk_… — accept the operator's own too
    data.elevenKeyEnc = encryptSecret(d.elevenKey);
  }

  await db.userProfile.update({ where: { clerkUserId: guard.profile.clerkUserId }, data });
  const result = await readSettings();
  if ("error" in result) {
    return NextResponse.json({ error: result.error.error }, { status: result.error.status });
  }
  return NextResponse.json({ ok: true, ...result.settings });
}

export async function DELETE(req: NextRequest) {
  const guard = await requireOperator();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  const field = req.nextUrl.searchParams.get("field");
  if (field !== "elevenKey") {
    return NextResponse.json({ error: "field must be elevenKey" }, { status: 422 });
  }
  await db.userProfile.update({
    where: { clerkUserId: guard.profile.clerkUserId },
    data: { elevenKeyEnc: null },
  });
  return NextResponse.json({ ok: true, removed: "elevenKey" });
}
