/**
 * Client-side error reporting — the half that keeps a friendly UI from making the
 * platform blind.
 *
 * Every surface that shows a person a kind, generic sentence has to put the raw
 * error somewhere, or the deployment has no idea it is failing. Before this module
 * existed, a sign-in refused for a configuration reason produced a polite message
 * in the browser and nothing anywhere else; the operator found out from a
 * screenshot.
 *
 * Two sinks, both safe to be absent:
 *
 *   · `console.warn` — always, and the only one guaranteed to be there. Wrapped,
 *     because a console that throws would otherwise turn a handled failure into an
 *     unhandled one inside its own error path.
 *   · Sentry — when a DSN is configured. `@sentry/nextjs` is imported lazily so
 *     this module stays importable from Node-side tests without booting a browser
 *     SDK, and a capture failure is swallowed for the same reason as above.
 *
 * ## What must never be passed in
 *
 * The submitted value. Callers pass an error object and a scope string; nothing
 * here reads form fields, request bodies, or headers, because this runs in a
 * browser that a bank's customer is typing into.
 */

/**
 * Report one client-side failure.
 *
 * @param scope a short stable label — "sign-in", "pilot-request", "route-error" —
 *   which is what a triage search is filtered by.
 */
export function reportClientError(
  scope: string,
  err: unknown,
  tags?: Record<string, string>,
): void {
  const detail = describe(err);
  try {
    console.warn(`[client:${scope}]`, { ...tags, detail });
  } catch {
    // A stripped console is not a reason to lose the Sentry half.
  }
  void import("@sentry/nextjs")
    .then((m) => {
      m.captureException(err instanceof Error ? err : new Error(detail || `${scope}_failed`), {
        tags: { surface: scope, ...tags },
      });
    })
    .catch(() => {
      // Sentry is optional by design (no DSN => no transport in the bundle).
    });
}

function describe(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (typeof err !== "object") return String(err);
  const e = err as Record<string, unknown>;
  if (typeof e.message === "string") return e.message;
  const inner = e.error;
  if (
    inner &&
    typeof inner === "object" &&
    typeof (inner as { message?: unknown }).message === "string"
  ) {
    return (inner as { message: string }).message;
  }
  return "";
}
