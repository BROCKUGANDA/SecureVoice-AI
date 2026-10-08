/**
 * Bank-side verification for SecureVoice outbound webhooks (WP-5).
 *
 * Reference implementation for a bank's integration team. The WP-5 gate runs
 * this file through Bun AND runs scripts/verify_sv_signature.py through a
 * Python interpreter against the same delivery, so both implementations are
 * proven to agree — that is what makes the signature a contract rather than a
 * claim.
 *
 *   bun scripts/verify_sv_signature.ts <raw_body_file> <signature_header> <secret>
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

/** Must match the sender's REPLAY_WINDOW_SEC (src/lib/config.ts default 300). */
const TOLERANCE_SECONDS = Number(process.env.REPLAY_WINDOW_SEC) || 300;

export function verifySvSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  toleranceSeconds = TOLERANCE_SECONDS,
): { ok: true } | { ok: false; reason: string } {
  if (!signatureHeader) return { ok: false, reason: "missing_signature" };
  const parts: Record<string, string> = {};
  for (const chunk of signatureHeader.split(",")) {
    const eq = chunk.indexOf("=");
    if (eq > 0) parts[chunk.slice(0, eq).trim()] = chunk.slice(eq + 1).trim();
  }
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return { ok: false, reason: "malformed_signature" };
  const ts = Number(t);
  if (!Number.isFinite(ts)) return { ok: false, reason: "malformed_timestamp" };
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(v1, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b))
    return { ok: false, reason: "digest_mismatch" };
  return { ok: true };
}

if (import.meta.main) {
  const [, , bodyPath, header, secret] = process.argv;
  if (!bodyPath || !header || !secret) {
    console.error(
      "usage: bun scripts/verify_sv_signature.ts <raw_body_file> <signature_header> <secret>",
    );
    process.exit(2);
  }
  const verdict = verifySvSignature(readFileSync(bodyPath, "utf8"), header, secret);
  console.log((verdict.ok ? "VERIFIED" : "REJECTED") + `: ${verdict.ok ? "ok" : verdict.reason}`);
  process.exit(verdict.ok ? 0 : 1);
}
