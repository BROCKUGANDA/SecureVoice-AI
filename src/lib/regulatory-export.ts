import "server-only";

import crypto from "node:crypto";
import { db } from "@/lib/db";
import { append as auditAppend } from "@/lib/audit-chain";

export type CaseFileOptions = {
  /**
   * Refuse unless the case is CONFIRMED_FRAUD. The STR path sets this; the
   * general regulator export does not, because an operator may need the audit
   * record of a case that never reached a verdict.
   */
  requireConfirmedFraud?: boolean;
  /**
   * Skip the deployment-wide compliance webhook. The STR path sends its own
   * FIU package; posting both would deliver the same case to two destinations
   * with no idempotency key between them.
   */
  skipComplianceWebhook?: boolean;
};

/**
 * A case remains a confirmed-fraud case after the workflow moves it past
 * CONFIRMED_FRAUD. Freezing the card and handing off are consequences of that
 * verdict, not a return to uncertainty; requiring the exact state made the STR
 * unavailable at the moment the bank most needs it.
 */
const STR_ELIGIBLE_STATES: ReadonlySet<string> = new Set([
  "CONFIRMED_FRAUD",
  "FREEZE_STAGED",
  "ESCALATED",
]);

export class CaseNotConfirmedError extends Error {
  constructor(
    readonly caseRef: string,
    readonly state: string,
  ) {
    super(
      `Case ${caseRef} is ${state}; an STR requires a confirmed-fraud state (CONFIRMED_FRAUD, FREEZE_STAGED or ESCALATED)`,
    );
    this.name = "CaseNotConfirmedError";
  }
}

export type RegulatoryEvidencePackage = {
  case_id: string;
  intervention_id: string;
  institution: string | null;
  case_state: string;
  fraud_type: string | null;
  incident_timestamp: string | null;
  evidence_limitations: string[];
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

/**
 * Sign the EXACT bytes that go on the wire.
 *
 * This takes a string, not an object, and that is the whole point. Rule 4 of the
 * money-audit contract forbids a digest computed over re-serialised JSON, because
 * `JSON.stringify` is not guaranteed to reproduce the bytes that were actually
 * transmitted — a signature over a re-serialisation can verify against something
 * the receiver never sent. Serialising once here and passing that string to both
 * the signer and the body makes the signed bytes and the sent bytes the same
 * value by construction, so there is no re-serialisation to drift.
 */
export function signHMAC(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Build the regulator evidence package.
 *
 * `orgId` is the CALLER's tenant. A tenant operator may only export a case
 * belonging to that tenant; a platform operator (null) may export any case.
 * The lookup is scoped here rather than at the route so a second caller cannot
 * forget it — this function was previously a global `findFirst` by id/ref, and
 * any tenant admin could read another tenant's transcript by guessing a case
 * ref.
 */
export async function generateCaseFile(
  caseIdOrRef: string,
  orgId: string | null = null,
  opts: CaseFileOptions = {},
) {
  const row = await db.case.findFirst({
    where: {
      AND: [{ OR: [{ id: caseIdOrRef }, { caseRef: caseIdOrRef }] }, ...(orgId ? [{ orgId }] : [])],
    },
    select: {
      id: true,
      caseRef: true,
      orgId: true,
      state: true,
      signalKind: true,
      callCategory: true,
      outcome: true,
      customerResponse: true,
      riskScore: true,
      amountMinor: true,
      currency: true,
      merchant: true,
      transcriptRedacted: true,
      createdAt: true,
      signalReceivedAt: true,
      isEvidenceLocked: true,
      evidenceCaseId: true,
    },
  });
  if (!row) throw new Error(`Case not found: ${caseIdOrRef}`);
  if (opts.requireConfirmedFraud && !STR_ELIGIBLE_STATES.has(row.state)) {
    throw new CaseNotConfirmedError(row.caseRef, row.state);
  }

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
    case_state: row.state,
    fraud_type: row.signalKind ?? row.callCategory ?? null,
    // The signal's arrival is the closest instant this platform holds to the
    // transaction event; `createdAt` is the database write and sits behind the
    // policy gates. Never label it as the transaction's own timestamp.
    incident_timestamp: (row.signalReceivedAt ?? row.createdAt).toISOString(),
    // Audio is not stored by this deployment, and a null URL in a compliance
    // package is read as "attachment missing", not "no recording exists". Say
    // which it is; never invent a URL.
    evidence_limitations: [
      "audio_not_stored",
      ...(row.transcriptRedacted ? [] : ["transcript_unavailable"]),
    ],
    risk_score: row.riskScore ?? null,
    transaction_details: {
      amount: row.amountMinor == null ? null : row.amountMinor / 100,
      currency: row.currency ?? null,
      merchant: row.merchant ?? null,
    },
    customer_response:
      row.customerResponse ??
      (row.state === "CONFIRMED_FRAUD" ? "fraud_confirmed" : (row.outcome ?? row.state)),
    ai_transcript: row.transcriptRedacted ?? null,
    audio_evidence_url: null,
    authz_action_taken: row.state === "CONFIRMED_FRAUD" ? "soft_freeze_24h" : "none",
    ai_system_integrity_hash: crypto
      .createHash("sha256")
      .update(`${row.id}:${row.caseRef}:${row.state}:${row.createdAt.toISOString()}`)
      .digest("hex"),
  };

  // Lock/retain (idempotent). Only a confirmed-fraud case earns the five-year
  // hold; a routine operational export of an unconfirmed case must not turn a
  // customer's record into a law-enforcement artefact. An already-locked case
  // stays locked — this write never clears the flag.
  await db.case.update({
    where: { id: row.id },
    data: {
      evidenceCaseId,
      ...(STR_ELIGIBLE_STATES.has(row.state) ? { isEvidenceLocked: true } : {}),
    },
  });

  // Push to bank compliance system if configured. The STR path skips this: it
  // has its own FIU destination and a second, unsigned-for-that-receiver copy
  // would be a duplicate delivery, not a backup.
  const complianceUrl = process.env.BANK_COMPLIANCE_WEBHOOK_URL;
  if (complianceUrl && !opts.skipComplianceWebhook) {
    const secret = process.env.BANK_WEBHOOK_SECRET ?? "";
    // Serialised ONCE, and that exact string is both signed and sent. Signing a
    // re-serialisation is the rule-4 violation this avoids: the digest then
    // covers bytes the receiver never holds.
    const body = JSON.stringify(evidencePackage);
    try {
      await fetch(complianceUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.BANK_COMPLIANCE_TOKEN ?? ""}`,
          "X-Evidence-Signature": signHMAC(body, secret),
        },
        body,
      });
    } catch {
      // non-blocking
    }
  }

  // Append to the tamper-evident chain. The previous write used
  // `chainHash: randomUUID()` with no `prevHash`, which is a row that LOOKS
  // like an audit entry and is not one: it cannot verify and it breaks the walk
  // for the case. `append` computes the real link and carries the tenant.
  try {
    await auditAppend({
      callRef: row.caseRef,
      action: "handoff",
      intent: "evidence_exported_to_regulator",
      orgId: row.orgId ?? undefined,
      meta: { case_id: evidenceCaseId },
    });
  } catch {
    // non-blocking, matching the export contract: the package is returned even
    // if the audit store is down
  }

  return evidencePackage;
}
