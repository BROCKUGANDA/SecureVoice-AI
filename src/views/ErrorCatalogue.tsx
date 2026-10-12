import {
  FAILURE_CODES,
  STATUS_DISCIPLINE,
  isRetryable,
  makeFailure,
} from "@/lib/failures/envelope";
import type { FailureCode } from "@/lib/failures/envelope";

/**
 * The published error catalogue.
 *
 * WHY THIS FILE EXISTS AT ALL: every failure envelope the API returns carries
 * `docsUrl: <base>/<code>` (`FAILURE_DOCS_BASE` in
 * `src/lib/failures/envelope.ts`, quoted by the OpenAPI contract), and until
 * `src/app/docs/errors/[code]/page.tsx` existed that link resolved to nothing.
 * A 429 whose body points a caller at documentation that 404s is worse than a
 * body with no link: the integrator concludes the contract is not maintained,
 * which is the one thing a machine-readable error vocabulary exists to prevent.
 *
 * WHY IT IS DERIVED RATHER THAN WRITTEN: the status, the retryability, the
 * `Retry-After` rule and the message are all read out of `STATUS_DISCIPLINE` and
 * `makeFailure()` — the same objects the runtime uses. A hand-copied table would
 * drift the first time a code's status moved, and the drift would be invisible
 * because the prose would still read fluently. The `what` and `action` sentences
 * below are the only hand-written part, and they describe a code's ROLE, not its
 * numbers, so a status change cannot make one of them false.
 */

const EXPLAIN: Record<FailureCode, { what: string; action: string }> = {
  malformed_request: {
    what: "The body did not parse, or failed schema validation before any handler ran. Nothing was read and nothing was written.",
    action:
      "Fix the request shape against the contract. Re-sending it unchanged gets the same answer.",
  },
  unauthenticated: {
    what: "No credential was presented, or the one presented did not verify. It says nothing about whether the resource exists.",
    action:
      "Re-authenticate, then retry. A session that expired mid-integration looks exactly like this.",
  },
  not_found: {
    what: "There is no such row for your organisation. A row that belongs to ANOTHER organisation is answered with this same code and the same body, deliberately: a distinct cross-tenant code would be an existence oracle.",
    action:
      "Check the identifier. Do not treat a repeated 404 as a probe result — it is designed not to tell you which case you are in.",
  },
  payment_required: {
    what: "The organisation's credit balance is exhausted. This is a billing state, not a compliance decision, and it is the one refusal a payment changes.",
    action:
      "Top up, then retry. Every other 409-class refusal survives a payment; this one does not.",
  },
  state_conflict: {
    what: "The resource exists but is not in a state that permits this operation.",
    action:
      "Read the resource's current state, then decide. Retrying without re-reading will fail again.",
  },
  policy_precondition: {
    what: "A compliance gate refused: consent, geography, do-not-call, or a cooldown window. It is a decision about the customer, made by policy, not a fault.",
    action:
      "Stop. Retrying cannot change it, and neither can paying. The refusal is the system working.",
  },
  unique_conflict: {
    what: "A uniqueness rule rejected the write — typically an identifier or an idempotency key already used.",
    action:
      "If you are retrying your own request, that is expected: the first attempt landed. Fetch the existing resource instead.",
  },
  reference_conflict: {
    what: "A referenced identifier in the request could not be resolved. The message names the field; the value stays with you.",
    action: "Correct the reference. Nothing was partially written.",
  },
  transaction_contended: {
    what: "This transaction lost a race against another one. The database is healthy; the write simply did not get the lock.",
    action: "Retry. This is the only 409 the platform marks retryable, and it means it.",
  },
  intervention_refused_degraded: {
    what: "An intervention was refused because the platform could not durably record it. An unrecorded freeze is an unenforceable one.",
    action:
      "Re-send when the recording path recovers. Do not treat the refusal as a policy decision about the customer.",
  },
  payload_too_large: {
    what: "The request body exceeds the limit for this endpoint.",
    action: "Send less per request. The limit is part of the contract, not a transient condition.",
  },
  semantically_invalid: {
    what: "The request was well-formed but does not mean anything in this context — the fields parse and the combination is not valid.",
    action:
      "Correct the content, not the syntax. Schema validation passed; the domain rule did not.",
  },
  rate_limited: {
    what: "Your request quota is spent for this window. The header says when; the body says whether a retry is worth it.",
    action:
      "Honour `Retry-After`, and read `X-RateLimit-Remaining` before releasing the next batch rather than discovering the wall per request.",
  },
  db_capacity_shed: {
    what: "The request was shed on purpose while the database is at capacity. Shedding is a load-shedding decision, not a crash.",
    action:
      "Retry after `Retry-After`. Repeat-shed is the platform telling you the window is still saturated.",
  },
  statement_timeout: {
    what: "The query exceeded the per-request time budget, so the request was shed rather than left hanging.",
    action: "Retry after `Retry-After`. If it is routine for your request shape, narrow it.",
  },
  dependency_unavailable: {
    what: "A named downstream dependency's circuit breaker is open, so the platform is not calling it right now.",
    action: "Retry after `Retry-After`. The breaker closes on its own; hammering it keeps it open.",
  },
  internal_bug: {
    what: "A failure this code path did not anticipate. It is deliberately the only code that means 'our fault', and it never carries a stack trace, SQL, or a model prompt.",
    action:
      "Correlate the `requestId` with us and stop retrying. Do not infer anything else from the status.",
  },
};

