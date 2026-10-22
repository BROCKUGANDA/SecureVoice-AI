import "server-only";

import { append as auditAppend } from "@/lib/audit-chain";
import { isRealIp } from "@/lib/ip-normalize";
import { logWarn } from "@/lib/validation/safe-log";
import {
  hashIdentifier,
  isHoneypotBlocked,
  recordHoneypotBlock,
  recordScammerHash,
} from "@/lib/abuse/honeypot-blocklist";



/**
 * Active defense for the decoy surfaces.
 *
 * Two rules shape this module:
 *
 *   · The decoy is a TRAP, not a second way to deny a customer. A hit blocks
 *     the source for 24 hours across every route the proxy serves.
 *   · No raw identifier is stored or logged. IPs and phone numbers are hashed
 *     before they reach Redis, the audit row or a log line, matching the
 *     bad-actor module's posture. The hash is enough to enforce and correlate.
 *
 * The blocklist half (`honeypot-blocklist.ts`) is imported by the proxy; this
 * half adds the audit row and the operator log, so the proxy never pulls the
 * database client into its pre-route bundle.
 */

export { isHoneypotBlocked };

/** Record a decoy hit: block the source, append the audit row, alert the log. */
export async function recordHoneypotHit(ip: string, detail: string): Promise<void> {
  // `untrusted` is the proxy's sentinel for a request that did not come through
  // the trusted edge. Blocking that key would block every such caller — a
  // self-inflicted outage from one scanner. The hit is still witnessed.
  const key = isRealIp(ip)
    ? await recordHoneypotBlock(ip)
    : hashIdentifier(`untrusted:${detail}`);
  logWarn("[honeypot] decoy endpoint hit", { source: key, detail, blocked: isRealIp(ip) });
  try {
    await auditAppend({
      callRef: "SV-HONEYPOT",
      action: "handoff",
      intent: "honeypot_triggered",
      callerId: key,
      redactedText: `Decoy endpoint hit: ${detail}`,
      meta: { source_hash: key, ttl_ms: 24 * 60 * 60 * 1000 },
    });
  } catch {
    // The block is the control; the audit row is evidence. An audit outage must
    // not make the trap look like a normal failure.
  }
}

/** Record a caller captured by the voice decoy, by hash only. */
export async function recordScammerNumber(phone: string): Promise<void> {
  const clean = phone.trim();
  if (!clean) return;
  const key = hashIdentifier(clean);
  await recordScammerHash(key);
  logWarn("[honeypot] voice decoy captured a caller", { source: key });
  try {
    await auditAppend({
      callRef: "SV-HONEYPOT",
      action: "handoff",
      intent: "honeypot_scammer_number_recorded",
      callerId: key,
      redactedText: `Voice decoy captured caller hash ${key}.`,
      meta: { source_hash: key },
    });
  } catch {
    // Same rule as the API trap: the capture stands without the witness row.
  }
}
