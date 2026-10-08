import "server-only";
/**
 * CrmConnection persistence. The whole config JSON is encrypted at rest with
 * AES-256-GCM (src/lib/byok.ts); the plaintext only ever exists in memory for
 * the duration of one adapter call. `listConnections` returns a MASKED summary
 * and never a decrypted secret - the only path that yields usable credentials is
 * `loadDecrypted` / `loadDecryptedOne`, which are for in-process adapter use.
 *
 * Rotating AUTH_SECRET makes stored configs undecryptable (same as BYOK keys):
 * such a row is reported as `unreadable` and skipped by the handoff, and the
 * operator re-enters the credentials.
 */

import { decryptSecret, encryptSecret } from "@/lib/byok";
import { db } from "@/lib/db";
import { leakSafeText } from "@/lib/failures/envelope";
import type { DnsResolver } from "@/lib/validation/ssrf";
import { maskConfig, normalizeConfig, validateConfig } from "./config";
import type { AdapterResult, CrmConfig, CrmConfigMap, CrmProvider } from "./types";
import { isCrmProvider } from "./types";

export type CrmConnectionSummary = {
  provider: CrmProvider;
  enabled: boolean;
  lastStatus: "ok" | "error" | null;
  lastSyncAt: Date | null;
  lastError: string | null;
  /** Non-secret identifiers plus masked secrets. Never a usable credential. */
  masked: Record<string, string>;
  /** True when the stored config can no longer be decrypted (AUTH_SECRET rotated). */
  unreadable: boolean;
};

export type DecryptedConnection = {
  provider: CrmProvider;
  enabled: boolean;
  config: CrmConfig;
};

type Row = {
  provider: string;
  configEnc: string;
  enabled: boolean;
  lastStatus: string | null;
  lastError: string | null;
  lastSyncAt: Date | null;
};

function decryptConfig(row: Pick<Row, "provider" | "configEnc">): CrmConfig | null {
  if (!isCrmProvider(row.provider)) return null;
  const plain = decryptSecret(row.configEnc);
  if (plain === null) return null;
  try {
    const shaped = normalizeConfig(row.provider, JSON.parse(plain));
    return shaped.ok ? shaped.config : null;
  } catch {
    return null;
  }
}

function summarize(row: Row): CrmConnectionSummary | null {
  if (!isCrmProvider(row.provider)) return null;
  const config = decryptConfig(row);
  return {
    provider: row.provider,
    enabled: row.enabled,
    lastStatus: row.lastStatus === "ok" || row.lastStatus === "error" ? row.lastStatus : null,
    lastSyncAt: row.lastSyncAt,
    lastError: row.lastError,
    masked: config ? maskConfig(row.provider, config) : {},
    unreadable: config === null,
  };
}

const SELECT = {
  provider: true,
  configEnc: true,
  enabled: true,
  lastStatus: true,
  lastError: true,
  lastSyncAt: true,
} as const;

/**
 * Validate, encrypt and upsert one connection (one per org + provider). Saving
 * re-enables the connection and clears the last-sync status, because the
 * previous result described credentials that no longer exist.
 *
 * Returns `{ ok: false, error }` for bad input (the error names the problem but
 * never echoes a submitted value). Database errors propagate.
 */
export async function saveConnection<P extends CrmProvider>(
  orgId: string,
  provider: P,
  config: unknown,
  opts: { resolver?: DnsResolver } = {},
): Promise<{ ok: true; connection: CrmConnectionSummary } | { ok: false; error: string }> {
  if (!orgId) return { ok: false, error: "orgId is required" };
  if (!isCrmProvider(provider)) return { ok: false, error: "unknown provider" };
  const checked = await validateConfig(provider, config, opts);
  if (!checked.ok) return checked;

  let configEnc: string;
  try {
    configEnc = encryptSecret(JSON.stringify(checked.config as CrmConfigMap[P]));
  } catch {
    return { ok: false, error: "encryption is not available (AUTH_SECRET is not set)" };
  }

  const row = await db.crmConnection.upsert({
    where: { orgId_provider: { orgId, provider } },
    create: { orgId, provider, configEnc, enabled: true },
    update: { configEnc, enabled: true, lastStatus: null, lastError: null, lastSyncAt: null },
    select: SELECT,
  });
  const connection = summarize(row);
  return connection ? { ok: true, connection } : { ok: false, error: "unknown provider" };
}

/** Masked view of every connection an org has. Never returns a secret. */
export async function listConnections(orgId: string): Promise<CrmConnectionSummary[]> {
  if (!orgId) return [];
  const rows = await db.crmConnection.findMany({
    where: { orgId },
    orderBy: { provider: "asc" },
    select: SELECT,
  });
  return rows.flatMap((r) => {
    const s = summarize(r);
    return s ? [s] : [];
  });
}

export async function deleteConnection(orgId: string, provider: CrmProvider): Promise<boolean> {
  if (!orgId || !isCrmProvider(provider)) return false;
  const { count } = await db.crmConnection.deleteMany({ where: { orgId, provider } });
  return count > 0;
}

export async function setEnabled(
  orgId: string,
  provider: CrmProvider,
  enabled: boolean,
): Promise<boolean> {
  if (!orgId || !isCrmProvider(provider)) return false;
  const { count } = await db.crmConnection.updateMany({
    where: { orgId, provider },
    data: { enabled },
  });
  return count > 0;
}

/**
 * INTERNAL. Decrypted configs for the handoff pipeline. Unreadable rows are
 * skipped. By default only enabled connections are returned.
 */
export async function loadDecrypted(
  orgId: string,
  opts: { enabledOnly?: boolean } = {},
): Promise<DecryptedConnection[]> {
  if (!orgId) return [];
  const rows = await db.crmConnection.findMany({
    where: { orgId, ...(opts.enabledOnly === false ? {} : { enabled: true }) },
    select: SELECT,
  });
  return rows.flatMap((r) => {
    if (!isCrmProvider(r.provider)) return [];
    const config = decryptConfig(r);
    return config ? [{ provider: r.provider, enabled: r.enabled, config }] : [];
  });
}

/** INTERNAL. One decrypted connection, enabled or not (used by "send test"). */
export async function loadDecryptedOne(
  orgId: string,
  provider: CrmProvider,
): Promise<DecryptedConnection | null> {
  if (!orgId || !isCrmProvider(provider)) return null;
  const row = await db.crmConnection.findUnique({
    where: { orgId_provider: { orgId, provider } },
    select: SELECT,
  });
  if (!row) return null;
  const config = decryptConfig(row);
  return config ? { provider, enabled: row.enabled, config } : null;
}

/** Record the outcome of the most recent delivery attempt. */
export async function recordResult(
  orgId: string,
  provider: CrmProvider,
  result: AdapterResult,
  now: Date = new Date(),
): Promise<void> {
  await db.crmConnection.updateMany({
    where: { orgId, provider },
    data: result.ok
      ? { lastStatus: "ok", lastError: null, lastSyncAt: now }
      : { lastStatus: "error", lastError: leakSafeText(result.error, 160), lastSyncAt: now },
  });
}