/** Codes ordered by the status they carry, so the table reads as the discipline does. */
function codesByStatus(): { status: number; codes: FailureCode[] }[] {
  const groups = new Map<number, FailureCode[]>();
  for (const code of FAILURE_CODES) {
    const status = STATUS_DISCIPLINE[code].status;
    const list = groups.get(status) ?? [];
    groups.set(status, list);
    list.push(code);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([status, codes]) => ({ status, codes }));
}

/** The literal five-field body a caller receives, rendered from the runtime's own builder. */
export function sampleBody(code: FailureCode): {
  code: string;
  message: string;
  retryable: boolean;
  requestId: string;
  docsUrl: string;
} {
  // `requestId` is random per call, so the sample substitutes an obviously
  // synthetic token rather than echoing a real one — the shape is the point.
  const { body } = makeFailure(code, { requestId: "svreq_example" });
  return body;
}

const shell = "mx-auto w-full max-w-3xl px-6 py-16 md:py-24";
const card = "rounded-3xl border border-line bg-white p-7";

export function ErrorCatalogue() {
  return (
    <section className={shell}>
      <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-primary">
        API reference
      </p>
      <h1 className="font-display mt-3 text-[34px] font-semibold tracking-tight text-ink md:text-[42px]">
        Error codes
      </h1>
      <p className="mt-4 text-[15px] leading-relaxed text-ink-2">
        Every failure this API returns is one of these codes, in the same five fields, and nothing
        else. Nothing is in the body that a caller cannot act on: no stack trace, no SQL, no model
        prompt, no internal identifier. <code className="font-mono text-[13.5px]">requestId</code>{" "}
        is an opaque correlation token and the only identifier it carries.
      </p>
      <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
        The table is generated from{" "}
        <code className="font-mono text-[13.5px]">STATUS_DISCIPLINE</code>, the same map the runtime
        builds responses from, so a status that moves here moves in the API. There is no{" "}
        <code className="font-mono text-[13.5px]">403</code> in this vocabulary by design: a refusal
        that means &quot;you may not&quot; tells an attacker the resource exists, so the platform
        answers 404 for existence questions and 409 for policy ones.
      </p>

      <div className="mt-10 space-y-4">
        {codesByStatus().map(({ status, codes }) => (
          <div key={status} className={card}>
            <h2 className="font-display text-[15px] font-semibold tracking-tight text-ink">
              {status}
            </h2>
            <ul className="mt-3 space-y-3">
              {codes.map((code) => {
                const rule = STATUS_DISCIPLINE[code];
                return (
                  <li key={code} className="border-t border-line pt-3 first:border-0 first:pt-0">
                    <a
                      href={`/docs/errors/${code}`}
                      className="font-mono text-[13px] text-primary underline underline-offset-2"
                    >
                      {code}
                    </a>
                    <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
                      {EXPLAIN[code].what}
                    </p>
                    <p className="mt-1.5 font-mono text-[11.5px] leading-relaxed text-ink-2">
                      retryable: {String(rule.retryable)}
                      {rule.retryAfter ? " · Retry-After: always" : ""}
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <p className="mt-10 text-[13.5px] leading-relaxed text-ink-2">
        Machine-readable versions:{" "}
        <a href="/openapi" className="underline">
          /openapi
        </a>{" "}
        carries the same codes in its error schema, and{" "}
        <a href="/docs" className="underline">
          /docs
        </a>{" "}
        documents the endpoints that return them.
      </p>
    </section>
  );
}

export function ErrorCodePage({ code }: { code: FailureCode }) {
  const rule = STATUS_DISCIPLINE[code];
  const body = sampleBody(code);
  return (
    <section className={shell}>
      <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-primary">
        {String(rule.status)} · {rule.disposition}
      </p>
      <h1 className="font-mono mt-3 text-[26px] font-semibold tracking-tight text-ink md:text-[32px]">
        {code}
      </h1>
      <p className="mt-4 text-[15px] leading-relaxed text-ink-2">{EXPLAIN[code].what}</p>
      <p className="mt-3 text-[15px] leading-relaxed text-ink-2">{EXPLAIN[code].action}</p>

      <div className={`${card} mt-8`}>
        <h2 className="font-display text-[15px] font-semibold tracking-tight text-ink">
          What the caller receives
        </h2>
        <pre className="mt-3 overflow-x-auto rounded-xl border border-line bg-paper p-4 font-mono text-[11.5px] leading-relaxed text-ink-2">
          {JSON.stringify(body, null, 2)}
        </pre>
        <ul className="mt-4 space-y-1.5 font-mono text-[11.5px] leading-relaxed text-ink-2">
          <li>HTTP status: {rule.status}</li>
          <li>retryable: {String(isRetryable(code))}</li>
          <li>
            Retry-After:{" "}
            {rule.retryAfter
              ? "always sent; the value is the server's, not yours to guess"
              : "not sent, because waiting does not change the outcome"}
          </li>
          <li>
            documentation URL: <code>{body.docsUrl}</code> — this page
          </li>
        </ul>
      </div>

      <p className="mt-8 text-[13.5px] leading-relaxed text-ink-2">
        <a href="/docs/errors" className="underline">
          All error codes
        </a>
      </p>
    </section>
  );
}

/** True for a code the platform actually emits. Case-sensitive: the codes are snake_case literals. */
export function isErrorCode(value: string): value is FailureCode {
  return (FAILURE_CODES as readonly string[]).includes(value);
}
