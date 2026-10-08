import { NextResponse } from "next/server";

import "server-only";
import { redactPII } from "@/lib/compliance/redactor";
import { validateInterventionPolicy } from "@/lib/compliance/middleware";
import { logError, logInfo } from "@/lib/validation/safe-log";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const payload = await req.json().catch(() => null);
  if (!payload) {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body", code: "malformed_request" },
      { status: 400 },
    );
  }

  const validation = validateInterventionPolicy(payload);
  if (!validation.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "Invalid intervention policy",
        code: "semantically_invalid",
        detail: validation.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 422 },
    );
  }

  const data = validation.data;

  // Compliance: enforce data minimization before any downstream processing.
  // The raw transcript, dynamic variables, and webhook payloads must never
  // carry unredacted PANs, phones, or SSN-style identifiers.
  const redactedPayload = {
    ...payload,
    redacted_text: redactPII(JSON.stringify(payload)),
  };

  logInfo("[compliance] intervention policy validated", {
    orgId: data.org_id,
    callCategory: data.call_category,
    language: data.language,
  });

  // In a full implementation this would enqueue the validated envelope onto
  // the durable dial queue or QStash dispatch path. The important part for
  // compliance is that EVERY intervention passes through this gate before any
  // worker executes, so calling-hour, DNC, and payload-shape rules cannot be
  // bypassed by reaching around the API surface.
  return NextResponse.json(
    {
      ok: true,
      status: "policy_validated",
      policy: {
        org_id: data.org_id,
        call_category: data.call_category,
        language: data.language,
      },
      redacted_text: redactedPayload.redacted_text,
    },
    { status: 200 },
  );
}
