import "server-only";

import crypto from "node:crypto";
import { db } from "@/lib/db";
import { generateCaseFile } from "@/lib/regulatory-export";

export async function generateSTREvidence(interventionId: string): Promise<Record<string, unknown>> {
  const base = await generateCaseFile(interventionId);

  const strPackage = {
    report_id: `STR-${base.intervention_id}`,
    ...base,
    report_type: "FATF_RECOMMENDATION_20_STR",
  };

  const fiuEndpoint = process.env.BANK_FIU_WEBHOOK_URL ?? process.env.FIU_ENDPOINT ?? null;
  if (fiuEndpoint) {
    try {
      const secret = process.env.BANK_WEBHOOK_SECRET ?? "";
      // Serialised once; that exact string is both signed and sent. Signing a
      // re-serialisation is the rule-4 violation — the digest would cover bytes
      // the receiver never holds.
      const body = JSON.stringify(strPackage);
      const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
      await fetch(fiuEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-STR-Signature": signature,
        },
        body,
      });
    } catch {
      // non-blocking
    }
  }

  try {
    await db.auditLog.create({
      data: {
        callRef: strPackage.case_id as string,
        action: "fiu_str_evidence_generated",
        meta: JSON.stringify({ report_id: strPackage.report_id }),
        chainHash: crypto.randomUUID(),
      },
    });
  } catch {
    // non-blocking
  }

  return strPackage;
}
