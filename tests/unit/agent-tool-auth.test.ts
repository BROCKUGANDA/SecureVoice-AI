/**
 * UNIT — `authorizeToolCall` (src/lib/agent-tool-auth.ts).
 *
 * This module gates the agent's high-stakes tools (`card_freeze` above all).
 * It had no test at all, so the properties below were unenforced:
 *
 *   · A wrong secret is 401 — never 403, never a 500. `safeEqual` hashes both
 *     sides first precisely so a wrong-LENGTH guess cannot reach `timingSafeEqual`
 *     and throw; that is the failure this suite pins.
 *   · The two 401 causes (unset secret, wrong secret) are indistinguishable, so
 *     a caller cannot enumerate which half failed.
 *   · An unset allow-list is a 403 refusal, not "trust everything". This is the
 *     fail-closed default a payment-adjacent path depends on.
 *   · Scope is per-tool: holding a valid secret for one tool does not confer
 *     another. A leaked-and-replayed call must not be rewritable.
 *   · Whitespace and empty entries in the allow-list are normalised, so
 *     "a, b," and " a ,b" scope identically.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

// `authorizeToolCall` became async when per-tenant credentials landed: a
// presented secret is now looked up in `AgentToolSecret` BEFORE the platform
// secret is compared. That lookup is stubbed here so this suite exercises the
// AUTHORISATION MATRIX — which is what it was written for — without depending
// on a table that is not migrated in every environment. Returning `null` is the
// "no tenant credential matches" case, so the function falls through to the
// platform-secret comparison these tests are about.
mock.module("@/lib/db", () => ({
  db: {
    agentToolSecret: {
      findUnique: async () => null,
      update: async () => ({}),
    },
  },
}));

import { authorizeToolCall } from "@/lib/agent-tool-auth";

const ENV_KEYS = ["AGENT_TOOL_SECRET", "AGENT_TOOL_ALLOWED"] as const;
const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

function withEnv(secret?: string, allowed?: string) {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  if (secret === undefined) delete process.env.AGENT_TOOL_SECRET;
  else process.env.AGENT_TOOL_SECRET = secret;
  if (allowed === undefined) delete process.env.AGENT_TOOL_ALLOWED;
  else process.env.AGENT_TOOL_ALLOWED = allowed;
}

describe("authorizeToolCall — secret comparison", () => {
  test("rejects when no secret is configured", async () => {
    withEnv(undefined, "card_freeze");
    const r = await authorizeToolCall("anything", "card_freeze");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(401);
      expect(r.error).toBe("unauthorized");
    }
  });

  test("rejects a missing header even when a secret is configured", async () => {
    withEnv("s3cret", "card_freeze");
    const r = await authorizeToolCall(null, "card_freeze");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  test("rejects an empty-string header as unauthorized, not a match", async () => {
    withEnv("s3cret", "card_freeze");
    const r = await authorizeToolCall("", "card_freeze");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  test("rejects a wrong secret", async () => {
    withEnv("s3cret", "card_freeze");
    const r = await authorizeToolCall("wrong", "card_freeze");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  // The reason safeEqual hashes before comparing: timingSafeEqual THROWS on a
  // length mismatch, which would surface as a 500 and leak the secret's length
  // through the stack trace. A 401 is the only acceptable outcome here.
  test("a wrong-length secret is a clean 401, never a throw", async () => {
    withEnv("short", "card_freeze");
    for (const guess of [
      "x",
      "a-much-longer-guess-than-the-real-secret",
      "",
      " ",
      "😀".repeat(64),
    ]) {
      const r = await authorizeToolCall(guess, "card_freeze");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(401);
    }
  });

  test("secret comparison is not prefix-matchable", async () => {
    withEnv("s3cret", "card_freeze");
    // A prefix and an extension of the real secret must both fail.
    for (const guess of ["s3cre", "s3cretX", " S3CRET", "s3cret "]) {
      expect((await authorizeToolCall(guess, "card_freeze")).ok).toBe(false);
    }
  });

  test("an unset secret and a wrong secret are indistinguishable", async () => {
    withEnv(undefined, "card_freeze");
    const unset = authorizeToolCall("guess", "card_freeze");
    withEnv("s3cret", "card_freeze");
    const wrong = authorizeToolCall("guess", "card_freeze");
    expect(unset).toEqual(wrong);
  });
});

describe("authorizeToolCall — tool scoping", () => {
  test("authorises a tool that is in scope and returns the parsed scope", async () => {
    withEnv("s3cret", "card_freeze,human_handoff");
    const r = await authorizeToolCall("s3cret", "card_freeze");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scope).toEqual(["card_freeze", "human_handoff"]);
  });

  test("refuses when the allow-list is unset rather than trusting everything", async () => {
    withEnv("s3cret", undefined);
    const r = await authorizeToolCall("s3cret", "card_freeze");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.error).toBe("tool_scope_unconfigured");
    }
  });

  test("refuses when the allow-list is empty or only separators", async () => {
    for (const allowed of ["", ",", " , , "]) {
      withEnv("s3cret", allowed);
      const r = await authorizeToolCall("s3cret", "card_freeze");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("tool_scope_unconfigured");
    }
  });

  test("a valid secret does not carry across tools", async () => {
    withEnv("s3cret", "human_handoff");
    const r = await authorizeToolCall("s3cret", "card_freeze");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.error).toBe("tool_not_in_scope");
    }
  });

  test("scope is matched exactly — no substring or case folding", async () => {
    withEnv("s3cret", "card_freeze");
    for (const tool of ["card", "card_freeze_v2", "CARD_FREEZE", "card_freeze ", " freeze"]) {
      expect((await authorizeToolCall("s3cret", tool)).ok).toBe(false);
    }
  });

  test("allow-list entries are trimmed and empty ones dropped", async () => {
    withEnv("s3cret", " card_freeze , human_handoff ,, ");
    const r = await authorizeToolCall("s3cret", "human_handoff");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scope).toEqual(["card_freeze", "human_handoff"]);
  });

  test("scope order is preserved so the caller sees its configured order", async () => {
    withEnv("s3cret", "human_handoff,card_freeze");
    const r = await authorizeToolCall("s3cret", "card_freeze");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scope).toEqual(["human_handoff", "card_freeze"]);
  });
});

describe("authorizeToolCall — ordering", () => {
  // The secret is checked BEFORE the allow-list. A caller with no valid secret
  // learns nothing about the configured scope, and the unset-allow-list 403
  // cannot be reached without proving the secret first.
  test("a bad secret reports 401 even when the tool is also out of scope", async () => {
    withEnv("s3cret", "human_handoff");
    const r = await authorizeToolCall("wrong", "card_freeze");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  test("a bad secret reports 401 even when the allow-list is unset", async () => {
    withEnv("s3cret", undefined);
    const r = await authorizeToolCall("wrong", "card_freeze");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });
});
