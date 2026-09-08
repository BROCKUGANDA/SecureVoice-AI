import { NextResponse } from "next/server";
import { getProfile } from "@/lib/credits";

export const dynamic = "force-dynamic";

/** The signed-in operator's profile + prepaid credits balance (wallet). */
export async function GET() {
  const profile = await getProfile();
  return NextResponse.json(
    { profile },
    { headers: { "Cache-Control": "no-store" } }
  );
}
