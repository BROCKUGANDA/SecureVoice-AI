import { afterEach, describe, expect, it, mock } from "bun:test";

/**
 * A live claim belongs to the request that inserted it. The regression this
 * pins: the wrapper deleted the row whenever `response === ""`, without asking
 * whether the 30s claim had expired, so a second request could remove a healthy
 * in-flight claim and call the billable upstream concurrently with its owner.
 */
const row = {
  id: "idem-1",
  scope: "tts",
  key: "unused",
  callerId: "caller-1",
  response: "",
  statusCode: 0,
  expiresAt: new Date(Date.now() + 30_000),
  createdAt: new Date(),
};

let deleted = 0;
let inserted = 0;

mock.module("@/lib/db", () => ({
  db: {
    idempotencyKey: {
      findUnique: async () => ({ ...row }),
      delete: async () => {
        deleted += 1;
      },
      create: async () => {
        inserted += 1;
        throw Object.assign(new Error("unique"), { code: "P2002" });
      },
      update: async () => ({ ...row }),
    },
  },
}));

describe("withIdempotency live claim", () => {
  afterEach(() => {
    deleted = 0;
    inserted = 0;
  });

  it("waits for the owner instead of deleting an unexpired claim", async () => {
    process.env.IDEMPOTENCY_POLL_MS = "1";
    process.env.IDEMPOTENCY_MAX_POLL_MS = "100";
    const { withIdempotency } = await import("@/lib/idempotency");

    // Simulate the owner finishing while the loser polls.
    setTimeout(() => {
      row.response = JSON.stringify({ audio: "done" });
    }, 5);

    let executed = 0;
    const result = await withIdempotency({
      scope: "tts",
      key: "same-request",
      callerId: "caller-1",
      fn: async () => {
        executed += 1;
        return { audio: "duplicate" };
      },
    });

    expect(executed).toBe(0);
    expect(result.replayed).toBe(true);
    expect(result.value).toEqual({ audio: "done" });
    expect(deleted).toBe(0);
    expect(inserted).toBe(1);
  });
});
