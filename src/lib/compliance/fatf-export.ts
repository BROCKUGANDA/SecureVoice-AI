import "server-only";

import crypto from "node:crypto";
import { append as auditAppend } from "@/lib/audit-chain";
import { generateCaseFile } from "@/lib/regulatory-export";
import { logWarn } from "@/lib/validation/safe-log";

/**
 * Sign the exact bytes that go to the FIU.
 *
 * The timestamp is part of the signed material, so a captured request cannot be
 * replayed after the receiver's window. The existing compliance webhook uses a
 * bare digest; this is a new, versioned envelope rather than a silent change to
 * that receiver's contract. The caller must send the same timestamp it signs.
 */
export function signStrBody(body: string, secret: string, timestamp: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

type FiuDelivery =
  | { attempted: false; reason: "endpoint_not_configured" | "secret_not_configured" }
  | { attempted: true; ok: boolean; status?: number; error?: string };

export async function generateSTREvidence(
  interventionId: string,
  orgId: string | null = null,
): Promise<Record<string, unknown>> {
  const base = await generateCaseFile(interventionId, orgId, {
    requireConfirmedFraud: true,
    // The STR has its own FIU destination. Posting the generic compliance copy
    // as well would be a second, differently-signed delivery of the same case.
    skipComplianceWebhook: true,
  });

  const strPackage = {
    report_id: `STR-${base.intervention_id}`,
    ...base,
    report_type: "FATF_RECOMMENDATION_20_STR",
    generated_at: new Date().toISOString(),
  };

  const fiuEndpoint = process.env.BANK_FIU_WEBHOOK_URL ?? process.env.FIU_ENDPOINT ?? null;
  // A dedicated FIU secret is preferred; the legacy bank secret is a fallback
  // so an existing deployment does not silently stop delivering. An empty
  // secret is NOT a signing key: sending with it produces a digest anyone can
  // forge, so the package is returned with an explicit non-delivery verdict.
  const secret =
    process.env.BANK_FIU_WEBHOOK_SECRET?.trim() || process.env.BANK_WEBHOOK_SECRET?.trim() || "";
  let delivery: FiuDelivery;

  if (!fiuEndpoint) {
    delivery = { attempted: false, reason: "endpoint_not_configured" };
  } else if (!secret) {
    delivery = { attempted: false, reason: "secret_not_configured" };
    logWarn("[fatf] STR generated but FIU delivery has no signing secret");
  } else {
    const body = JSON.stringify(strPackage);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signStrBody(body, secret, timestamp);
    try {
      const res = await fetch(fiuEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Versioned, timestamped envelope. A receiver that expects the old
          // bare digest must be upgraded with this release; sending both forms
          // would let a captured old header bypass the replay window.
          "X-STR-Signature": `t=${timestamp},v1=${signature}`,
          "X-STR-Timestamp": timestamp,
        },
        body,
        signal: AbortSignal.timeout(5_000),
      });
      delivery = { attempted: true, ok: res.ok, status: res.status };
      if (!res.ok) {
        logWarn("[fatf] FIU rejected the STR", { status: res.status });
      }
    } catch (err) {
      delivery = {
        attempted: true,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      logWarn("[fatf] FIU delivery failed", { error: delivery.error });
    }
  }

  try {
    await auditAppend({
      callRef: strPackage.case_id as string,
      action: "handoff",
      intent: "fiu_str_evidence_generated",
      orgId: orgId ?? undefined,
      meta: {
        report_id: strPackage.report_id,
        fiu_delivery: delivery,
      },
    });
  } catch {
    // The evidence package is the deliverable; a failed witness row must not
    // make an already-created STR look absent.
  }

  return { ...strPackage, fiu_delivery: delivery };
}
