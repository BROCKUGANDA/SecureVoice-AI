import "server-only";

/**
 * How a document reaches the vectorizer.
 *
 * Two transports, one decision:
 *
 *  - **QStash configured** → publish a `doc.vectorize` envelope. That buys the
 *    retry ladder and the dead-letter table, which is what an embedded policy
 *    PDF deserves: a transient embedding outage should not leave the console
 *    showing a document stuck in EMBEDDING forever with nobody notified.
 *  - **QStash absent** → return false and let the caller run it inline after the
 *    response. `qstashConfigured()` deliberately requires BOTH a token and a
 *    signing key; half-configured is the worst state (see qstash.ts), so this
 *    never tries a half-wired publish.
 *
 * The return value is "was it handed to the queue", not "did it succeed" — the
 * outcome lives on the Document row either way, which is the only place a judge
 * or a retrying worker needs to look.
 */

import { after } from "next/server";
import { makeEnvelope } from "@/lib/queue/envelope";
import { qstashConfigured, publishEnvelope, dispatchPath } from "@/lib/queue/qstash";
import { logWarn } from "@/lib/validation/safe-log";

/**
 * Run work after the response is sent, without ever being the reason the
 * response fails.
 *
 * `after()` THROWS synchronously when there is no request scope — which is the
 * case in a unit test that calls the route handler directly, and would be the
 * case in any future non-request caller. An uncaught throw there would turn a
 * successful upload into a 500 with the document already written, which is the
 * worst possible outcome: the operator retries and uploads it twice.
 *
 * So the fallback is not an error path, it is a degraded-but-working one: the
 * work runs inline and is still awaited to completion, just without the response
 * having been flushed first.
 */
export function deferWork(work: () => Promise<unknown>): void {
  try {
    after(work);
  } catch {
    void Promise.resolve()
      .then(work)
      .catch((err: unknown) => {
        logWarn("[knowledge] deferred work failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
}

export async function scheduleVectorize(documentId: string, orgId: string): Promise<boolean> {
  if (!qstashConfigured()) return false;
  try {
    await publishEnvelope(
      makeEnvelope({
        jobKind: "doc.vectorize",
        idempotencyKey: `doc:${documentId}:vectorize`,
        caseRef: `DOC-${documentId.slice(0, 24)}`,
        orgId,
        payload: { documentId },
      }),
      dispatchPath(),
    );
    return true;
  } catch (err) {
    // A publish failure must not lose the document: the caller falls back to the
    // inline path, and the Document row stays PENDING for a manual Retry.
    logWarn("[knowledge] could not enqueue vectorization; falling back to inline", {
      documentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
