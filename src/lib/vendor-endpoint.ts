/**
 * The vendor webhook endpoint — where an institution's OWN systems are told
 * what happened to its own case.
 *
 * Delivery used to have one destination for every tenant: the deployment-wide
 * `BANK_WEBHOOK_URL`, signed with the one `BANK_WEBHOOK_SECRET`. That is fine for
 * a single pilot and wrong for a platform, because two banks cannot share an
 * endpoint, one key rotation breaks every tenant, and a bank that wants results
 * pushed at its fraud queue has no way to ask for it.
 *
 * Three rules hold this together:
 *
 *   1. The tenant's endpoint wins; the deployment default is a fallback, not a
 *      second destination. Nothing is ever delivered twice.
 *   2. A tenant URL is treated as UNTRUSTED INPUT. It is SSRF-validated when it
 *      is saved and again immediately before delivery, because DNS can change
 *      between those two moments and a stored host that resolved publicly once
 *      can be re-pointed at the metadata address afterwards.
 *   3. A tenant URL with an unusable secret is a REFUSAL, not a reason to sign
 *      with the platform key. Falling back would hand a bank a payload signed
 *      with a secret it never issued — which its receiver either rejects (lost
 *      event) or, if it happens to share the key, accepts as authoritative.
 */

import "server-only";

import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/byok";
import { validateOutboundUrl } from "@/lib/validation/ssrf";
import { env } from "@/lib/config";

export type VendorEndpoint = {
  url: string;
  secret: string;
  /** Which source produced this endpoint — recorded, never guessed. */
  source: "tenant" | "deployment";
};

export type EndpointRejection = {
  ok: false;
  code: "no_endpoint" | "unusable_url" | "missing_secret" | "secret_decrypt_failed";
  reason: string;
};

export type EndpointResolution = { ok: true; endpoint: VendorEndpoint } | EndpointRejection;

/** The deployment-wide fallback, exactly as it behaved before per-tenant routes. */
function deploymentEndpoint(): VendorEndpoint | null {
  const url = process.env.BANK_WEBHOOK_URL;
  const secret = process.env.BANK_WEBHOOK_SECRET;
  if (!url || !secret) return null;
  return { url, secret, source: "deployment" };
}

/**
 * Resolve where (and with what key) this tenant's events go.
 *
 * `requireSecret` is false only for the read path that shows an operator their
 * own configuration; delivery always demands a usable secret.
 */
export async function resolveVendorEndpoint(
  orgId: string | null | undefined,
  opts: { requireSecret?: boolean } = {},
): Promise<EndpointResolution> {
  const requireSecret = opts.requireSecret !== false;

  if (orgId) {
    let row: { vendorWebhookUrl: string | null; vendorWebhookSecretEnc: string | null } | null =
      null;
    try {
      row = await db.organization.findUnique({
        where: { id: orgId },
        select: { vendorWebhookUrl: true, vendorWebhookSecretEnc: true },
      });
    } catch {
      // A tenant lookup that faults must not silently deliver that tenant's
      // events to another institution's queue.
      return { ok: false, code: "no_endpoint", reason: "organisation lookup failed" };
    }

    const url = row?.vendorWebhookUrl?.trim();
    if (url) {
      const sealed = row?.vendorWebhookSecretEnc;
      if (requireSecret && !sealed) {
        return {
          ok: false,
          code: "missing_secret",
          reason: "endpoint configured without a signing key",
        };
      }
      const secret = sealed ? decryptSecret(sealed) : null;
      if (requireSecret && sealed && secret === null) {
        return {
          ok: false,
          code: "secret_decrypt_failed",
          reason: "signing key could not be unsealed",
        };
      }
      return {
        ok: true,
        endpoint: {
          url,
          secret: secret ?? "",
          source: "tenant",
        },
      };
    }
  }

  const fallback = deploymentEndpoint();
  if (fallback) return { ok: true, endpoint: fallback };

  // Neither the tenant nor the deployment has an endpoint. The caller keeps the
  // event queued and reports why rather than dropping it.
  return { ok: false, code: "no_endpoint", reason: "no vendor endpoint for this tenant" };
}

/**
 * Validate a URL an operator is about to save. Returns the normalised URL or a
 * refusal with the reason, so the console can show the operator what is wrong
 * instead of accepting a value that will fail every delivery.
 */
export async function assertVendorUrlSaveable(
  raw: string,
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "not a valid absolute URL" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: `unsupported protocol '${parsed.protocol}'` };
  }
  // http is only tolerable against a loopback listener in development; a
  // production bank endpoint over plaintext leaks both the payload and the
  // signature the receiver would go on to trust.
  if (parsed.protocol === "http:" && env.isProduction) {
    return { ok: false, reason: "plaintext http is not accepted for a vendor endpoint" };
  }
  const verdict = await validateOutboundUrl(parsed);
  if (!verdict.ok) {
    return { ok: false, reason: `address not permitted for outbound delivery (${verdict.code})` };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * Re-check the stored URL at delivery time. The tenant row was validated when it
 * was written; this is the check that a re-pointed DNS record cannot turn a
 * saved endpoint into a request against the origin's own network.
 */
export async function assertVendorUrlDeliverable(
  url: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const verdict = await validateOutboundUrl(url);
  return verdict.ok
    ? { ok: true }
    : { ok: false, reason: `address no longer permitted (${verdict.code})` };
}
