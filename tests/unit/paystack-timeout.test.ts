/**
 * UNIT — the Paystack adapter puts a clock on every call it makes.
 *
 * `REQUEST_TIMEOUT_MS` in src/lib/payments/paystack.ts has existed since the
 * adapter was written, reads `PAYSTACK_REQUEST_TIMEOUT_MS`, and defaults to 10s.
 * It was never attached to anything. The file also carries a retry ladder with
 * backoff, which made the gap look closed: retries bound HOW MANY times a call is
 * attempted, not how long one attempt may hang. A Paystack socket that accepts the
 * connection and then says nothing held the request handler open indefinitely —
 * on the path that decides whether a customer's top-up happened.
 *
 * So the control here is not "the timeout is the right number". It is that the
 * number is attached to the request at all, which is the part that was silently
 * missing and is the part that regresses silently.
 */
import { expect, test } from "bun:test";

import {
  paystackConfig,
  verifyTransactionServerSide,
  type HttpClient,
} from "@/lib/payments/paystack";

const SECRET = "sk_test_unit_timeout";

function responding(body: unknown): { http: HttpClient; inits: RequestInit[] } {
  const inits: RequestInit[] = [];
  const http: HttpClient = async (_url, init) => {
    inits.push(init);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { http, inits };
}

test("a server-side verify carries an AbortSignal on the outgoing request", async () => {
  const { http, inits } = responding({
    status: true,
    message: "Ok",
    data: { status: "success", amount: 250_000, currency: "AED" },
  });
  const cfg = paystackConfig({
    secretKey: SECRET,
    http,
    sleep: async () => {/* empty */},
    rand: () => 0.5,
  });

  const out = await verifyTransactionServerSide(cfg, "org_acme_topup_ABC");
  expect(out.ok).toBe(true);
  expect(inits).toHaveLength(1);

  // The whole point. `signal: undefined` is what this assertion replaced.
  expect(inits[0]!.signal).toBeInstanceOf(AbortSignal);
  expect(inits[0]!.method).toBe("GET");
});

test("the timeout is set on every attempt, not only the first", async () => {
  // The retry ladder is the reason one bounded attempt is not enough: attempt 2
  // and 3 are built fresh, so a signal attached outside the loop would leave the
  // retries unbounded. A 503 is the retryable status the ladder is written for.
  let n = 0;
  const inits: RequestInit[] = [];
  const http: HttpClient = async (_url, init) => {
    inits.push(init);
    n += 1;
    if (n < 3) {
      return new Response(JSON.stringify({ status: false, message: "busy" }), { status: 503 });
    }
    return new Response(
      JSON.stringify({
        status: true,
        message: "Ok",
        data: { status: "success", amount: 1000, currency: "AED" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const cfg = paystackConfig({
    secretKey: SECRET,
    http,
    sleep: async () => {},
    rand: () => 0.5,
  });

  const out = await verifyTransactionServerSide(cfg, "org_acme_topup_DEF");
  expect(out.ok).toBe(true);
  expect(inits.length).toBeGreaterThanOrEqual(3);
  for (const [i, init] of inits.entries()) {
    expect({ attempt: i + 1, signalled: init.signal instanceof AbortSignal }).toEqual({
      attempt: i + 1,
      signalled: true,
    });
  }
});

test("a stalled transport is reported as a failure, not left open", async () => {
  // The adapter's documented contract for a transport error is
  // `{ ok: false, error: "network_error: …" }`. AbortSignal.timeout fires that
  // path, so an unresponsive Paystack ends up in the branch the caller already
  // handles instead of a request that never returns.
  const http: HttpClient = async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const reason = () => reject(new Error(String(init.signal?.reason ?? "aborted")));
      if (init.signal?.aborted) reason();
      else init.signal?.addEventListener("abort", reason);
      // No timer: the only thing that can end this call is the signal.
    });
  const cfg = paystackConfig({
    secretKey: SECRET,
    http,
    sleep: async () => {},
    rand: () => 0.5,
  });

  // Never resolved on its own, so reaching the assertion at all is evidence the
  // timeout aborted it. The env var is set before the call so the ladder gives up
  // after one bounded attempt instead of retrying a doomed socket.
  process.env.PAYSTACK_REQUEST_TIMEOUT_MS = "25";
  try {
    const out = await verifyTransactionServerSide(cfg, "org_acme_topup_STALL");
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.error.startsWith("network_error:")).toBe(true);
  } finally {
    delete process.env.PAYSTACK_REQUEST_TIMEOUT_MS;
  }
});
