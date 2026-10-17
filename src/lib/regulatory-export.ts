import "server-only";

import crypto from "node:crypto";
import { db } from "@/lib/db";

export type RegulatoryEvidencePackage = {
  case_id: string;
  intervention_id: string;
  institution: string | null;
  incident_timestamp: string | null;
  risk_score: number | null;
  transaction_details: {
    amount: number | null;
    currency: string | null;
    merchant: string | null;
  };
  customer_response: string | null;
  ai_transcript: string | null;
  audio_evidence_url: string | null;
  authz_action_taken: string;
  ai_system_integrity_hash: string;
};

export function signHMAC(value: unknown, secret: string): string {
  return crypto.createHmac("sha256", secret).update(JSON.stringify(value)).digest("hex");
}

export async function generateCaseFile(caseIdOrRef: string) {
  const row = await db.case.findFirst({
    where: { OR: [{ id: caseIdOrRef }, { caseRef: caseIdOrRef }] },
    select: {
      id: true,
      caseRef: true,
      orgId: true,
      state: true,
      riskScore: true,
      amountMinor: true,
      currency: true,
      merchant: true,
      transcriptRedacted: true,
      createdAt: true,
      isEvidenceLocked: true,
      evidenceCaseId: true,
    },
  });
  if (!row) throw new Error(`Case not found: ${caseIdOrRef}`);

  const org = row.orgId
    ? await db.organization.findUnique({
        where: { id: row.orgId },
        select: { name: true },
      })
    : null;

  const evidenceCaseId = row.evidenceCaseId ?? `CASE-${row.caseRef}`;

  const evidencePackage: RegulatoryEvidencePackage = {
    case_id: evidenceCaseId,
    intervention_id: row.id,
    institution: org?.name ?? null,
    incident_timestamp: row.createdAt.toISOString(),
    risk_score: row.riskScore ?? null,
    transaction_details: {
      amount: row.amountMinor == null ? null : row.amountMinor / 100,
      currency: row.currency ?? null,
      merchant: row.merchant ?? null,
    },
    customer_response: row.state === "CONFIRMED_FRAUD" ? "fraud_confirmed" : row.state,
    ai_transcript: row.transcriptRedacted ?? null,
    audio_evidence_url: null,
    authz_action_taken: row.state === "CONFIRMED_FRAUD" ? "soft_freeze_24h" : "none",
    ai_system_integrity_hash: crypto
      .createHash("sha256")
      .update(`${row.id}:${row.caseRef}:${row.state}:${row.createdAt.toISOString()}`)
      .digest("hex"),
  };

  // Lock/retain (idempotent).
  await db.case.update({
    where: { id: row.id },
    data: {
      isEvidenceLocked: true,
      evidenceCaseId,
    },
  });

  // Push to bank compliance system if configured.
  const complianceUrl = process.env.BANK_COMPLIANCE_WEBHOOK_URL;
  if (complianceUrl) {
    const secret = process.env.BANK_WEBHOOK_SECRET ?? "";
    try {
      await fetch(complianceUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.BANK_COMPLIANCE_TOKEN ?? ""}`,
          "X-Evidence-Signature": signHMAC(evidencePackage, secret),
        },
        body: JSON.stringify(evidencePackage),
      });
    } catch {
      // non-blocking
    }
  }

  // Append an audit row.
  try {
    await db.auditLog.create({
      data: {
        callRef: row.caseRef,
        orgId: row.orgId ?? undefined,
        action: "evidence_exported_to_regulator",
        meta: JSON.stringify({ case_id: evidenceCaseId }),
        chainHash: crypto.randomUUID(),
      },
    });
  } catch {
    // non-blocking
  }

  return evidencePackage;
}
