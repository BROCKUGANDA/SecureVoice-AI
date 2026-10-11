import "server-only";

const BETTERSTACK_API_KEY = process.env.BETTERSTACK_API_KEY ?? "";
const BETTERSTACK_SOURCE_TOKEN = process.env.BETTERSTACK_SOURCE_TOKEN ?? "";
const BETTERSTACK_OTEL_HOST =
  process.env.BETTERSTACK_OTEL_HOST ?? "s2791980.us-west-2a.betterstackdata.com";

/**
 * Returns the BetterStack Logtail browser script as an HTML string.
 *
 * Logtail (now Better Stack) ingests structured logs from the browser.
 * The script is self-initialising — just inject it into the <head> and
 * `window.logger` becomes available for use.
 *
 * Usage in a Next.js layout:
 *   <head dangerouslySetInnerHTML={{ __html: getBetterStackScript() }} />
 *
 * Returns an empty string when no API key is configured, so callers can
 * inject unconditionally.
 */
export function getBetterStackScript(): string {
  if (!BETTERSTACK_API_KEY) return "";

  // The browser bundle is served from the Better Stack CDN.
  // The token is the source token, not the API key — the script
  // authenticates against the log source it is scoped to.
  return `<script src="https://betterstack.com/integrations/logtail-browser.js" data-token="${BETTERSTACK_SOURCE_TOKEN}" async></script>`;
}

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context?: Record<string, unknown>;
}

const INGESTION_URL = "https://hJMhYJw7iu9Fe93XKnj6Bboi@s2791972.us-west-2a.betterstackdata.com/2791978";

/**
 * Ship a structured log entry to Better Stack.
 *
 * Uses the Logtail HTTP ingestion endpoint. The API key is sent as a
 * Bearer token in the Authorization header.
 *
 * Fire-and-forget by default — returns a promise that resolves when the
 * request completes, but callers typically await it only in critical paths
 * where log delivery must be confirmed.
 */
export async function shipLog(entry: LogEntry): Promise<void> {
  if (!BETTERSTACK_API_KEY) return;

  const body = {
    dt: new Date().toISOString(),
    level: entry.level,
    message: entry.message,
    ...entry.context,
  };

  try {
    await fetch(INGESTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BETTERSTACK_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Log shipping must never crash the app. Silently drop on failure.
  }
}

/**
 * Ship multiple log entries in a single batch request.
 */
export async function shipLogs(entries: LogEntry[]): Promise<void> {
  if (!BETTERSTACK_API_KEY || entries.length === 0) return;

  const body = entries.map((entry) => ({
    dt: new Date().toISOString(),
    level: entry.level,
    message: entry.message,
    ...entry.context,
  }));

  try {
    await fetch(INGESTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BETTERSTACK_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Log shipping must never crash the app. Silently drop on failure.
  }
}

export { BETTERSTACK_API_KEY, BETTERSTACK_SOURCE_TOKEN, BETTERSTACK_OTEL_HOST };
