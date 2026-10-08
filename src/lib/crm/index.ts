import "server-only";
/**
 * CRM handoff: when a case needs a human, open a ticket in the institution's
 * own CRM.
 *
 * Contract with the caller (the case pipeline):
 *   - `createHandoffTicket` NEVER throws. A CRM outage must not break, delay or
 *     fail the fraud workflow it is reporting on. Every failure is captured in
 *     the returned array and in the connection's `lastStatus` / `lastError`.
 *   - It short-circuits to `[]` when the org has no connection (or no orgId),
 *     before touching any adapter.
 *   - Latency is bounded: each attempt has a hard deadline (`timeoutMs`,
 *     default 3 s), a retryable failure is retried ONCE after 500 ms, and
 *     providers run in parallel. Worst case is therefore ~ 2 x timeout + 500 ms.
 *   - Non-retryable failures (4xx, blocked URL, bad config) are not retried.
 *
 * The ticket carries references only - never a phone number, merchant, amount,
 * card digits or transcript (see types.ts / text.ts).
 */

import { randomBytes } from "node:crypto";

import { env } from "@/lib/config";
import { leakSafeText } from "@/lib/failures/envelope";
import { sendSalesforceCase } from "./salesforce";
import { TEST_CASE_REF_PREFIX } from "./text";
import {
  type Adapter,
  type AdapterDeps,
  type AdapterResult,
  type CrmConfig,
  type CrmProvider,
  type HandoffTicket,
  isCrmProvider,
} from "./types";
import { sendWebhook } from "./webhook";
import { sendZendeskTicket } from "./zendesk";
import { logWarn } from "@/lib/validation/safe-log";

export { buildTicketText } from "./text";
export * from "./types";

export type LoadedConnection = { provider: CrmProvider; config: CrmConfig };

export type HandoffDeps = AdapterDeps & {
  /** Enabled, decrypted connections for an org. Default: the Prisma store. */
  loadConnections?: (orgId: string) => Promise<readonly LoadedConnection[]>;
  /** Persist the outcome. Default: the Prisma store. Failures are swallowed. */
  recordResult?: (orgId: string, provider: CrmProvider, result: AdapterResult) => Promise<void>;
  /** Replace individual adapters (tests). */
  adapters?: Partial<Record<CrmProvider, Adapter<never>>>;
  /** Delay before the single retry. Default 500 ms. */
  retryDelayMs?: number;
  /** Injectable sleep so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
};

export const RETRY_DELAY_MS = env.crmRetryDelayMs;

const DEFAULT_ADAPTERS: Record<CrmProvider, Adapter<never>> = {
  zendesk: sendZendeskTicket as Adapter<never>,
  salesforce: sendSalesforceCase as Adapter<never>,
  webhook: sendWebhook as Adapter<never>,
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function logger(deps: HandoffDeps): (message: string) => void {
  return (message) => {
    try {
      (deps.log ?? ((m: string) => logWarn("[crm] warning", { message: m })))(
        leakSafeText(message, 200),
      );
    } catch {
      /* logging must never throw */
    }
  };
}

