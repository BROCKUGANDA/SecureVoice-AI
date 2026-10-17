import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { requireOperator } from "@/lib/credits";
import { generateCaseFile } from "@/lib/regulatory-export";

export async function GET(req: NextRequest) {
  const guard = await requireOperator();
  if (!guard.ok) return NextResponse.json({ error: "Not permitted" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const caseId =
    searchParams.get("case_id") ?? searchParams.get("intervention_id");
  if (!caseId) return NextResponse.json({ error: "case_id is required" }, { status: 400 });

  const pkg = await generateCaseFile(caseId);
  return new NextResponse(JSON.stringify(pkg, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="SecureVoice_Evidence_${pkg.case_id}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
