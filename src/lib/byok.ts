import "server-only";
/**
 * BYOK (Bring Your Own Key) encryption — the organization's ElevenLabs key is
 * stored encrypted at rest (AES-256-GCM) and decrypted only in-process for an
 * upstream call. The key material never leaves the server unencrypted, never
 * reaches the browser, and is derived from AUTH_SECRET (rotating AUTH_SECRET
 * invalidates stored BYOK keys — re-enter them after rotation).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

function byokKey(): Buffer {
  // Never fall back to a constant: a published default key would make every
  // stored BYOK credential decryptable from a database dump. Fail loudly so a
  // misconfigured deployment cannot silently encrypt under a guessable key.
  const base = process.env.AUTH_SECRET;
  if (!base) {
    throw new Error(
      "AUTH_SECRET is required for BYOK key storage — set it before storing organization ElevenLabs keys.",
    );
  }
  return createHash("sha256").update(`sv-byok:${base}`).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", byokKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

export function decryptSecret(stored: string): string | null {
  try {
    const [ivB64, tagB64, dataB64] = stored.split(".");
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const decipher = createDecipheriv("aes-256-gcm", byokKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/** Masked display form — never show more than the last 4 characters. */
export function maskKey(key: string): string {
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}