/** One adapter call under a hard deadline; an adapter that throws becomes a result. */
async function attempt(
  adapter: Adapter<never>,
  config: CrmConfig,
  ticket: HandoffTicket,
  deps: HandoffDeps,
): Promise<AdapterResult> {
  const timeoutMs = deps.timeoutMs && deps.timeoutMs > 0 ? deps.timeoutMs : 3000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<AdapterResult>((resolve) => {
    // Backstop for a fetch that ignores its abort signal.
    timer = setTimeout(
      () => resolve({ ok: false, error: "timeout", retryable: true }),
      timeoutMs + 1000,
    );
  });
  try {
    const run = (async () => adapter(config as never, ticket, deps))().catch((): AdapterResult => ({
      ok: false,
      error: "adapter_exception",
      retryable: false,
    }));
    return await Promise.race([run, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function deliverOne(
  provider: CrmProvider,
  config: CrmConfig,
  ticket: HandoffTicket,
  deps: HandoffDeps,
): Promise<AdapterResult> {
  const adapter = deps.adapters?.[provider] ?? DEFAULT_ADAPTERS[provider];
  let result = await attempt(adapter, config, ticket, deps);
  if (!result.ok && result.retryable) {
    await (deps.sleep ?? defaultSleep)(deps.retryDelayMs ?? RETRY_DELAY_MS).catch(() => {});
    result = await attempt(adapter, config, ticket, deps);
  }
  return result;
}

async function defaultLoad(orgId: string): Promise<readonly LoadedConnection[]> {
  // Dynamic import: the Prisma client is only loaded when a real lookup runs.
  const { loadDecrypted } = await import("./store");
  return loadDecrypted(orgId);
}

async function defaultRecord(
  orgId: string,
  provider: CrmProvider,
  result: AdapterResult,
): Promise<void> {
  const { recordResult } = await import("./store");
  await recordResult(orgId, provider, result);
}

/**
 * Open a ticket in every CRM the ticket's organization has enabled.
 * Never throws. Returns one entry per attempted provider (`[]` = nothing to do).
 */
export async function createHandoffTicket(
  ticket: HandoffTicket,
  deps: HandoffDeps = {},
): Promise<{ provider: CrmProvider; result: AdapterResult }[]> {
  const log = logger(deps);
  try {
    if (!ticket || typeof ticket.orgId !== "string" || ticket.orgId.length === 0) return [];
    const orgId = ticket.orgId;

    let connections: readonly LoadedConnection[];
    try {
      connections = await (deps.loadConnections ?? defaultLoad)(orgId);
    } catch (err) {
      log(`could not load CRM connections: ${err instanceof Error ? err.name : "error"}`);
      return [];
    }
    if (!Array.isArray(connections) || connections.length === 0) return [];

    const record = deps.recordResult ?? defaultRecord;
    const settled = await Promise.all(
      connections
        .filter((c) => c && isCrmProvider(c.provider))
        .map(async (c) => {
          let result: AdapterResult;
          try {
            result = await deliverOne(c.provider, c.config, ticket, deps);
          } catch {
            result = { ok: false, error: "adapter_exception", retryable: false };
          }
          try {
            await record(orgId, c.provider, result);
          } catch {
            log(`could not record ${c.provider} result`);
          }
          if (!result.ok) log(`${c.provider} handoff failed: ${result.error}`);
          return { provider: c.provider, result };
        }),
    );
    return settled;
  } catch (err) {
    log(`handoff aborted: ${err instanceof Error ? err.name : "error"}`);
    return [];
  }
}

export type TestConnectionDeps = HandoffDeps & {
  /** One decrypted connection (enabled or not). Default: the Prisma store. */
  loadConnection?: (orgId: string, provider: CrmProvider) => Promise<LoadedConnection | null>;
  institutionType?: HandoffTicket["institutionType"];
};

/**
 * Send a clearly-labelled TEST ticket to one configured connection ("Send test"
 * in the console) and record the outcome. Never throws.
 */
export async function testConnection(
  orgId: string,
  provider: CrmProvider,
  deps: TestConnectionDeps = {},
): Promise<AdapterResult> {
  try {
    if (!orgId || !isCrmProvider(provider)) {
      return { ok: false, error: "not_configured", retryable: false };
    }
    let conn: LoadedConnection | null;
    try {
      conn = deps.loadConnection
        ? await deps.loadConnection(orgId, provider)
        : await (async () => {
            const { loadDecryptedOne } = await import("./store");
            return loadDecryptedOne(orgId, provider);
          })();
    } catch {
      return { ok: false, error: "load_failed", retryable: true };
    }
    if (!conn) return { ok: false, error: "not_configured", retryable: false };

    const suffix = randomBytes(4).toString("hex").toUpperCase();
    const ticket: HandoffTicket = {
      caseRef: `${TEST_CASE_REF_PREFIX}${suffix}`,
      orgId,
      institutionType: deps.institutionType ?? "bank",
      signalKind: null,
      reason: "human_review",
      priority: "normal",
      language: "en",
      transactionRef: null,
      resolutionMethod: null,
      customerResponse: null,
      auditRef: `${TEST_CASE_REF_PREFIX}AUDIT`,
      consoleUrl: null,
    };
    const result = await deliverOne(conn.provider, conn.config, ticket, deps);
    try {
      await (deps.recordResult ?? defaultRecord)(orgId, provider, result);
    } catch {
      /* recording is best-effort */
    }
    return result;
  } catch {
    return { ok: false, error: "adapter_exception", retryable: false };
  }
}
