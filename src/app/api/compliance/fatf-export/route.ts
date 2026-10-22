import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireOperator } from "@/lib/credits";
import { generateSTREvidence } from "@/lib/compliance/fatf-export";
import { CaseNotConfirmedError } from "@/lib/regulatory-export";

export async function GET(req: NextRequest) {
  const guard = await requireOperator();
  if (!guard.ok) return NextResponse.json({ error: "Not permitted" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const caseId = searchParams.get("case_id") ?? searchParams.get("intervention_id");
  if (!caseId) return NextResponse.json({ error: "case_id is required" }, { status: 400 });

  try {
    const pkg = await generateSTREvidence(caseId, guard.profile.orgId);
    return new NextResponse(JSON.stringify(pkg, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="SecureVoice_STR_${pkg.report_id}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof CaseNotConfirmedError) {
      return NextResponse.json(
        { error: err.message, caseRef: err.caseRef, state: err.state },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "Case not found" }, { status: 404 });
  }
}
